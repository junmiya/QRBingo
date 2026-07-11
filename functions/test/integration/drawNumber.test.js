'use strict';

const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { drawNumber } = require('../../src/drawNumber');
const { uid } = require('./_helpers');

async function makeReadyGame(overrides = {}) {
  const host = uid();
  const { gameId } = await createGame.run({ data: overrides, auth: { uid: host } });
  await startGame.run({ data: { gameId }, auth: { uid: host } });
  return { gameId, host };
}

describe('drawNumber (integration)', () => {
  test('draws a number and appends ballIndex/revealAt', async () => {
    const { gameId, host } = await makeReadyGame();
    const res = await drawNumber.run({ data: { gameId }, auth: { uid: host } });
    expect(res.n).toBeGreaterThanOrEqual(1);
    expect(res.n).toBeLessThanOrEqual(75);
    expect(res.ballIndex).toBe(1);
    expect(Number.isNaN(new Date(res.revealAt).getTime())).toBe(false);
  });

  test('draws all 75 numbers with no duplicates then rejects further draws', async () => {
    const { gameId, host } = await makeReadyGame();
    const seen = new Set();
    for (let i = 1; i <= 75; i++) {
      const res = await drawNumber.run({ data: { gameId }, auth: { uid: host } });
      expect(res.ballIndex).toBe(i);
      expect(seen.has(res.n)).toBe(false);
      seen.add(res.n);
    }
    expect(seen.size).toBe(75);
    await expect(
      drawNumber.run({ data: { gameId }, auth: { uid: host } })
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  }, 60000);

  test('non-host cannot draw', async () => {
    const { gameId } = await makeReadyGame();
    await expect(
      drawNumber.run({ data: { gameId }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('cannot draw before the game is started (lobby)', async () => {
    const host = uid();
    const { gameId } = await createGame.run({ data: {}, auth: { uid: host } });
    await expect(
      drawNumber.run({ data: { gameId }, auth: { uid: host } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('concurrent draws never duplicate or skip a ballIndex (serialization)', async () => {
    const { gameId, host } = await makeReadyGame();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => drawNumber.run({ data: { gameId }, auth: { uid: host } }))
    );
    const ballIndexes = results.map((r) => r.ballIndex).sort((a, b) => a - b);
    expect(ballIndexes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(results.map((r) => r.n)).size).toBe(10);
  }, 30000);

  test('respects revealDelaySec in revealAt', async () => {
    const { gameId, host } = await makeReadyGame({ revealDelaySec: 30 });
    const before = Date.now();
    const res = await drawNumber.run({ data: { gameId }, auth: { uid: host } });
    const revealAtMs = new Date(res.revealAt).getTime();
    expect(revealAtMs).toBeGreaterThanOrEqual(before + 29000);
  });
});
