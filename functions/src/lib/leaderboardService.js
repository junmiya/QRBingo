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

// ---- スロットリング(大人数時のコスト最適化) ----
// クレームのたびに全クレーム+全カードを読んで再構築(O(N))し、全員へ配信すると
// 1ゲームで O(N^2) の読み取りが発生する(1000人で数百万リード)。
// これを「一定間隔に最大1回だけ再構築」に制限し、コストを O(時間/間隔 × N) に抑える。
// 取りこぼした最後のクレームは drawNumber 後の flush と finishGame の force で必ず反映される。
const LEADERBOARD_THROTTLE_MS = 3000;

// スロットリング付き再構築。force=true なら即時、そうでなければ前回から
// LEADERBOARD_THROTTLE_MS 以上経過している場合のみ再構築し、未満なら dirty フラグだけ立てる。
async function rebuildLeaderboardThrottled(gameId, opts = {}) {
  if (opts.force) {
    await rebuildPublicLeaderboard(gameId);
    await db.doc(`games/${gameId}`).set({ leaderboardDirty: false }, { merge: true });
    return true;
  }
  const lbSnap = await db.doc(`games/${gameId}/public/leaderboard`).get();
  const last =
    lbSnap.exists && lbSnap.data().updatedAt ? lbSnap.data().updatedAt.toMillis() : 0;
  if (Date.now() - last >= LEADERBOARD_THROTTLE_MS) {
    await rebuildPublicLeaderboard(gameId);
    await db.doc(`games/${gameId}`).set({ leaderboardDirty: false }, { merge: true });
    return true;
  }
  // まだ間隔内。再構築は見送り、保留中であることだけ記録(安価な単一フィールド書き込み)。
  await db.doc(`games/${gameId}`).set({ leaderboardDirty: true }, { merge: true });
  return false;
}

// 保留中(dirty)の leaderboard を確定反映する。drawNumber 後に呼び、
// スロットリングで見送られた末尾のクレームを次の抽選のタイミングで反映させる。
async function flushLeaderboardIfDirty(gameId) {
  const gameSnap = await db.doc(`games/${gameId}`).get();
  if (!gameSnap.exists || !gameSnap.data().leaderboardDirty) return false;
  await rebuildPublicLeaderboard(gameId);
  await db.doc(`games/${gameId}`).set({ leaderboardDirty: false }, { merge: true });
  return true;
}

module.exports = {
  fetchVerifiedClaims,
  fetchCards,
  rebuildPublicLeaderboard,
  rebuildLeaderboardThrottled,
  flushLeaderboardIfDirty,
  HIDDEN_LABEL,
  UNKNOWN_LABEL,
};
