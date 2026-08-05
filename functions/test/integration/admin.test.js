'use strict';

const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { drawNumber } = require('../../src/drawNumber');
const { adminListGames, adminPauseGame, adminEndGame } = require('../../src/adminOps');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

const ADMIN = { uid: 'admin-uid', token: { email: 'miyajun@gmail.com', email_verified: true } };
const NOT_VERIFIED = { uid: 'x', token: { email: 'miyajun@gmail.com', email_verified: false } };
const OTHER = { uid: 'y', token: { email: 'someone@example.com', email_verified: true } };

async function makePlayingGame() {
  const host = uid();
  const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
  await startGame.run({ data: { gameId }, auth: { uid: host } });
  return { gameId, host };
}

describe('運営モード adminOps (integration)', () => {
  test('adminListGames は運営者のみ。非運営は permission-denied', async () => {
    await makePlayingGame();
    const res = await adminListGames.run({ data: {}, auth: ADMIN });
    expect(Array.isArray(res.games)).toBe(true);
    expect(res.games.length).toBeGreaterThan(0);

    await expect(adminListGames.run({ data: {}, auth: OTHER })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(adminListGames.run({ data: {}, auth: NOT_VERIFIED })).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  test('一時停止すると抽選できず、再開すると抽選できる', async () => {
    const { gameId, host } = await makePlayingGame();

    await adminPauseGame.run({ data: { gameId, paused: true }, auth: ADMIN });
    let game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.paused).toBe(true);

    // 停止中はホストが抽選しようとしても失敗
    await expect(drawNumber.run({ data: { gameId }, auth: { uid: host } })).rejects.toMatchObject({
      code: 'failed-precondition',
    });

    // 再開すれば抽選できる
    await adminPauseGame.run({ data: { gameId, paused: false }, auth: ADMIN });
    const draw = await drawNumber.run({ data: { gameId }, auth: { uid: host } });
    expect(typeof draw.n).toBe('number');
  });

  test('非運営は一時停止・終了できない', async () => {
    const { gameId } = await makePlayingGame();
    await expect(
      adminPauseGame.run({ data: { gameId, paused: true }, auth: OTHER })
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      adminEndGame.run({ data: { gameId }, auth: OTHER })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('adminEndGame でゲームを強制終了(expired)できる', async () => {
    const { gameId } = await makePlayingGame();
    const res = await adminEndGame.run({ data: { gameId }, auth: ADMIN });
    expect(res.status).toBe('expired');
    const game = (await db.doc(`games/${gameId}`).get()).data();
    expect(game.status).toBe('expired');
  });
});
