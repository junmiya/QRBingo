'use strict';

const { createGame } = require('../../src/createGame');
const { joinGame } = require('../../src/joinGame');
const { generateCard } = require('../../src/lib/bingo');
const { db } = require('../../src/admin');
const { uid, grantEntitlement } = require('./_helpers');

async function makeGame(overrides = {}) {
  const host = uid();
  // 課金ゲートの影響を受けないよう、参加テストのホストは上限を引き上げておく
  await grantEntitlement(host, 100000);
  const res = await createGame.run({ data: overrides, auth: { uid: host } });
  return { gameId: res.gameId, host };
}

describe('joinGame (integration)', () => {
  test('issues a card whose grid is reproducible from the returned seed', async () => {
    const { gameId } = await makeGame();
    const player = uid();
    const res = await joinGame.run({ data: { gameId, nickname: 'たろう' }, auth: { uid: player } });

    expect(res.cardId).toBe(`${gameId}_${player}`);
    expect(res.rejoined).toBe(false);
    expect(res.seed.startsWith(gameId + '-')).toBe(true);

    const grid = generateCard(res.seed);
    const stored = (await db.collection('cards').doc(res.cardId).get()).data();
    expect(stored.seed).toBe(res.seed);
    expect(stored.nickname).toBe('たろう');
    expect(Array.isArray(grid)).toBe(true);
  });

  test('rejoining returns the same card and does not overwrite nickname (idempotent)', async () => {
    const { gameId } = await makeGame();
    const player = uid();
    const first = await joinGame.run({ data: { gameId, nickname: 'A' }, auth: { uid: player } });
    const second = await joinGame.run({ data: { gameId, nickname: 'B' }, auth: { uid: player } });
    expect(second.seed).toBe(first.seed);
    expect(second.rejoined).toBe(true);
    expect(second.nickname).toBe('A');
  });

  test('participantCount increments once per unique player', async () => {
    const { gameId } = await makeGame();
    await joinGame.run({ data: { gameId, nickname: 'A' }, auth: { uid: uid() } });
    await joinGame.run({ data: { gameId, nickname: 'B' }, auth: { uid: uid() } });
    const game = (await db.collection('games').doc(gameId).get()).data();
    expect(game.participantCount).toBe(2);
  });

  test('rejects invalid nickname', async () => {
    const { gameId } = await makeGame();
    await expect(
      joinGame.run({ data: { gameId, nickname: '' }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('enforces capacity', async () => {
    const { gameId } = await makeGame({ capacity: 2 });
    await joinGame.run({ data: { gameId, nickname: 'A' }, auth: { uid: uid() } });
    await joinGame.run({ data: { gameId, nickname: 'B' }, auth: { uid: uid() } });
    await expect(
      joinGame.run({ data: { gameId, nickname: 'C' }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  test('rejects a fresh join to a finished game', async () => {
    const { gameId } = await makeGame();
    await db.collection('games').doc(gameId).update({ status: 'finished' });
    await expect(
      joinGame.run({ data: { gameId, nickname: 'A' }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('allows a rejoin even after the game finished (session continuity)', async () => {
    const { gameId } = await makeGame();
    const player = uid();
    const first = await joinGame.run({ data: { gameId, nickname: 'A' }, auth: { uid: player } });
    await db.collection('games').doc(gameId).update({ status: 'finished' });
    const second = await joinGame.run({ data: { gameId, nickname: 'A' }, auth: { uid: player } });
    expect(second.seed).toBe(first.seed);
    expect(second.rejoined).toBe(true);
  });

  test('allowDuplicateCards=false yields unique grids across many players (statistical)', async () => {
    const { gameId } = await makeGame({ capacity: 50 });
    const seeds = [];
    for (let i = 0; i < 20; i++) {
      const res = await joinGame.run({ data: { gameId, nickname: 'P' + i }, auth: { uid: uid() } });
      seeds.push(res.seed);
    }
    const grids = seeds.map((s) => JSON.stringify(generateCard(s)));
    expect(new Set(grids).size).toBe(grids.length);
  });

  test('allowDuplicateCards=true skips gridHash bookkeeping entirely (FR-004)', async () => {
    const { gameId } = await makeGame({ allowDuplicateCards: true, capacity: 10 });
    for (let i = 0; i < 5; i++) {
      await joinGame.run({ data: { gameId, nickname: 'D' + i }, auth: { uid: uid() } });
    }
    const hashes = await db.collection('games').doc(gameId).collection('gridHashes').get();
    expect(hashes.empty).toBe(true);
  });

  test('concurrent joins never exceed capacity (race safety)', async () => {
    const { gameId } = await makeGame({ capacity: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        joinGame.run({ data: { gameId, nickname: 'C' + i }, auth: { uid: uid() } })
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(5);
    const game = (await db.collection('games').doc(gameId).get()).data();
    expect(game.participantCount).toBe(5);
  }, 30000);
});
