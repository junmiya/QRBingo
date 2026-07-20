'use strict';

// チャット送信(spec 003)。ホストがチャットを有効化したゲームでのみ、
// 参加者(カード保有)またはホストがメッセージを送れる。
// 書き込みは Function 経由のみ(rules は chat の write を禁止)。
// 順位・当選には一切影響しない。

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./admin');

const CHAT_MAX_LEN = 200;

// 制御文字(改行・タブ以外)を除去し、前後空白を整える。
function sanitizeText(raw) {
  const s = String(raw == null ? '' : raw).normalize('NFKC');
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code === 0x0a || code === 0x09) out += ch; // 改行・タブは許可
    else if (code < 0x20 || code === 0x7f) continue; // その他制御文字は除去
    else out += ch;
  }
  return out.trim();
}

exports.sendChat = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const uid = request.auth.uid;
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const text = sanitizeText(request.data && request.data.text);
  if (text.length < 1) throw new HttpsError('invalid-argument', 'メッセージが空です');
  if (text.length > CHAT_MAX_LEN) {
    throw new HttpsError('invalid-argument', `メッセージは${CHAT_MAX_LEN}文字以内で入力してください`);
  }

  const [gameSnap, cardSnap] = await Promise.all([
    db.doc(`games/${gameId}`).get(),
    db.doc(`cards/${gameId}_${uid}`).get(),
  ]);
  if (!gameSnap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  const game = gameSnap.data();

  if (!(game.settings && game.settings.chatEnabled)) {
    throw new HttpsError('failed-precondition', 'このゲームではチャットが無効です');
  }
  if (game.status === 'finished' || game.status === 'expired') {
    throw new HttpsError('failed-precondition', 'ゲームは終了しました');
  }

  const isHost = game.hostUid === uid;
  if (!isHost && !cardSnap.exists) {
    throw new HttpsError('permission-denied', 'このゲームに参加していません');
  }
  const nickname = isHost ? '主催者' : cardSnap.data().nickname;

  await db.collection(`games/${gameId}/chat`).add({
    uid,
    nickname,
    text,
    isHost,
    createdAt: FieldValue.serverTimestamp(),
  });

  return { status: 'ok' };
});
