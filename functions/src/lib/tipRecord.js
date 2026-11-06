'use strict';

// 投げ銭(運営への応援)の記録。Stripe Webhook(checkout.session.completed, kind=tip)から呼ぶ。
// - すべての投げ銭を operatorTips/{sessionId} に記録する(運営の台帳・クライアントは読めない)
// - ゲームから送られた場合は、そのゲームにも記録・集計し、全員の画面にアナウンスする
// - stripeEvents/{sessionId} で冪等化(Webhook の二重配信を無視)
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { db } = require('../admin');
const { appendFeed } = require('./feed');

async function recordTip(session) {
  const md = session.metadata || {};
  const gameId = md.gameId || null;
  const amount = Number(md.amount) || session.amount_total || 0;
  const fee = Number(md.fee) || 0;
  const net = Math.max(0, amount - fee);

  const procRef = db.doc(`stripeEvents/${session.id}`);
  const ledgerRef = db.doc(`operatorTips/${session.id}`);
  const gameRef = gameId ? db.doc(`games/${gameId}`) : null;

  let firstTime = false;
  await db.runTransaction(async (tx) => {
    const done = await tx.get(procRef);
    if (done.exists) return; // 冪等
    firstTime = true;
    const at = Timestamp.fromMillis(Date.now());
    tx.set(ledgerRef, { amount, fee, net, gameId, fromUid: md.fromUid || null, at });
    if (gameRef) {
      tx.set(db.doc(`games/${gameId}/tips/${session.id}`), {
        amount,
        fee,
        net,
        fromUid: md.fromUid || null,
        hostUid: md.hostUid || null,
        at,
      });
      // ゲームに集計(総額・ホスト受取 net・件数)。ホスト画面の表示に使う。
      tx.set(
        gameRef,
        {
          tipTotalAmount: FieldValue.increment(amount),
          tipTotalNet: FieldValue.increment(net),
          tipCount: FieldValue.increment(1),
        },
        { merge: true }
      );
    }
    tx.set(procRef, { kind: 'tip', gameId, amount, fee, sessionId: session.id, at });
  });

  // ゲームから送られた応援は、そのゲームの全員にアナウンス(二重配信時は出さない)
  if (firstTime && gameId) {
    let nickname = '応援';
    try {
      const cardSnap = md.fromUid ? await db.doc(`cards/${gameId}_${md.fromUid}`).get() : null;
      if (cardSnap && cardSnap.exists && cardSnap.data().nickname) nickname = cardSnap.data().nickname;
    } catch (e) {
      /* ニックネーム取得失敗時は既定名で通知 */
    }
    await appendFeed(gameId, { type: 'tip', nickname, amount });
  }
  return firstTime ? 'ok' : 'duplicate';
}

module.exports = { recordTip };
