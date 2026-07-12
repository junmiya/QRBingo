'use strict';

const { FieldValue } = require('firebase-admin/firestore');
const { db } = require('../admin');
const { rngFromString } = require('./bingo');
const { rankClaims, provisionalWinnerUids, selectWinners } = require('./ranking');

const HIDDEN_LABEL = '(非表示)';
const UNKNOWN_LABEL = '(不明)';

// 指定ゲームの verified クレームを取得(gameId 単一等価フィルタのみ →
// 複合インデックス不要。status は取得後にメモリでフィルタ)。
async function fetchVerifiedClaims(gameId) {
  const snap = await db.collection('claims').where('gameId', '==', gameId).get();
  return snap.docs.map((d) => d.data()).filter((c) => c.status === 'verified');
}

// uid → card データのマップ(ニックネーム・非表示フラグ用)。
async function fetchCards(gameId, uids) {
  if (uids.length === 0) return {};
  const refs = uids.map((u) => db.doc(`cards/${gameId}_${u}`));
  const snaps = await db.getAll(...refs);
  const map = {};
  for (const s of snaps) if (s.exists) map[s.data().uid] = s.data();
  return map;
}

// 確定済みゲームの当選者集合を tieBreakSeed から決定論的に再現する
// (public leaderboard の isWinner を results と一致させるため)。
function finalWinnerUids(rankedClaims, prizeCount, tieBreakSeed, gameId) {
  const rng = rngFromString(`tiebreak:${gameId}:${tieBreakSeed}`);
  return selectWinners(rankedClaims, prizeCount, rng).winnerUids;
}

// 公開ランキング(games/{id}/public/leaderboard)を現在の状態から再構築する。
// - playing: 暫定順位(rank<=prizeCount を暫定当選)
// - finished: private/results の tieBreakSeed から確定当選者を再現し反映
// ニックネームは nicknameHidden なら伏字化。当選コードは一切含めない。
async function rebuildPublicLeaderboard(gameId) {
  const [gameSnap, claims] = await Promise.all([
    db.doc(`games/${gameId}`).get(),
    fetchVerifiedClaims(gameId),
  ]);
  if (!gameSnap.exists) return;
  const game = gameSnap.data();
  const prizeCount = game.settings.prizeCount;

  const ranked = rankClaims(
    claims.map((c) => ({ uid: c.uid, achievedBallIndex: c.achievedBallIndex }))
  );
  const cards = await fetchCards(gameId, ranked.map((c) => c.uid));

  let winnerUids;
  let tieBreakSeed = null;
  if (game.status === 'finished') {
    const resultsSnap = await db.doc(`games/${gameId}/private/results`).get();
    tieBreakSeed = resultsSnap.exists ? resultsSnap.data().tieBreakSeed : null;
    winnerUids = tieBreakSeed
      ? finalWinnerUids(ranked, prizeCount, tieBreakSeed, gameId)
      : provisionalWinnerUids(ranked, prizeCount);
  } else {
    winnerUids = provisionalWinnerUids(ranked, prizeCount);
  }

  const entries = ranked.map((c) => {
    const card = cards[c.uid] || {};
    return {
      uid: c.uid,
      rank: c.rank,
      nickname: card.nicknameHidden ? HIDDEN_LABEL : card.nickname || UNKNOWN_LABEL,
      achievedBallIndex: c.achievedBallIndex,
      isWinner: winnerUids.has(c.uid),
    };
  });

  await db.doc(`games/${gameId}/public/leaderboard`).set({
    entries,
    tieBreakSeed,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// 暫定順位(competition rank)を1人分だけ算出。verified クレームのうち
// achievedBallIndex が厳密に小さい件数 + 1。
async function provisionalRankOf(gameId, achievedBallIndex) {
  const claims = await fetchVerifiedClaims(gameId);
  const better = claims.filter((c) => c.achievedBallIndex < achievedBallIndex).length;
  return better + 1;
}

module.exports = {
  fetchVerifiedClaims,
  fetchCards,
  rebuildPublicLeaderboard,
  provisionalRankOf,
  HIDDEN_LABEL,
  UNKNOWN_LABEL,
};
