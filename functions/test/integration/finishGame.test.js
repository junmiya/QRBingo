'use strict';

const { FieldValue } = require('firebase-admin/firestore');
const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { joinGame } = require('../../src/joinGame');
const { finishGame } = require('../../src/finishGame');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

async function makeStartedGame(overrides = {}) {
  const host = uid();
  const { gameId } = await createGame.run({ data: overrides, auth: { uid: host } });
  await startGame.run({ data: { gameId }, auth: { uid: host } });
  return { gameId, host };
}

// プレイヤーを参加させ、achievedBallIndex を指定して verified クレームを直接投入する。
// (tie-break を精密に検証するため、抽選の実挙動に依存せず claims を制御する)
async function seedClaim(gameId, nickname, achievedBallIndex) {
  const player = uid();
  await joinGame.run({ data: { gameId, nickname }, auth: { uid: player } });
  const cardId = `${gameId}_${player}`;
  await db.doc(`claims/${cardId}`).set({
    gameId,
    cardId,
    uid: player,
    status: 'verified',
    achievedBallIndex,
    lines: 1,
    verifiedAt: FieldValue.serverTimestamp(),
  });
  return player;
}

describe('finishGame (integration)', () => {
  test('achievedBallIndex 昇順で順位付けし、上位が当選', async () => {
    const { gameId, host } = await makeStartedGame({ prizeCount: 2 });
    const pA = await seedClaim(gameId, 'A', 20);
    const pB = await seedClaim(gameId, 'B', 25);
    await seedClaim(gameId, 'C', 30);

    const res = await finishGame.run({ data: { gameId }, auth: { uid: host } });
    expect(res.winners.map((w) => w.rank)).toEqual([1, 2]);
    expect(res.winners.map((w) => w.uid)).toEqual([pA, pB]);
    expect(res.tieBreakApplied).toBe(false);
    // 全員に winCode(当選者のみ)
    res.winners.forEach((w) => expect(w.winCode).toMatch(/^WIN-[A-Z0-9]{9}$/));

    const game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.status).toBe('finished');
    expect(game.finishedAt).not.toBeNull();
  });

  test('当選者のみ winners ドキュメント + winCode を持つ', async () => {
    const { gameId, host } = await makeStartedGame({ prizeCount: 1 });
    const pWin = await seedClaim(gameId, 'W', 10);
    const pLose = await seedClaim(gameId, 'L', 20);

    await finishGame.run({ data: { gameId }, auth: { uid: host } });

    const winDoc = await db.doc(`winners/${gameId}_${pWin}`).get();
    const loseDoc = await db.doc(`winners/${gameId}_${pLose}`).get();
    expect(winDoc.exists).toBe(true);
    expect(winDoc.data().winCode).toMatch(/^WIN-/);
    expect(winDoc.data().rank).toBe(1);
    expect(loseDoc.exists).toBe(false);
  });

  test('景品数を超える同着は抽選で確定、当選数は景品数ちょうど', async () => {
    const { gameId, host } = await makeStartedGame({ prizeCount: 2 });
    // 4人全員が同じ ballIndex=30 で成立 → prizeCount=2 なので2名だけ当選
    const players = [];
    for (const nn of ['A', 'B', 'C', 'D']) players.push(await seedClaim(gameId, nn, 30));

    const res = await finishGame.run({ data: { gameId }, auth: { uid: host } });
    expect(res.tieBreakApplied).toBe(true);
    expect(res.winners.length).toBe(2);
    // 当選者は4人のうちの誰か2名
    res.winners.forEach((w) => expect(players).toContain(w.uid));

    // winners コレクションにもちょうど2件
    let winnerCount = 0;
    for (const p of players) {
      if ((await db.doc(`winners/${gameId}_${p}`).get()).exists) winnerCount++;
    }
    expect(winnerCount).toBe(2);
  });

  test('private/results と public/leaderboard が整合(当選者集合が一致)', async () => {
    const { gameId, host } = await makeStartedGame({ prizeCount: 2 });
    for (const nn of ['A', 'B', 'C', 'D']) await seedClaim(gameId, nn, 30);

    await finishGame.run({ data: { gameId }, auth: { uid: host } });

    const results = (await db.doc(`games/${gameId}/private/results`).get()).data();
    const leaderboard = (await db.doc(`games/${gameId}/public/leaderboard`).get()).data();

    const resultsWinners = results.entries.filter((e) => e.isWinner).map((e) => e.uid).sort();
    const lbWinners = leaderboard.entries.filter((e) => e.isWinner).map((e) => e.uid).sort();
    expect(lbWinners).toEqual(resultsWinners);
    expect(leaderboard.tieBreakSeed).toBe(results.tieBreakSeed);
    // 公開 leaderboard には winCode を含めない
    leaderboard.entries.forEach((e) => expect(e.winCode).toBeUndefined());
    // private/results の当選者は winCode を持つ
    results.entries.filter((e) => e.isWinner).forEach((e) => expect(e.winCode).toMatch(/^WIN-/));
  });

  test('非ホストは終了できない', async () => {
    const { gameId } = await makeStartedGame();
    await expect(
      finishGame.run({ data: { gameId }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('二重終了は failed-precondition', async () => {
    const { gameId, host } = await makeStartedGame();
    await finishGame.run({ data: { gameId }, auth: { uid: host } });
    await expect(
      finishGame.run({ data: { gameId }, auth: { uid: host } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('クレーム0件でも正常終了(当選者なし)', async () => {
    const { gameId, host } = await makeStartedGame();
    const res = await finishGame.run({ data: { gameId }, auth: { uid: host } });
    expect(res.winners).toEqual([]);
    expect(res.totalClaims).toBe(0);
  });
});
