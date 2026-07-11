// QRBingo v2 (オンラインモード) — ホスト画面ロジック
import { ensureSignedIn, callable, watchGame } from './firebase-init.js';

const $ = (id) => document.getElementById(id);
const CURRENT_KEY = 'qrbingo:online:host:current';

const createGameFn = callable('createGame');
const startGameFn = callable('startGame');
const drawNumberFn = callable('drawNumber');

const BALL_COLORS = ['var(--col-b)', 'var(--col-i)', 'var(--col-n)', 'var(--col-g)', 'var(--col-o)'];
const ballColor = (n) => BALL_COLORS[Math.floor((n - 1) / 15)];

let gameId = null;
let unwatch = null;
let drawing = false;
let lastRenderedBallIndex = 0;
let latestDrawsCount = 0;

function showPanel(name) {
  for (const p of ['create-panel', 'lobby-panel', 'playing-panel']) {
    $(p).hidden = p !== name;
  }
}

function parseOptionalInt(value) {
  const v = String(value || '').trim();
  return v === '' ? undefined : Number(v);
}

// ---------- ゲーム作成 ----------
async function handleCreate() {
  $('create-error').textContent = '';
  $('create-btn').disabled = true;
  try {
    const res = await createGameFn({
      winLines: parseOptionalInt($('in-winlines').value),
      capacity: parseOptionalInt($('in-capacity').value) ?? null,
      prizeCount: parseOptionalInt($('in-prizes').value),
      allowDuplicateCards: $('in-allowdup').checked,
    });
    gameId = res.gameId;
    QRB.saveJSON(CURRENT_KEY, { gameId });
    attachWatcher();
  } catch (err) {
    $('create-error').textContent = err.message || String(err);
  } finally {
    $('create-btn').disabled = false;
  }
}

// ---------- 進行描画 ----------
function renderBall(n) {
  const ball = $('current-ball');
  if (n == null) {
    ball.className = 'ball empty';
    ball.innerHTML = '<span class="ball-number">?</span>';
    return;
  }
  ball.className = 'ball pop';
  ball.style.setProperty('--ball-color', ballColor(n));
  ball.innerHTML =
    '<span class="ball-letter">' + QRB.columnLetter(n) + '</span>' +
    '<span class="ball-number">' + n + '</span>';
  setTimeout(() => ball.classList.remove('pop'), 500);
}

function renderHistory(draws) {
  const box = $('history');
  box.innerHTML = '';
  draws.forEach((d, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip' + (i === draws.length - 1 ? ' latest' : '');
    chip.style.setProperty('--ball-color', ballColor(d.n));
    chip.textContent = d.n;
    box.appendChild(chip);
  });
  $('count-note').textContent = draws.length ? `抽選済み: ${draws.length} / 75` : 'まだ抽選されていません';
  latestDrawsCount = draws.length;
  $('draw-btn').disabled = drawing || draws.length >= 75;
  $('draw-btn').textContent = draws.length >= 75 ? '全番号を抽選しました' : '抽選する!';
}

function renderGame(game) {
  if (!game) return;

  $('game-code').textContent = gameId;
  $('playing-game-code').textContent = gameId;
  $('participant-count').textContent = game.participantCount || 0;
  $('playing-count').textContent = game.participantCount || 0;

  if (game.status === 'lobby') {
    showPanel('lobby-panel');
    const url = new URL('player.html', location.href);
    url.searchParams.set('g', gameId);
    $('join-qr').innerHTML = QRB.qrSvg(url.toString(), 4);
    $('join-url').textContent = url.toString();
    const s = game.settings;
    $('lobby-settings').textContent =
      `勝利条件: ${s.winLines}ライン / 定員: ${s.capacity ?? '無制限'} / 景品数: ${s.prizeCount}` +
      (s.allowDuplicateCards ? ' / 同一カード許可' : '');
    return;
  }

  if (game.status === 'playing') {
    showPanel('playing-panel');
    const draws = game.draws || [];
    if (draws.length !== lastRenderedBallIndex) {
      lastRenderedBallIndex = draws.length;
      renderBall(draws.length ? draws[draws.length - 1].n : null);
    }
    renderHistory(draws);
    return;
  }

  // finished / expired (Phase 2/3 で本格対応)
  showPanel('playing-panel');
  $('draw-btn').disabled = true;
  $('draw-btn').textContent = 'ゲーム終了';
}

function attachWatcher() {
  if (unwatch) unwatch();
  unwatch = watchGame(gameId, renderGame);
}

async function handleStart() {
  $('lobby-error').textContent = '';
  $('start-btn').disabled = true;
  try {
    await startGameFn({ gameId });
  } catch (err) {
    $('lobby-error').textContent = err.message || String(err);
  } finally {
    $('start-btn').disabled = false;
  }
}

async function handleDraw() {
  if (drawing) return;
  drawing = true;
  $('draw-btn').disabled = true;
  $('draw-error').textContent = '';
  try {
    await drawNumberFn({ gameId });
  } catch (err) {
    $('draw-error').textContent = err.message || String(err);
  } finally {
    drawing = false;
    // Firestore の onSnapshot 反映を待たずに、drawing フラグの変化だけで
    // ボタンの有効・無効を確定する(スナップショット到着が drawing=false への
    // 復帰より先行すると、そのままボタンが無効固定されてしまうため)。
    $('draw-btn').disabled = latestDrawsCount >= 75;
  }
}

function handleReset() {
  if (!confirm('表示をリセットしますか?\n(進行中のゲーム自体は継続され、参加者には影響しません)')) return;
  if (unwatch) unwatch();
  gameId = null;
  lastRenderedBallIndex = 0;
  localStorage.removeItem(CURRENT_KEY);
  $('create-error').textContent = '';
  showPanel('create-panel');
}

// ---------- イベント登録 ----------
$('create-btn').addEventListener('click', handleCreate);
$('start-btn').addEventListener('click', handleStart);
$('draw-btn').addEventListener('click', handleDraw);
$('reset-btn').addEventListener('click', handleReset);

// ---------- 初期化 ----------
(async () => {
  await ensureSignedIn();
  $('conn-status').hidden = true;

  const saved = QRB.loadJSON(CURRENT_KEY, null);
  if (saved && saved.gameId) {
    gameId = saved.gameId;
    attachWatcher();
  } else {
    showPanel('create-panel');
  }
})();
