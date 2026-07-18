'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { joinGame } = require('../../src/joinGame');
const { reportReach } = require('../../src/reportReach');
const { submitClaim } = require('../../src/submitClaim');
const { generateCard } = require('../../src/lib/bingo');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

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
  return { player, grid: generateCard(res.seed) };
}

describe('reportReach (integration)', () => {
  test('B列4つマーク=リーチでリストに登録される(サーバー検証)', async () => {
    const { gameId } = await makeStartedGame();
    const { player, grid } = await joinPlayer(gameId, 'リー太');
    await setDraws(gameId, grid[0].slice(0, 4)); // B列のうち4マス → リーチ

    const res = await reportReach.run({ data: { gameId }, auth: { uid: player } });
    expect(res.status).toBe('reach');
    expect(res.reachLines).toBeGreaterThanOrEqual(1);

    const doc = await db.doc(`games/${gameId}/reaches/${player}`).get();
    expect(doc.exists).toBe(true);
    expect(doc.data().nickname).toBe('リー太');
    expect(doc.data().reachLines).toBeGreaterThanOrEqual(1);
    expect(doc.data().ballIndex).toBe(4);
  });

  test('リーチしていない虚偽報告は登録されない', async () => {
    const { gameId } = await makeStartedGame();
    const { player, grid } = await joinPlayer(gameId, 'ウソ太');
    await setDraws(gameId, grid[0].slice(0, 2)); // 2マスだけ → リーチではない

    const res = await reportReach.run({ data: { gameId }, auth: { uid: player } });
    expect(res.status).toBe('none');
    const doc = await db.doc(`games/${gameId}/reaches/${player}`).get();
    expect(doc.exists).toBe(false);
  });

  test('ビンゴ到達後の報告は bingo を返し、リストに残らない', async () => {
    const { gameId } = await makeStartedGame();
    const { player, grid } = await joinPlayer(gameId, 'ビン太');
    await setDraws(gameId, [...grid[0]]); // B列コンプリート

    const res = await reportReach.run({ data: { gameId }, auth: { uid: player } });
    expect(res.status).toBe('bingo');
    const doc = await db.doc(`games/${gameId}/reaches/${player}`).get();
    expect(doc.exists).toBe(false);
  });

  test('リーチ登録後にビンゴをクレームするとリストから自動削除される', async () => {
    const { gameId } = await makeStartedGame();
    const { player, grid } = await joinPlayer(gameId, '成長太');

    await setDraws(gameId, grid[0].slice(0, 4));
    await reportReach.run({ data: { gameId }, auth: { uid: player } });
    expect((await db.doc(`games/${gameId}/reaches/${player}`).get()).exists).toBe(true);

    await setDraws(gameId, [...grid[0]]); // 5マス目も公開 → ビンゴ
    const claim = await submitClaim.run({ data: { gameId }, auth: { uid: player } });
    expect(claim.status).toBe('verified');
    expect((await db.doc(`games/${gameId}/reaches/${player}`).get()).exists).toBe(false);
  });

  test('lobby 中は failed-precondition', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    const { player } = await joinPlayer(gameId, 'ロビ太');
    await expect(
      reportReach.run({ data: { gameId }, auth: { uid: player } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
