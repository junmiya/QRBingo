'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./admin');

exports.startGame = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'サインインが必要です');
  }
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const ref = db.collection('games').doc(gameId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');

    const game = snap.data();
    if (game.hostUid !== request.auth.uid) {
      throw new HttpsError('permission-denied', 'ホストのみ操作できます');
    }
    if (game.status !== 'lobby') {
      throw new HttpsError('failed-precondition', 'lobby 状態のゲームのみ開始できます');
    }

    tx.update(ref, { status: 'playing', startedAt: FieldValue.serverTimestamp() });
    return { status: 'playing' };
  });
});
