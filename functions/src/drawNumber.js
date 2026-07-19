'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { db } = require('./admin');
const { flushLeaderboardIfDirty } = require('./lib/leaderboardService');

const TOTAL_BALLS = 75;

exports.drawNumber = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'サインインが必要です');
  }
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const ref = db.collection('games').doc(gameId);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');

    const game = snap.data();
    if (game.hostUid !== request.auth.uid) {
      throw new HttpsError('permission-denied', 'ホストのみ操作できます');
    }
    if (game.status !== 'playing') {
      throw new HttpsError('failed-precondition', 'playing 状態のゲームのみ抽選できます');
    }

    const draws = game.draws || [];
    if (draws.length >= TOTAL_BALLS) {
      throw new HttpsError('resource-exhausted', 'すべての番号を抽選済みです');
    }

    const drawnNumbers = new Set(draws.map((d) => d.n));
    const remaining = [];
    for (let n = 1; n <= TOTAL_BALLS; n++) if (!drawnNumbers.has(n)) remaining.push(n);

    const n = remaining[Math.floor(Math.random() * remaining.length)];
    const ballIndex = draws.length + 1;
    const revealDelaySec = (game.settings && game.settings.revealDelaySec) || 0;
    // revealAt はサーバー時刻基準(Cloud Functions の Date.now())。
    // 配列要素には FieldValue.serverTimestamp() センチネルを使えないための措置。
    const revealAt = Timestamp.fromMillis(Date.now() + revealDelaySec * 1000);

    tx.update(ref, { draws: FieldValue.arrayUnion({ n, ballIndex, revealAt }) });

    return { n, ballIndex, revealAt: revealAt.toDate().toISOString() };
  }, { maxAttempts: 10 }); // 抽選ボタン連打の直列化を確実にする(Edge Case)

  // スロットリングで保留中のランキングがあれば、この抽選のタイミングで確定反映する
  // (末尾のクレームを取りこぼさないため)。失敗しても抽選自体は成立済みなので握りつぶす。
  try {
    await flushLeaderboardIfDirty(gameId);
  } catch (e) {
    // no-op(次の抽選か finishGame で必ず反映される)
  }

  return result;
});
