'use strict';

const { createGame } = require('../../src/createGame');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

describe('createGame (integration, Firestore emulator)', () => {
  test('rejects unauthenticated calls', async () => {
    await expect(createGame.run({ data: {} })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('creates a game with defaults', async () => {
    const res = await createGame.run({ data: {}, auth: { uid: uid() } });
    expect(res.gameId).toMatch(/^[A-Z0-9]{4}$/);

    const snap = await db.collection('games').doc(res.gameId).get();
    expect(snap.exists).toBe(true);
    const game = snap.data();
    expect(game.status).toBe('lobby');
    expect(game.settings).toEqual({
      winLines: 1,
      revealDelaySec: 0,
      capacity: null,
      allowDuplicateCards: false,
      prizeCount: 3,
    });
    expect(game.draws).toEqual([]);
    expect(game.participantCount).toBe(0);
  });

  test('accepts custom settings within range', async () => {
    const res = await createGame.run({
      data: { winLines: 3, revealDelaySec: 15, capacity: 100, allowDuplicateCards: true, prizeCount: 10 },
      auth: { uid: uid() },
    });
    const game = (await db.collection('games').doc(res.gameId).get()).data();
    expect(game.settings).toEqual({
      winLines: 3,
      revealDelaySec: 15,
      capacity: 100,
      allowDuplicateCards: true,
      prizeCount: 10,
    });
  });

  test.each([
    ['winLines', 0],
    ['winLines', 13],
    ['winLines', 1.5],
    ['revealDelaySec', -1],
    ['revealDelaySec', 61],
    ['capacity', 0],
    ['capacity', 100001],
    ['prizeCount', 0],
    ['prizeCount', 101],
  ])('rejects out-of-range %s=%p', async (key, value) => {
    await expect(
      createGame.run({ data: { [key]: value }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
