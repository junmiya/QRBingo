'use strict';

/*
 * ニックネームの構造検証と最低限の NG ワードフィルタ。
 * DEFAULT_NG_WORDS はホストなりすまし防止のための最小セットであり、
 * 実運用では運営側で言語・地域に応じたブロックリストに差し替える想定
 * (第二引数で上書き可能)。
 */

const MAX_LEN = 12;
const MIN_LEN = 1;

const DEFAULT_NG_WORDS = ['admin', 'administrator', '運営', 'ホスト', 'host', 'staff'];

function normalize(s) {
  return s.normalize('NFKC').trim();
}

// 制御文字(0x00-0x1F, 0x7F)の混入を検出する。ソースファイルに生の
// 制御バイトを埋め込まずに済むよう、文字コード比較で判定する。
function containsControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateNickname(raw, ngWords) {
  const words = ngWords || DEFAULT_NG_WORDS;
  const nickname = normalize(String(raw == null ? '' : raw));

  if (nickname.length < MIN_LEN || nickname.length > MAX_LEN) {
    return { ok: false, reason: 'length' };
  }
  if (containsControlChar(nickname)) {
    return { ok: false, reason: 'control_chars' };
  }
  const lower = nickname.toLowerCase();
  if (words.some((w) => lower.includes(w.toLowerCase()))) {
    return { ok: false, reason: 'ng_word' };
  }
  return { ok: true, nickname };
}

module.exports = { validateNickname, DEFAULT_NG_WORDS, MAX_LEN, MIN_LEN };
