'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { joinGame } = require('../../src/joinGame');
const { submitClaim } = require('../../src/submitClaim');
const { drawNumber } = require('../../src/drawNumber');
const { generateCard } = require('../../src/lib/bingo');
const { rebuildPublicLeaderboard } = require('../../src/lib/leaderboardService');
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
const gameDoc = async (gameId) => (await db.doc(`games/${gameId}`).get()).data();
const dirty = async (gameId) => (await gameDoc(gameId)).leaderboardDirty === true;

describe('leaderboard スロットリング (integration)', () => {
  test('初回クレームは即時再構築、間隔内の次クレームは末尾フラッシュで数秒以内に反映', async () => {
    const { gameId } = await makeStartedGame({ winLines: 1, capacity: 10 });
    const a = await joinPlayer(gameId, 'A');
    const b = await joinPlayer(gameId, 'B');

    // A がビンゴ(B列コンプリート)→ 初回クレームは即時再構築
    await setDraws(gameId, [...a.grid[0]]);
    await submitClaim.run({ data: { gameId }, auth: { uid: a.player } });
    let board = await lb(gameId);
    expect(board.entries.length).toBe(1);
    expect(board.entries[0].uid).toBe(a.player);
    const firstUpdatedAt = board.updatedAt.toMillis();

    // 直後(3秒以内)に B もビンゴ → リースを取って間隔明けまで待ち、再構築して戻る
    await setDraws(gameId, [...a.grid[0], ...b.grid[0]]);
    const t0 = Date.now();
    await submitClaim.run({ data: { gameId }, auth: { uid: b.player } });
    const waited = Date.now() - t0;

    board = await lb(gameId);
    expect(board.entries.length).toBe(2); // 次の抽選を待たずに反映
    expect(board.entries.map((e) => e.uid).sort()).toEqual([a.player, b.player].sort());
    expect(board.updatedAt.toMillis() - firstUpdatedAt).toBeGreaterThanOrEqual(2500); // 間隔は守る
    expect(waited).toBeLessThan(6000);
    expect(await dirty(gameId)).toBe(false);
    expect((await gameDoc(gameId)).leaderboardFlushAt).toBeNull();
  }, 20000);

  test('同着(同じ球目)は同順位で tied=true、単独は tied=false', async () => {
    const { gameId } = await makeStartedGame({ winLines: 1, capacity: 10 });
    const a = await joinPlayer(gameId, 'A');
    const b = await joinPlayer(gameId, 'B');
    const c = await joinPlayer(gameId, 'C');

    // A と B は同じ球目(7球目)でビンゴ、C は 9球目(verified クレームを直接投入)
    for (const [p, ball] of [
      [a, 7],
      [b, 7],
      [c, 9],
    ]) {
      await db.doc(`claims/${gameId}_${p.player}`).set({
        gameId,
        uid: p.player,
        cardId: `${gameId}_${p.player}`,
        status: 'verified',
        achievedBallIndex: ball,
        lines: 1,
        verifiedAt: Timestamp.now(),
      });
    }
    await rebuildPublicLeaderboard(gameId);

    const board = await lb(gameId);
    const byUid = Object.fromEntries(board.entries.map((e) => [e.uid, e]));
    expect(byUid[a.player].rank).toBe(byUid[b.player].rank);
    expect(byUid[a.player].tied).toBe(true);
    expect(byUid[b.player].tied).toBe(true);
    expect(byUid[c.player].rank).toBe(3);
    expect(byUid[c.player].tied).toBe(false);
  }, 20000);

  test('drawNumber が保留中(dirty)の leaderboard を確定反映する(flush)', async () => {
    const { gameId, host } = await makeStartedGame({ winLines: 1, capacity: 10 });
    const a = await joinPlayer(gameId, 'A');
    const b = await joinPlayer(gameId, 'B');

    await setDraws(gameId, [...a.grid[0], ...b.grid[0]]);
    await submitClaim.run({ data: { gameId }, auth: { uid: a.player } });
    // リース保持者が落ちた状況を再現: B のクレームだけ保存し、dirty を立てておく
    await db.doc(`claims/${gameId}_${b.player}`).set({
      gameId,
      uid: b.player,
      cardId: `${gameId}_${b.player}`,
      status: 'verified',
      achievedBallIndex: 10,
      lines: 1,
      verifiedAt: Timestamp.now(),
    });
    await db.doc(`games/${gameId}`).set({ leaderboardDirty: true }, { merge: true });
    expect((await lb(gameId)).entries.length).toBe(1);

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
