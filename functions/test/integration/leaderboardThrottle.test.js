'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { joinGame } = require('../../src/joinGame');
const { submitClaim } = require('../../src/submitClaim');
const { drawNumber } = require('../../src/drawNumber');
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

const lb = async (gameId) => (await db.doc(`games/${gameId}/public/leaderboard`).get()).data();
const dirty = async (gameId) =>
  (await db.doc(`games/${gameId}`).get()).data().leaderboardDirty === true;

describe('leaderboard スロットリング (integration)', () => {
  test('初回クレームは即時再構築、間隔内の次クレームは保留(dirty)', async () => {
    const { gameId } = await makeStartedGame({ winLines: 1, capacity: 10 });
    const a = await joinPlayer(gameId, 'A');
    const b = await joinPlayer(gameId, 'B');

    // A がビンゴ(B列コンプリート)→ 初回クレームは即時再構築
    await setDraws(gameId, [...a.grid[0]]);
    await submitClaim.run({ data: { gameId }, auth: { uid: a.player } });
    let board = await lb(gameId);
    expect(board.entries.length).toBe(1);
    expect(board.entries[0].uid).toBe(a.player);

    // 直後(3秒以内)に B もビンゴ → スロットリングで保留、leaderboard は据え置き
    await setDraws(gameId, [...a.grid[0], ...b.grid[0]]);
    await submitClaim.run({ data: { gameId }, auth: { uid: b.player } });
    board = await lb(gameId);
    expect(board.entries.length).toBe(1); // まだ A のみ
    expect(await dirty(gameId)).toBe(true); // 保留中フラグが立つ

    // B のクレーム自体は保存されている(順位は保留なだけ)
    const bClaim = (await db.doc(`claims/${gameId}_${b.player}`).get()).data();
    expect(bClaim.status).toBe('verified');
  });

  test('drawNumber が保留中の leaderboard を確定反映する(flush)', async () => {
    const { gameId, host } = await makeStartedGame({ winLines: 1, capacity: 10 });
    const a = await joinPlayer(gameId, 'A');
    const b = await joinPlayer(gameId, 'B');

    await setDraws(gameId, [...a.grid[0]]);
    await submitClaim.run({ data: { gameId }, auth: { uid: a.player } });
    await setDraws(gameId, [...a.grid[0], ...b.grid[0]]);
    await submitClaim.run({ data: { gameId }, auth: { uid: b.player } });
    expect(await dirty(gameId)).toBe(true);

    // ホストが抽選 → flushLeaderboardIfDirty が走り、2人分が反映される
    await drawNumber.run({ data: { gameId }, auth: { uid: host } });
    const board = await lb(gameId);
    expect(board.entries.length).toBe(2);
    expect(board.entries.map((e) => e.uid).sort()).toEqual([a.player, b.player].sort());
    expect(await dirty(gameId)).toBe(false);
  });

  test('dirty でない状態の drawNumber は再構築しない(無駄な配信をしない)', async () => {
    const { gameId, host } = await makeStartedGame({ winLines: 1 });
    // クレームなしで抽選 → leaderboard は作られない(dirty でないため flush しない)
    await drawNumber.run({ data: { gameId }, auth: { uid: host } });
    const board = await lb(gameId);
    expect(board).toBeUndefined();
  });
});
