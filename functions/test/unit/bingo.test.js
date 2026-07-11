'use strict';

const { generateCard, evaluateCard, findAchievedBallIndex, FREE, COLUMNS } = require('../../src/lib/bingo');

describe('lib/bingo (synced from js/common.js @shared block)', () => {
  test('generateCard is deterministic and case-insensitive on seed', () => {
    const a = generateCard('TEST-ABC123');
    const b = generateCard('test-abc123');
    expect(a).toEqual(b);
  });

  test('generateCard differs across seeds', () => {
    const a = generateCard('TEST-AAAAAA');
    const b = generateCard('TEST-BBBBBB');
    expect(a).not.toEqual(b);
  });

  test('each column stays within its 15-number range; center is FREE', () => {
    const grid = generateCard('RANGE-CHECK1');
    for (let col = 0; col < 5; col++) {
      for (let row = 0; row < 5; row++) {
        if (col === 2 && row === 2) {
          expect(grid[col][row]).toBe(FREE);
          continue;
        }
        expect(grid[col][row]).toBeGreaterThanOrEqual(col * 15 + 1);
        expect(grid[col][row]).toBeLessThanOrEqual(col * 15 + 15);
      }
    }
  });

  test('findAchievedBallIndex returns null when draws is empty', () => {
    const grid = generateCard('NEVER-BINGO1');
    expect(findAchievedBallIndex(grid, [], 1)).toBeNull();
  });

  test('findAchievedBallIndex matches evaluateCard at the achieved ball index', () => {
    const grid = generateCard('MATCH-CHECK1');
    const draws = Array.from({ length: 75 }, (_, i) => i + 1); // 全球抽選(必ず成立)

    const achieved = findAchievedBallIndex(grid, draws, 1);
    expect(achieved).not.toBeNull();

    const at = evaluateCard(grid, new Set(draws.slice(0, achieved)));
    expect(at.bingoLines.length).toBeGreaterThanOrEqual(1);

    const before = evaluateCard(grid, new Set(draws.slice(0, achieved - 1)));
    expect(before.bingoLines.length).toBe(0);
  });

  test('COLUMNS is B I N G O', () => {
    expect(COLUMNS).toEqual(['B', 'I', 'N', 'G', 'O']);
  });
});
