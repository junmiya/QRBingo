'use strict';

/*
 * 順位付けと当選者選出の純粋ロジック(DB 非依存)。
 * 公平性の中核(憲章 I)。順位は achievedBallIndex(何球目で成立したか)
 * のみで決まり、申告時刻・通信順は一切関与しない。
 */

// claims: [{ uid, achievedBallIndex, ... }]
// achievedBallIndex 昇順で competition ranking(同値同順位・1,1,3 形式)を付与。
// 同値内の並びは uid 昇順で安定化(tie-break 抽選より前の決定論的順序)。
function rankClaims(claims) {
  const sorted = [...claims].sort(
    (a, b) =>
      a.achievedBallIndex - b.achievedBallIndex ||
      (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)
  );
  let rank = 0;
  let prevBall = null;
  return sorted.map((c, i) => {
    if (c.achievedBallIndex !== prevBall) {
      rank = i + 1;
      prevBall = c.achievedBallIndex;
    }
    return { ...c, rank };
  });
}

// 進行中の暫定当選者(rank <= prizeCount)。境界の同着は全員暫定当選扱い。
function provisionalWinnerUids(rankedClaims, prizeCount) {
  const set = new Set();
  for (const c of rankedClaims) if (c.rank <= prizeCount) set.add(c.uid);
  return set;
}

// Fisher-Yates(rng は [0,1) を返す関数)。入力を変更せず新配列を返す。
function deterministicShuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 確定当選者を選ぶ。景品数 prizeCount を上位から埋め、境界の同着グループが
// 景品数を超える場合のみ rng で決定論的に抽選(FR-009)。
// rankedClaims は rankClaims の出力(achievedBallIndex 昇順)であること。
function selectWinners(rankedClaims, prizeCount, rng) {
  const winnerUids = new Set();
  let tieBreakApplied = false;
  let remaining = prizeCount;
  let i = 0;
  while (i < rankedClaims.length && remaining > 0) {
    let j = i;
    while (
      j < rankedClaims.length &&
      rankedClaims[j].achievedBallIndex === rankedClaims[i].achievedBallIndex
    ) {
      j++;
    }
    const group = rankedClaims.slice(i, j);
    if (group.length <= remaining) {
      group.forEach((c) => winnerUids.add(c.uid));
      remaining -= group.length;
    } else {
      // 同着が景品数を超過 → 抽選(記録された tieBreakSeed により後から検証可能)
      tieBreakApplied = true;
      deterministicShuffle(group, rng)
        .slice(0, remaining)
        .forEach((c) => winnerUids.add(c.uid));
      remaining = 0;
    }
    i = j;
  }
  return { winnerUids, tieBreakApplied };
}

module.exports = { rankClaims, provisionalWinnerUids, deterministicShuffle, selectWinners };
