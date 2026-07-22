'use strict';

// ホストによるゲームオプションの切り替え(spec 003)。
// - setChatEnabled: チャット機能の ON/OFF
// - setCountdown: 開始までのカウントダウンの目標時刻を設定/解除
// いずれもホストのみ。書き込みは Function 経由(rules は games の write を禁止)。

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { db } = require('./admin');

async function requireHostGame(gameId, uid) {
  const ref = db.doc(`games/${gameId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  if (snap.data().hostUid !== uid) throw new HttpsError('permission-denied', 'ホストのみ操作できます');
  return { ref, game: snap.data() };
}

// ゲームを中止する(順位を確定せずに終了)。lobby/playing のホストのみ。
// status を 'expired' にして参加者側も「終了」表示に切り替える。
exports.cancelGame = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const { ref, game } = await requireHostGame(gameId, request.auth.uid);
  if (game.status === 'finished' || game.status === 'expired') {
    return { status: game.status }; // 既に終了済みは何もしない(冪等)
  }
  await ref.update({ status: 'expired', countdownTarget: null });
  return { status: 'expired' };
});

exports.setChatEnabled = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');
  const enabled = Boolean(request.data && request.data.enabled);

  const { ref } = await requireHostGame(gameId, request.auth.uid);
  await ref.update({ 'settings.chatEnabled': enabled });
  return { chatEnabled: enabled };
});

// seconds > 0: 現在時刻 + seconds を目標に設定(カウントダウン開始)。
// seconds <= 0 / 未指定: 目標を解除(カウントダウン停止)。
exports.setCountdown = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const seconds = Number((request.data && request.data.seconds) || 0);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
    throw new HttpsError('invalid-argument', 'seconds は 0〜3600 で指定してください');
  }

  const { ref } = await requireHostGame(gameId, request.auth.uid);
  const target = seconds > 0 ? Timestamp.fromMillis(Date.now() + seconds * 1000) : null;
  await ref.update({ countdownTarget: target, 'settings.countdownEnabled': seconds > 0 });
  return { countdownTarget: target ? target.toMillis() : null };
});
