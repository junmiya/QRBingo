'use strict';

const { FieldValue } = require('firebase-admin/firestore');
const { createGame } = require('../../src/createGame');
const { startGame } = require('../../src/startGame');
const { joinGame } = require('../../src/joinGame');
const { finishGame } = require('../../src/finishGame');
const { hideNickname } = require('../../src/hideNickname');
const { markWinnerHandled } = require('../../src/markWinnerHandled');
const { db } = require('../../src/admin');
const { uid } = require('./_helpers');

async function makeStartedGame(overrides = {}) {
  const host = uid();
  const { gameId } = await createGame.run({ data: overrides, auth: { uid: host } });
  await startGame.run({ data: { gameId }, auth: { uid: host } });
  return { gameId, host };
}

async function seedClaim(gameId, nickname, achievedBallIndex) {
  const player = uid();
  await joinGame.run({ data: { gameId, nickname }, auth: { uid: player } });
  const cardId = `${gameId}_${player}`;
  await db.doc(`claims/${cardId}`).set({
    gameId, cardId, uid: player, status: 'verified', achievedBallIndex, lines: 1,
    verifiedAt: FieldValue.serverTimestamp(),
  });
  return { player, cardId };
}

describe('hideNickname (integration)', () => {
  test('ホストが伏字化すると公開 leaderboard で非表示になる', async () => {
    const { gameId, host } = await makeStartedGame();
    const { player, cardId } = await seedClaim(gameId, 'わるいなまえ', 10);
    // まず leaderboard を作るために finish(あるいは submitClaim 経由でも可)
    await finishGame.run({ data: { gameId }, auth: { uid: host } });

    let lb = (await db.doc(`games/${gameId}/public/leaderboard`).get()).data();
    expect(lb.entries[0].nickname).toBe('わるいなまえ');

    await hideNickname.run({ data: { gameId, cardId, hidden: true }, auth: { uid: host } });
    lb = (await db.doc(`games/${gameId}/public/leaderboard`).get()).data();
    expect(lb.entries[0].nickname).toBe('(非表示)');

    // 元に戻せる
    await hideNickname.run({ data: { gameId, cardId, hidden: false }, auth: { uid: host } });
    lb = (await db.doc(`games/${gameId}/public/leaderboard`).get()).data();
    expect(lb.entries[0].nickname).toBe('わるいなまえ');
    expect(player).toBeTruthy();
  });

  test('非ホストは伏字化できない', async () => {
    const { gameId } = await makeStartedGame();
    const { cardId } = await seedClaim(gameId, 'A', 10);
    await expect(
      hideNickname.run({ data: { gameId, cardId, hidden: true }, auth: { uid: uid() } })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('markWinnerHandled (integration)', () => {
  test('対応済みフラグを winners と private/results の両方に反映', async () => {
    const { gameId, host } = await makeStartedGame({ prizeCount: 1 });
    const { player } = await seedClaim(gameId, 'W', 10);
    await finishGame.run({ data: { gameId }, auth: { uid: host } });

    const winnerId = `${gameId}_${player}`;
    await markWinnerHandled.run({ data: { gameId, winnerId, handled: true }, auth: { uid: host } });

    const winner = (await db.doc(`winners/${winnerId}`).get()).data();
    expect(winner.handled).toBe(true);

    const results = (await db.doc(`games/${gameId}/private/results`).get()).data();
    const entry = results.entries.find((e) => e.uid === player);
    expect(entry.handled).toBe(true);
  });

  test('非ホストは操作できない', async () => {
    const { gameId, host } = await makeStartedGame({ prizeCount: 1 });
    const { player } = await seedClaim(gameId, 'W', 10);
    await finishGame.run({ data: { gameId }, auth: { uid: host } });
    await expect(
      markWinnerHandled.run({
        data: { gameId, winnerId: `${gameId}_${player}`, handled: true },
        auth: { uid: uid() },
      })
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
