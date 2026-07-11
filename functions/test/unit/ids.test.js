'use strict';

const {
  randomIdFromAlphabet,
  newGameId,
  newCardSeedSuffix,
  newWinCode,
  ID_ALPHABET,
} = require('../../src/lib/ids');

describe('lib/ids', () => {
  test('newGameId produces 4 chars from the safe alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const id = newGameId();
      expect(id).toHaveLength(4);
      expect([...id].every((c) => ID_ALPHABET.includes(c))).toBe(true);
    }
  });

  test('newCardSeedSuffix produces 6 chars from the safe alphabet', () => {
    const id = newCardSeedSuffix();
    expect(id).toHaveLength(6);
    expect([...id].every((c) => ID_ALPHABET.includes(c))).toBe(true);
  });

  test('newWinCode has WIN- prefix and >=40bit entropy length', () => {
    const code = newWinCode();
    expect(code.startsWith('WIN-')).toBe(true);
    const body = code.slice(4);
    expect(body).toHaveLength(9);
    expect(Math.log2(ID_ALPHABET.length) * body.length).toBeGreaterThanOrEqual(40);
  });

  test('safe alphabet excludes ambiguous characters', () => {
    for (const ch of ['0', 'O', '1', 'I', 'L']) {
      expect(ID_ALPHABET.includes(ch)).toBe(false);
    }
  });

  test('randomIdFromAlphabet: many samples do not collide', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(randomIdFromAlphabet(8, ID_ALPHABET));
    expect(seen.size).toBe(200);
  });
});
