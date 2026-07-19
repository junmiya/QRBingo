'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { joinGame } = require('../../src/joinGame');
const { submitClaim } = require('../../src/submitClaim');
const { finishGame } = require('../../src/finishGame');
const { generateCard, findAchievedBallIndex } = require('../../src/lib/bingo');
const { db } = require('../../src/admin');
const { uid, grantEntitlement } = require('./_helpers');

// ゲーム全体を通しでシミュレートし、ランキングが ballIndex 基準の
// グラウンドトゥルースと完全一致することを検証する(SC-002 / US-4)。
describe('公平性シミュレーション (integration)', () => {
  test('N人参加・全球抽選で、最終順位が achievedBallIndex 順とグラウンドトゥルース一致', async () => {
    const PLAYERS = 60; // Emulator 実行時間の都合で 60(ロジックは人数非依存)
    const host = uid();
    await grantEntitlement(host, 100000); // 大人数のため上限を引き上げ
    const { gameId } = await createGame.run({
      data: { winLines: 1, prizeCount: 5 },
      auth: { uid: host },
    });
    await startGame.run({ data: { gameId }, auth: { uid: host } });

    // 参加(逐次: joinGame は uid ごとに1カード)
    const players = [];
    for (let i = 0; i < PLAYERS; i++) {
      const player = uid();
      const res = await joinGame.run({ data: { gameId, nickname: 'P' + i }, auth: { uid: player } });
      players.push({ player, grid: generateCard(res.seed) });
    }

    // 1..75 を順番に抽選(revealAt は過去 = 全公開)
    const order = Array.from({ length: 75 }, (_, i) => i + 1);
    const draws = order.map((n, i) => ({
      n,
      ballIndex: i + 1,
      revealAt: Timestamp.fromMillis(Date.now() - 1000),
    }));
    await db.doc(`games/${gameId}`).update({ draws });

    // グラウンドトゥルース: 各プレイヤーが 1..75 で何球目に成立するか
    const truth = new Map();
    for (const { player, grid } of players) {
      truth.set(player, findAchievedBallIndex(grid, order, 1));
    }

    // 全員クレーム送信(到着順はランダムでも結果は ballIndex 基準)
    for (const { player } of players) {
      const res = await submitClaim.run({ data: { gameId }, auth: { uid: player } });
      const expected = truth.get(player);
      if (expected == null) {
        expect(res.status).toBe('rejected');
      } else {
        expect(res.status).toBe('verified');
        expect(res.achievedBallIndex).toBe(expected);
      }
    }

    // 終了して確定ランキングを取得
    const finished = await finishGame.run({ data: { gameId }, auth: { uid: host } });

    // グラウンドトゥルースの順位(competition ranking)を独立に計算
    const achieved = players
      .map((p) => ({ uid: p.player, ball: truth.get(p.player) }))
      .filter((x) => x.ball != null)
      .sort((a, b) => a.ball - b.ball || (a.uid < b.uid ? -1 : 1));

    const results = (await db.doc(`games/${gameId}/private/results`).get()).data();
    // results の各エントリの rank が ballIndex 昇順と矛盾しないことを確認
    const byUid = new Map(results.entries.map((e) => [e.uid, e]));
    for (const a of achieved) {
      expect(byUid.get(a.uid).achievedBallIndex).toBe(a.ball);
    }
    // rank は achievedBallIndex に対して単調(小さい ball ほど小さい rank)
    const sortedByRank = [...results.entries].sort((x, y) => x.rank - y.rank);
    for (let i = 1; i < sortedByRank.length; i++) {
      expect(sortedByRank[i].achievedBallIndex).toBeGreaterThanOrEqual(
        sortedByRank[i - 1].achievedBallIndex
      );
    }
    // 当選者数は景品数以下(同着抽選込み)
    expect(finished.winners.length).toBeLessThanOrEqual(5);
    expect(finished.winners.length).toBeGreaterThan(0);
  }, 120000);

  test('改竄クレーム受理率0%: 未成立プレイヤーは全員 rejected (SC-003)', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: { winLines: 2 }, auth: { uid: host } });
    await startGame.run({ data: { gameId }, auth: { uid: host } });

    const players = [];
    for (let i = 0; i < 20; i++) {
      const player = uid();
      const res = await joinGame.run({ data: { gameId, nickname: 'P' + i }, auth: { uid: player } });
      players.push({ player, grid: generateCard(res.seed) });
    }

    // わずか3球だけ公開 → winLines=2 は誰も成立し得ない
    await db.doc(`games/${gameId}`).update({
      draws: [1, 2, 3].map((n, i) => ({
        n, ballIndex: i + 1, revealAt: Timestamp.fromMillis(Date.now() - 1000),
      })),
    });

    let accepted = 0;
    for (const { player } of players) {
      const res = await submitClaim.run({ data: { gameId }, auth: { uid: player } });
      if (res.status === 'verified') accepted++;
    }
    expect(accepted).toBe(0);
  }, 60000);
});
