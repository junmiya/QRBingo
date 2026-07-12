'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { joinGame } = require('../../src/joinGame');
const { submitClaim } = require('../../src/submitClaim');
const { generateCard, findAchievedBallIndex } = require('../../src/lib/bingo');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

// 抽選列を直接ゲームドキュメントに書き込む(revealAt は過去=全て公開済み)。
async function setDraws(gameId, numbers) {
  const draws = numbers.map((n, i) => ({
    n,
    ballIndex: i + 1,
    revealAt: Timestamp.fromMillis(Date.now() - 1000),
  }));
  await db.doc(`games/${gameId}`).update({ draws });
}

async function makeStartedGame(overrides = {}) {
  const host = uid();
  const { gameId } = await createGame.run({ data: overrides, auth: { uid: host } });
  await startGame.run({ data: { gameId }, auth: { uid: host } });
  return { gameId, host };
}

async function joinPlayer(gameId, nickname) {
  const player = uid();
  const res = await joinGame.run({ data: { gameId, nickname }, auth: { uid: player } });
  return { player, seed: res.seed, grid: generateCard(res.seed) };
}

describe('submitClaim (integration)', () => {
  test('未成立クレームは rejected(改竄防止: サーバーがシードから再計算)', async () => {
    const { gameId } = await makeStartedGame({ winLines: 1 });
    const { player, grid } = await joinPlayer(gameId, 'A');
    // カードに存在しない/1マスだけの抽選 → どのラインも揃わない
    await setDraws(gameId, [grid[0][0]]);
    const res = await submitClaim.run({ data: { gameId }, auth: { uid: player } });
    expect(res).toEqual({ status: 'rejected', reason: 'lines_not_met' });
  });

  test('ライン成立で verified、achievedBallIndex が共有ロジックと一致', async () => {
    const { gameId } = await makeStartedGame({ winLines: 1 });
    const { player, grid } = await joinPlayer(gameId, 'A');
    // B列(grid[0])の5マスを最初に引く → 5球目で成立するはず
    const numbers = [...grid[0]];
    await setDraws(gameId, numbers);

    const res = await submitClaim.run({ data: { gameId }, auth: { uid: player } });
    const expected = findAchievedBallIndex(grid, numbers, 1);
    expect(res.status).toBe('verified');
    expect(res.achievedBallIndex).toBe(expected);
    expect(res.lines).toBeGreaterThanOrEqual(1);
    expect(res.provisionalRank).toBe(1);

    const claim = (await db.doc(`claims/${gameId}_${player}`).get()).data();
    expect(claim.status).toBe('verified');
    expect(claim.achievedBallIndex).toBe(expected);
  });

  test('冪等: 2回呼んでも achievedBallIndex は不変', async () => {
    const { gameId } = await makeStartedGame({ winLines: 1 });
    const { player, grid } = await joinPlayer(gameId, 'A');
    await setDraws(gameId, [...grid[0]]);
    const first = await submitClaim.run({ data: { gameId }, auth: { uid: player } });
    // さらに抽選を追加してから再クレームしても、最初の成立点は変わらない
    await setDraws(gameId, [...grid[0], ...grid[1]]);
    const second = await submitClaim.run({ data: { gameId }, auth: { uid: player } });
    expect(second.status).toBe('verified');
    expect(second.achievedBallIndex).toBe(first.achievedBallIndex);
  });

  test('lobby 中のクレームは failed-precondition', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    const { player } = await joinPlayer(gameId, 'A');
    await expect(
      submitClaim.run({ data: { gameId }, auth: { uid: player } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('未参加ユーザーのクレームは not-found', async () => {
    const { gameId } = await makeStartedGame();
    await setDraws(gameId, [1, 2, 3, 4, 5]);
    await expect(
      submitClaim.run({ data: { gameId }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  test('公開ディレイ中(revealAt が未来)の番号は判定に使われない', async () => {
    const { gameId } = await makeStartedGame({ winLines: 1 });
    const { player, grid } = await joinPlayer(gameId, 'A');
    // B列を「未来の revealAt」で登録 → まだ公開されていない扱い
    const draws = grid[0].map((n, i) => ({
      n,
      ballIndex: i + 1,
      revealAt: Timestamp.fromMillis(Date.now() + 60000),
    }));
    await db.doc(`games/${gameId}`).update({ draws });
    const res = await submitClaim.run({ data: { gameId }, auth: { uid: player } });
    expect(res.status).toBe('rejected');
  });

  test('クレーム後に公開 leaderboard が生成される', async () => {
    const { gameId } = await makeStartedGame({ winLines: 1 });
    const { player, grid } = await joinPlayer(gameId, 'A');
    await setDraws(gameId, [...grid[0]]);
    await submitClaim.run({ data: { gameId }, auth: { uid: player } });
    const lb = (await db.doc(`games/${gameId}/public/leaderboard`).get()).data();
    expect(lb.entries.length).toBe(1);
    expect(lb.entries[0].nickname).toBe('A');
    expect(lb.entries[0].rank).toBe(1);
  });
});
