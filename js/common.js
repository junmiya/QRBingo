'use strict';

/* =========================================================
 * QRBingo 共通ロジック
 * カードはカードID文字列から決定論的に生成されるため、
 * サーバー無しでもホスト側で同じカードを再現して検証できる。
 *
 * 下記の @shared ブロックは functions/scripts/sync-lib.js が
 * 抽出し、functions/src/lib/bingo.js として Cloud Functions 側にも
 * 配布される「単一ソース」。ブラウザ専用 API
 * (crypto.getRandomValues, localStorage 等) を持ち込まないこと。
 * 変更したら functions 側で `npm run sync-lib` を実行して同期する。
 * ========================================================= */

/* @shared:start */
const QRB_SHARED = (() => {

  // ---- 文字列 → シード (cyrb128) ----
  function cyrb128(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
  }

  // ---- 乱数生成器 (mulberry32) ----
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rngFromString(str) {
    const s = cyrb128(str);
    return mulberry32(s[0] ^ s[1] ^ s[2]);
  }

  // ---- ビンゴカード ----
  const COLUMNS = ['B', 'I', 'N', 'G', 'O'];
  const FREE = 0;

  function columnLetter(n) {
    return COLUMNS[Math.floor((n - 1) / 15)];
  }

  // cardId から 5x5 カードを生成。grid[col][row]、中央は FREE(0)。
  function generateCard(cardId) {
    const rng = rngFromString('qrbingo-card:' + String(cardId).trim().toUpperCase());
    const grid = [];
    for (let col = 0; col < 5; col++) {
      const pool = [];
      for (let i = 1; i <= 15; i++) pool.push(col * 15 + i);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      grid.push(pool.slice(0, 5));
    }
    grid[2][2] = FREE;
    return grid;
  }

  // 全12ライン(縦5・横5・斜め2)。各ラインは {col,row} の配列。
  function allLines() {
    const lines = [];
    for (let col = 0; col < 5; col++) {
      lines.push(Array.from({ length: 5 }, (_, row) => ({ col, row })));
    }
    for (let row = 0; row < 5; row++) {
      lines.push(Array.from({ length: 5 }, (_, col) => ({ col, row })));
    }
    lines.push(Array.from({ length: 5 }, (_, i) => ({ col: i, row: i })));
    lines.push(Array.from({ length: 5 }, (_, i) => ({ col: i, row: 4 - i })));
    return lines;
  }

  const LINES = allLines();

  // markedSet: マーク済みとみなす番号の Set(FREE は常にマーク扱い)
  function evaluateCard(grid, markedSet) {
    const isMarked = (c) => grid[c.col][c.row] === FREE || markedSet.has(grid[c.col][c.row]);
    const bingoLines = [];
    let reachCount = 0;
    for (const line of LINES) {
      const hit = line.filter(isMarked).length;
      if (hit === 5) bingoLines.push(line);
      else if (hit === 4) reachCount++;
    }
    return { bingoLines, reachCount };
  }

  // ball index(何球目か)の配列から、winLines 本のラインが最初に揃う
  // 時点の ball index を返す。揃わない場合は null。
  // draws: 抽選順に並んだ番号の配列(draws[i] は i+1 球目)
  function findAchievedBallIndex(grid, draws, winLines) {
    const marked = new Set();
    for (let i = 0; i < draws.length; i++) {
      marked.add(draws[i]);
      const { bingoLines } = evaluateCard(grid, marked);
      if (bingoLines.length >= winLines) return i + 1;
    }
    return null;
  }

  return {
    FREE, COLUMNS, LINES,
    rngFromString, columnLetter,
    generateCard, evaluateCard, findAchievedBallIndex,
  };
})();
/* @shared:end */

const QRB = (() => {
  const {
    FREE, COLUMNS, LINES,
    rngFromString, columnLetter,
    generateCard, evaluateCard, findAchievedBallIndex,
  } = QRB_SHARED;

  // ---- ID 生成(紛らわしい文字 0/O/1/I/L を除外)----
  const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function randomId(len) {
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    let out = '';
    for (let i = 0; i < len; i++) out += ID_ALPHABET[buf[i] % ID_ALPHABET.length];
    return out;
  }

  // ---- QR コード SVG 生成 ----
  function qrSvg(text, cellSize) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: cellSize || 4, margin: 2, scalable: true });
  }

  // ---- localStorage ヘルパー ----
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  return {
    FREE, COLUMNS, LINES,
    rngFromString, randomId, columnLetter,
    generateCard, evaluateCard, findAchievedBallIndex, qrSvg,
    loadJSON, saveJSON,
  };
})();
