'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./admin');
const { rebuildPublicLeaderboard } = require('./lib/leaderboardService');

// ホストが不適切なニックネームを公開ランキング上で伏字化する(FR-005)。
exports.hideNickname = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const uid = request.auth.uid;
  const input = request.data || {};
  const gameId = String(input.gameId || '').trim().toUpperCase();
  const cardId = String(input.cardId || '').trim();
  const hidden = !!input.hidden;
  if (!gameId || !cardId) throw new HttpsError('invalid-argument', 'gameId と cardId が必要です');

  const gameSnap = await db.doc(`games/${gameId}`).get();
  if (!gameSnap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  if (gameSnap.data().hostUid !== uid) {
    throw new HttpsError('permission-denied', 'ホストのみ操作できます');
  }

  const cardRef = db.doc(`cards/${cardId}`);
  const cardSnap = await cardRef.get();
  if (!cardSnap.exists || cardSnap.data().gameId !== gameId) {
    throw new HttpsError('not-found', 'カードが見つかりません');
  }
  const targetUid = cardSnap.data().uid;

  await cardRef.update({ nicknameHidden: hidden });

  // 確定後(private/results がある)は、ホスト画面の確定ランキングにも
  // 伏字状態を反映する(results はスナップショットのため個別に更新)。
  const resultsRef = db.doc(`games/${gameId}/private/results`);
  const resultsSnap = await resultsRef.get();
  if (resultsSnap.exists) {
    const entries = (resultsSnap.data().entries || []).map((e) =>
      e.uid === targetUid ? { ...e, nicknameHidden: hidden } : e
    );
    await resultsRef.update({ entries });
  }

  await rebuildPublicLeaderboard(gameId);

  return { cardId, hidden };
});
