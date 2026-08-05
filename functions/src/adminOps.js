'use strict';

// 運営(プラットフォーム管理者)向け操作。
// 認可は必ずサーバー側で行う: 検証済みメール(email_verified)が ADMIN_EMAILS に
// 一致する場合のみ許可する。クライアントのメール判定は表示切替のみで、権限判定ではない。

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { db } = require('./admin');

// 運営者のメール(小文字で比較)。増やす場合はここに追加。
const ADMIN_EMAILS = ['miyajun@gmail.com'];

function isAdminToken(token) {
  if (!token || !token.email) return false;
  if (token.email_verified !== true) return false; // なりすまし(未検証メール)を排除
  return ADMIN_EMAILS.includes(String(token.email).toLowerCase());
}

function requireAdmin(request) {
  if (!request.auth || !isAdminToken(request.auth.token)) {
    throw new HttpsError('permission-denied', '運営者のみ操作できます');
  }
}

// 全ゲームの一覧(新しい順・最大200件)。運営モードの一覧表示に使う。
exports.adminListGames = onCall(async (request) => {
  requireAdmin(request);
  const snap = await db.collection('games').orderBy('createdAt', 'desc').limit(200).get();
  const games = snap.docs.map((d) => {
    const g = d.data();
    return {
      gameId: d.id,
      status: g.status,
      hostUid: g.hostUid || null,
      participantCount: g.participantCount || 0,
      drawsCount: (g.draws || []).length,
      paused: !!g.paused,
      tipCount: g.tipCount || 0,
      createdAt: g.createdAt && g.createdAt.toMillis ? g.createdAt.toMillis() : null,
    };
  });
  return { games };
});

// 任意のゲームを一時停止/再開する(進行中のみ)。停止中は抽選できない。
exports.adminPauseGame = onCall(async (request) => {
  requireAdmin(request);
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');
  const paused = !!(request.data && request.data.paused);

  const ref = db.doc(`games/${gameId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  const st = snap.data().status;
  if (st !== 'lobby' && st !== 'playing') {
    throw new HttpsError('failed-precondition', '受付中/進行中のゲームのみ一時停止できます');
  }
  await ref.update({ paused });
  return { paused };
});

// 任意のゲームを強制終了する(順位は確定せず expired にする)。
exports.adminEndGame = onCall(async (request) => {
  requireAdmin(request);
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const ref = db.doc(`games/${gameId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  const st = snap.data().status;
  if (st === 'finished' || st === 'expired') return { status: st };
  await ref.update({ status: 'expired', paused: false, countdownTarget: null });
  return { status: 'expired' };
});
