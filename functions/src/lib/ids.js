'use strict';

const crypto = require('crypto');

// js/common.js の ID_ALPHABET と同一(紛らわしい 0/O/1/I/L を除外)
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomIdFromAlphabet(len, alphabet) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function newGameId() {
  return randomIdFromAlphabet(4, ID_ALPHABET);
}

function newCardSeedSuffix() {
  return randomIdFromAlphabet(6, ID_ALPHABET);
}

// 9文字 × log2(31) ≈ 44.6bit ("≥40bit" 要件 FR-010 に余裕を持って適合)
function newWinCode() {
  return 'WIN-' + randomIdFromAlphabet(9, ID_ALPHABET);
}

module.exports = { ID_ALPHABET, randomIdFromAlphabet, newGameId, newCardSeedSuffix, newWinCode };
