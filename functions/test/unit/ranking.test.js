'use strict';

const {
  rankClaims,
  provisionalWinnerUids,
  deterministicShuffle,
  selectWinners,
} = require('../../src/lib/ranking');

// 決定論的な擬似乱数(テスト用)。ranking は rng の実体に依存しない。
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('lib/ranking', () => {
  describe('rankClaims', () => {
    test('competition ranking: 同 ballIndex は同順位 (1,1,3 形式)', () => {
      const ranked = rankClaims([
        { uid: 'c', achievedBallIndex: 40 },
        { uid: 'a', achievedBallIndex: 30 },
        { uid: 'b', achievedBallIndex: 30 },
      ]);
      expect(ranked.map((r) => [r.uid, r.rank])).toEqual([
        ['a', 1],
        ['b', 1],
        ['c', 3],
      ]);
    });

    test('同 ballIndex 内は uid 昇順で安定', () => {
      const ranked = rankClaims([
        { uid: 'zzz', achievedBallIndex: 10 },
        { uid: 'aaa', achievedBallIndex: 10 },
      ]);
      expect(ranked.map((r) => r.uid)).toEqual(['aaa', 'zzz']);
    });

    test('空配列', () => {
      expect(rankClaims([])).toEqual([]);
    });
  });

  describe('provisionalWinnerUids', () => {
    test('rank<=prizeCount を暫定当選(境界同着は全員)', () => {
      const ranked = rankClaims([
        { uid: 'a', achievedBallIndex: 30 },
        { uid: 'b', achievedBallIndex: 30 },
        { uid: 'c', achievedBallIndex: 30 },
        { uid: 'd', achievedBallIndex: 40 },
      ]);
      const winners = provisionalWinnerUids(ranked, 2);
      // a,b,c は全員 rank 1 なので prizeCount=2 でも全員暫定当選、d(rank4)は非当選
      expect(winners.has('a')).toBe(true);
      expect(winners.has('b')).toBe(true);
      expect(winners.has('c')).toBe(true);
      expect(winners.has('d')).toBe(false);
    });
  });

  describe('deterministicShuffle', () => {
    test('同じ rng 列なら同じ並び(決定論的)', () => {
      const a = deterministicShuffle([1, 2, 3, 4, 5], seqRng([0.1, 0.9, 0.3, 0.7]));
      const b = deterministicShuffle([1, 2, 3, 4, 5], seqRng([0.1, 0.9, 0.3, 0.7]));
      expect(a).toEqual(b);
      expect(a.sort()).toEqual([1, 2, 3, 4, 5]); // 要素は保存
    });

    test('入力配列を変更しない', () => {
      const input = [1, 2, 3];
      deterministicShuffle(input, seqRng([0.5]));
      expect(input).toEqual([1, 2, 3]);
    });
  });

  describe('selectWinners', () => {
    test('景品数内に収まるなら抽選なしで全員当選', () => {
      const ranked = rankClaims([
        { uid: 'a', achievedBallIndex: 30 },
        { uid: 'b', achievedBallIndex: 34 },
      ]);
      const { winnerUids, tieBreakApplied } = selectWinners(ranked, 3, seqRng([0.5]));
      expect(tieBreakApplied).toBe(false);
      expect([...winnerUids].sort()).toEqual(['a', 'b']);
    });

    test('境界の同着が景品数を超えると抽選が発動し、当選数は景品数ちょうど', () => {
      const ranked = rankClaims([
        { uid: 'a', achievedBallIndex: 30 },
        { uid: 'b', achievedBallIndex: 30 },
        { uid: 'c', achievedBallIndex: 30 },
        { uid: 'd', achievedBallIndex: 30 },
      ]);
      const { winnerUids, tieBreakApplied } = selectWinners(ranked, 3, seqRng([0.1, 0.5, 0.9]));
      expect(tieBreakApplied).toBe(true);
      expect(winnerUids.size).toBe(3);
    });

    test('抽選は決定論的(同じ seed 由来 rng なら同じ当選者)', () => {
      const ranked = rankClaims([
        { uid: 'a', achievedBallIndex: 30 },
        { uid: 'b', achievedBallIndex: 30 },
        { uid: 'c', achievedBallIndex: 30 },
        { uid: 'd', achievedBallIndex: 30 },
        { uid: 'e', achievedBallIndex: 30 },
      ]);
      const r1 = selectWinners(ranked, 2, seqRng([0.2, 0.8, 0.4, 0.6]));
      const r2 = selectWinners(ranked, 2, seqRng([0.2, 0.8, 0.4, 0.6]));
      expect([...r1.winnerUids].sort()).toEqual([...r2.winnerUids].sort());
    });

    test('上位が景品を埋めた後、下位グループは非当選', () => {
      const ranked = rankClaims([
        { uid: 'a', achievedBallIndex: 20 },
        { uid: 'b', achievedBallIndex: 25 },
        { uid: 'c', achievedBallIndex: 30 },
        { uid: 'd', achievedBallIndex: 30 },
      ]);
      const { winnerUids, tieBreakApplied } = selectWinners(ranked, 2, seqRng([0.5]));
      expect(tieBreakApplied).toBe(false);
      expect([...winnerUids].sort()).toEqual(['a', 'b']);
    });

    test('prizeCount=0 なら当選者なし', () => {
      const ranked = rankClaims([{ uid: 'a', achievedBallIndex: 10 }]);
      const { winnerUids } = selectWinners(ranked, 0, seqRng([0.5]));
      expect(winnerUids.size).toBe(0);
    });
  });
});
