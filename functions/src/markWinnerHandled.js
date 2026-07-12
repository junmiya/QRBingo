'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./admin');

// ホストが景品受け渡しの「対応済み」フラグを切り替える(FR-011)。
// winners ドキュメントと private/results の該当エントリを同時更新し、
// ホストのランキング画面(private/results 購読)に即反映する。
exports.markWinnerHandled = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const uid = request.auth.uid;
  const input = request.data || {};
  const gameId = String(input.gameId || '').trim().toUpperCase();
  const winnerId = String(input.winnerId || '').trim();
  const handled = !!input.handled;
  if (!gameId || !winnerId) {
    throw new HttpsError('invalid-argument', 'gameId と winnerId が必要です');
  }

  const gameSnap = await db.doc(`games/${gameId}`).get();
  if (!gameSnap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  if (gameSnap.data().hostUid !== uid) {
    throw new HttpsError('permission-denied', 'ホストのみ操作できます');
  }

  const winnerRef = db.doc(`winners/${winnerId}`);
  const resultsRef = db.doc(`games/${gameId}/private/results`);

  await db.runTransaction(async (tx) => {
    const [winnerSnap, resultsSnap] = await Promise.all([tx.get(winnerRef), tx.get(resultsRef)]);
    if (!winnerSnap.exists || winnerSnap.data().gameId !== gameId) {
      throw new HttpsError('not-found', '当選情報が見つかりません');
    }
    tx.update(winnerRef, { handled });
    if (resultsSnap.exists) {
      const winnerUid = winnerSnap.data().uid;
      const entries = (resultsSnap.data().entries || []).map((e) =>
        e.uid === winnerUid ? { ...e, handled } : e
      );
      tx.update(resultsRef, { entries });
    }
  });

  return { winnerId, handled };
});
