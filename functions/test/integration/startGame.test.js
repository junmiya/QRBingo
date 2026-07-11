'use strict';

const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

async function makeGame(hostUid) {
  const res = await createGame.run({ data: {}, auth: { uid: hostUid } });
  return res.gameId;
}

describe('startGame (integration)', () => {
  test('host can start a lobby game', async () => {
    const host = uid();
    const gameId = await makeGame(host);
    const res = await startGame.run({ data: { gameId }, auth: { uid: host } });
    expect(res.status).toBe('playing');

    const game = (await db.collection('games').doc(gameId).get()).data();
    expect(game.status).toBe('playing');
    expect(game.startedAt).not.toBeNull();
  });

  test('non-host cannot start the game', async () => {
    const host = uid();
    const gameId = await makeGame(host);
    await expect(
      startGame.run({ data: { gameId }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('cannot start a game twice', async () => {
    const host = uid();
    const gameId = await makeGame(host);
    await startGame.run({ data: { gameId }, auth: { uid: host } });
    await expect(
      startGame.run({ data: { gameId }, auth: { uid: host } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('unknown gameId is not-found', async () => {
    await expect(
      startGame.run({ data: { gameId: 'ZZZZ' }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
