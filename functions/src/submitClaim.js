'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./admin');
const { generateCard, evaluateCard, findAchievedBallIndex } = require('./lib/bingo');
const { rebuildLeaderboardThrottled } = require('./lib/leaderboardService');
const { appendFeed } = require('./lib/feed');

// 公開済み(revealAt <= now)の抽選のみを ballIndex 昇順に並べて返す。
// 公開ディレイ中の番号は判定に使わない(先読みビンゴを防ぐ)。
function revealedDrawsInOrder(draws) {
  const now = Date.now();
  return (draws || [])
    .filter((d) => d.revealAt.toMillis() <= now)
    .sort((a, b) => a.ballIndex - b.ballIndex);
}

exports.submitClaim = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const uid = request.auth.uid;
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const cardId = `${gameId}_${uid}`;
  const claimId = cardId;

  const [gameSnap, cardSnap, claimSnap] = await Promise.all([
    db.doc(`games/${gameId}`).get(),
    db.doc(`cards/${cardId}`).get(),
    db.doc(`claims/${claimId}`).get(),
  ]);

  if (!gameSnap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  if (!cardSnap.exists) throw new HttpsError('not-found', 'このゲームに参加していません');

  const game = gameSnap.data();
  if (game.status === 'lobby') {
    throw new HttpsError('failed-precondition', 'ゲームがまだ開始されていません');
  }

  // 既に verified なら再計算しない(冪等・FR-008)。最初に成立した ball index は
  // 以降の抽選で変わらないため、保存済みの値をそのまま返す。順位は leaderboard 購読で反映。
  if (claimSnap.exists && claimSnap.data().status === 'verified') {
    const existing = claimSnap.data();
    return {
      status: 'verified',
      achievedBallIndex: existing.achievedBallIndex,
      lines: existing.lines,
    };
  }

  if (game.status === 'finished' || game.status === 'expired') {
    throw new HttpsError('failed-precondition', 'ゲームは終了しました');
  }

  // サーバー権威の検証: クライアントからは gameId のみ受け取り、グリッドは
  // 保存済みシードから再計算する(SC-003 改竄クレーム対策)。
  const card = cardSnap.data();
  const grid = generateCard(card.seed);
  const winLines = game.settings.winLines;

  const revealed = revealedDrawsInOrder(game.draws);
  const numbers = revealed.map((d) => d.n);
  const pos = findAchievedBallIndex(grid, numbers, winLines);

  if (pos == null) {
    return { status: 'rejected', reason: 'lines_not_met' };
  }

  // pos は「公開済み抽選列の何番目で成立したか」。実際の ball index は
  // その位置の draw の ballIndex(公開ディレイでギャップがあっても正しい)。
  const achievedBallIndex = revealed[pos - 1].ballIndex;
  const lines = evaluateCard(grid, new Set(numbers.slice(0, pos))).bingoLines.length;

  await db.doc(`claims/${claimId}`).set({
    gameId,
    cardId,
    uid,
    status: 'verified',
    achievedBallIndex,
    lines,
    verifiedAt: FieldValue.serverTimestamp(),
  });

  // ビンゴ成立者はホストのリーチリストから外す(存在しなくても no-op)
  await db.doc(`games/${gameId}/reaches/${uid}`).delete();

  // 全員にビンゴをアナウンス(演出・順位には無関係)
  await appendFeed(gameId, {
    type: 'bingo',
    nickname: card.nickname,
    ballIndex: achievedBallIndex,
  });

  // ランキング再構築はスロットリング(大人数時のコスト削減)。
  // プレイヤーの順位は leaderboard 購読で数秒以内に反映されるため、
  // ここで O(N) の順位計算は行わない(順位は submitClaim の戻り値に含めない)。
  await rebuildLeaderboardThrottled(gameId);

  return { status: 'verified', achievedBallIndex, lines };
});
