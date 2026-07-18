'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./admin');
const { generateCard, evaluateCard } = require('./lib/bingo');

// プレイヤーのリーチ状態をホスト向けリストに登録する(演出用・US-6)。
// submitClaim と同様にサーバーがシードから再計算するため、
// 虚偽のリーチ申告は登録されない。順位・当選には一切影響しない。
//
// 書き込み先: games/{gameId}/reaches/{uid}
// - リーチ中: upsert(reachLines = あと1マスのライン本数)
// - リーチでない / ビンゴ済み: ドキュメント削除(リストから消える)
exports.reportReach = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const uid = request.auth.uid;
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const [gameSnap, cardSnap] = await Promise.all([
    db.doc(`games/${gameId}`).get(),
    db.doc(`cards/${gameId}_${uid}`).get(),
  ]);
  if (!gameSnap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  if (!cardSnap.exists) throw new HttpsError('not-found', 'このゲームに参加していません');

  const game = gameSnap.data();
  if (game.status !== 'playing') {
    throw new HttpsError('failed-precondition', 'ゲームが進行中ではありません');
  }

  const card = cardSnap.data();
  const grid = generateCard(card.seed);
  const now = Date.now();
  const revealed = (game.draws || [])
    .filter((d) => d.revealAt.toMillis() <= now)
    .sort((a, b) => a.ballIndex - b.ballIndex);
  const marked = new Set(revealed.map((d) => d.n));
  const { bingoLines, reachCount } = evaluateCard(grid, marked);

  const winLines = game.settings.winLines;
  const reachRef = db.doc(`games/${gameId}/reaches/${uid}`);
  const currentBallIndex = revealed.length ? revealed[revealed.length - 1].ballIndex : 0;

  // 勝利条件到達済み(=クレーム対象)またはリーチ無しならリストから除去
  if (bingoLines.length >= winLines || reachCount === 0) {
    await reachRef.delete();
    return { status: bingoLines.length >= winLines ? 'bingo' : 'none' };
  }

  await reachRef.set({
    uid,
    nickname: card.nickname,
    reachLines: reachCount,
    lines: bingoLines.length,
    ballIndex: currentBallIndex,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { status: 'reach', reachLines: reachCount };
});
