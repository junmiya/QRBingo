'use strict';

const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('./admin');
const { rngFromString } = require('./lib/bingo');
const { rankClaims, markTies, selectWinners } = require('./lib/ranking');
const {
  fetchVerifiedClaims,
  fetchCards,
  rebuildPublicLeaderboard,
} = require('./lib/leaderboardService');
const { newWinCode } = require('./lib/ids');

exports.finishGame = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const uid = request.auth.uid;
  const gameId = String((request.data && request.data.gameId) || '').trim().toUpperCase();
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId が必要です');

  const gameRef = db.doc(`games/${gameId}`);

  // 1) playing → finished をトランザクションで確定(二重終了・非ホストを排除)。
  //    先に status を確定させることで、以降の submitClaim を締め切り、
  //    クレーム集合を凍結してから集計する。
  const settings = await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
    const game = snap.data();
    if (game.hostUid !== uid) throw new HttpsError('permission-denied', 'ホストのみ操作できます');
    if (game.status !== 'playing') {
      throw new HttpsError('failed-precondition', 'playing 状態のゲームのみ終了できます');
    }
    tx.update(gameRef, { status: 'finished', finishedAt: FieldValue.serverTimestamp() });
    return game.settings;
  });

  const prizeCount = settings.prizeCount;

  // 2) 凍結済みクレームを集計。順位は achievedBallIndex 昇順(同値同順位)。
  const claims = await fetchVerifiedClaims(gameId);
  const ranked = markTies(
    rankClaims(
      claims.map((c) => ({ uid: c.uid, achievedBallIndex: c.achievedBallIndex, cardId: c.cardId }))
    )
  );

  // 3) 景品数を超える同着は tieBreakSeed による決定論的抽選で確定(FR-009)。
  const tieBreakSeed = crypto.randomBytes(16).toString('hex');
  const rng = rngFromString(`tiebreak:${gameId}:${tieBreakSeed}`);
  const { winnerUids, tieBreakApplied } = selectWinners(ranked, prizeCount, rng);

  const cards = await fetchCards(gameId, ranked.map((c) => c.uid));

  // 4) winners ドキュメント(当人が読む)と private/results(ホストが読む)を書き込む。
  const batch = db.batch();
  const resultEntries = [];
  const responseWinners = [];

  for (const c of ranked) {
    const card = cards[c.uid] || {};
    const nickname = card.nickname || '(不明)';
    const isWinner = winnerUids.has(c.uid);
    let winCode = null;

    if (isWinner) {
      winCode = newWinCode();
      batch.set(db.doc(`winners/${gameId}_${c.uid}`), {
        gameId,
        uid: c.uid,
        cardId: c.cardId,
        rank: c.rank,
        winCode,
        handled: false,
        createdAt: FieldValue.serverTimestamp(),
      });
      responseWinners.push({
        rank: c.rank,
        uid: c.uid,
        nickname,
        winCode,
        achievedBallIndex: c.achievedBallIndex,
      });
    }

    resultEntries.push({
      uid: c.uid,
      rank: c.rank,
      nickname, // ホスト用: 伏字化しない(モデレーション判断のため)
      nicknameHidden: !!card.nicknameHidden,
      achievedBallIndex: c.achievedBallIndex,
      tied: c.tied, // 同着(同じ球目)。景品数を超える場合は抽選で当落が決まる
      isWinner,
      winCode, // 当選者のみ。ホストが照合に使う
      handled: false,
    });
  }

  // private/results: ホストのみ読取可(rules)。当選コード・実ニックネームを保持。
  batch.set(db.doc(`games/${gameId}/private/results`), {
    entries: resultEntries,
    prizeCount,
    tieBreakSeed,
    tieBreakApplied,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();

  // 5) 公開ランキングを確定内容で再構築(tieBreakSeed から当選者を再現)。
  await rebuildPublicLeaderboard(gameId);

  return {
    winners: responseWinners.sort((a, b) => a.rank - b.rank),
    tieBreakApplied,
    tieBreakSeed,
    totalClaims: ranked.length,
  };
});
