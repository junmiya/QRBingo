// QRBingo v2 (オンラインモード) — ホスト画面ロジック
import {
  ONLINE_AVAILABLE,
  ensureSignedIn,
  callable,
  watchGame,
  watchDocPath,
} from './firebase-init.js';

const $ = (id) => document.getElementById(id);
const CURRENT_KEY = 'qrbingo:online:host:current';

const createGameFn = callable('createGame');
const startGameFn = callable('startGame');
const drawNumberFn = callable('drawNumber');
const finishGameFn = callable('finishGame');
const hideNicknameFn = callable('hideNickname');
const markWinnerHandledFn = callable('markWinnerHandled');

const BALL_COLORS = ['var(--col-b)', 'var(--col-i)', 'var(--col-n)', 'var(--col-g)', 'var(--col-o)'];
const ballColor = (n) => BALL_COLORS[Math.floor((n - 1) / 15)];

let gameId = null;
let unwatch = null;
let unwatchLeaderboard = null;
let unwatchResults = null;
let drawing = false;
let finishing = false;
let gameStatus = null;
let lastRenderedBallIndex = 0;
let latestDrawsCount = 0;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

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
  gameStatus = game.status;

  $('game-code').textContent = gameId;
  $('playing-game-code').textContent = gameId;
  $('participant-count').textContent = game.participantCount || 0;
  $('playing-count').textContent = game.participantCount || 0;

  if (game.status === 'lobby') {
    showPanel('lobby-panel');
    $('ranking-panel').hidden = true;
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
    $('finish-btn').hidden = false;
    $('finish-btn').disabled = finishing;
    const draws = game.draws || [];
    if (draws.length !== lastRenderedBallIndex) {
      lastRenderedBallIndex = draws.length;
      renderBall(draws.length ? draws[draws.length - 1].n : null);
    }
    renderHistory(draws);
    return;
  }

  // finished / expired
  showPanel('playing-panel');
  $('finish-btn').hidden = true;
  renderHistory(game.draws || []);
  $('draw-btn').disabled = true;
  $('draw-btn').textContent = game.status === 'finished' ? 'ゲーム終了(順位確定済み)' : 'ゲーム終了';
}

function attachWatcher() {
  if (unwatch) unwatch();
  unwatch = watchGame(gameId, renderGame);
  // 進行中は暫定ランキング(公開 leaderboard)を購読
  if (unwatchLeaderboard) unwatchLeaderboard();
  unwatchLeaderboard = watchDocPath(['games', gameId, 'public', 'leaderboard'], onLeaderboard);
  // 終了後は確定結果(private/results・当選コード込み)を購読
  if (unwatchResults) unwatchResults();
  unwatchResults = watchDocPath(['games', gameId, 'private', 'results'], onResults);
}

// ---------- ランキング描画 ----------
function onLeaderboard(lb) {
  // 確定結果(results)が来ていれば優先。進行中のみ暫定を描画。
  if (gameStatus === 'finished') return;
  if (!lb || !lb.entries || lb.entries.length === 0) {
    $('ranking-panel').hidden = true;
    return;
  }
  $('ranking-panel').hidden = false;
  $('ranking-title').textContent = '📊 暫定ランキング';
  $('ranking-note').textContent = 'ゲーム終了時に順位・当選が確定します。';
  renderProvisional(lb.entries);
}

function onResults(results) {
  if (!results || !results.entries) return;
  $('ranking-panel').hidden = false;
  $('ranking-title').textContent = '🏆 確定ランキング';
  $('ranking-note').textContent = results.tieBreakApplied
    ? '同着があったため一部は抽選で決定しました(当選コードを当選者に照合してください)。'
    : '当選コードを当選者に照合して景品をお渡しください。';
  renderFinal(results.entries);
}

function renderProvisional(entries) {
  const rows = entries
    .map(
      (e) => `<tr class="${e.isWinner ? 'is-winner' : ''}">
        <td class="rank-col">${e.rank}</td>
        <td>${esc(e.nickname)}</td>
        <td>${e.achievedBallIndex}球目</td>
      </tr>`
    )
    .join('');
  $('ranking-body').innerHTML =
    `<table class="leaderboard"><thead><tr>
       <th>順位</th><th>ニックネーム</th><th>成立</th>
     </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderFinal(entries) {
  const rows = entries
    .map((e) => {
      const cardId = `${gameId}_${e.uid}`;
      const winCell = e.isWinner
        ? `<span class="wincode-cell">${esc(e.winCode)}</span>`
        : '<span class="hint">—</span>';
      const handleBtn = e.isWinner
        ? `<button data-action="handle" data-winner="${cardId}" data-handled="${e.handled ? '1' : '0'}">${e.handled ? '取消' : '対応済'}</button>`
        : '';
      const hideBtn = `<button data-action="hide" data-card="${cardId}" data-hidden="${e.nicknameHidden ? '1' : '0'}">${e.nicknameHidden ? '再表示' : '非表示'}</button>`;
      return `<tr class="${e.isWinner ? 'is-winner' : ''} ${e.handled ? 'handled' : ''}">
        <td class="rank-col">${e.rank}</td>
        <td>${esc(e.nickname)}${e.nicknameHidden ? ' <span class="hint">(伏字中)</span>' : ''}</td>
        <td>${e.achievedBallIndex}球目</td>
        <td>${winCell}</td>
        <td><div class="row-actions">${handleBtn}${hideBtn}</div></td>
      </tr>`;
    })
    .join('');
  $('ranking-body').innerHTML =
    `<table class="leaderboard"><thead><tr>
       <th>順位</th><th>ニックネーム</th><th>成立</th><th>当選コード</th><th></th>
     </tr></thead><tbody>${rows}</tbody></table>`;
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

async function handleFinish() {
  if (finishing) return;
  if (!confirm('ゲームを終了して順位を確定しますか?\nこの操作は取り消せません。')) return;
  finishing = true;
  $('finish-btn').disabled = true;
  $('draw-error').textContent = '';
  try {
    await finishGameFn({ gameId });
    // 結果は private/results の購読(onResults)で描画される
  } catch (err) {
    $('draw-error').textContent = err.message || String(err);
  } finally {
    finishing = false;
  }
}

// ランキング表内のボタン(対応済み・非表示)をイベント委譲で処理
async function handleRankingClick(ev) {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  btn.disabled = true;
  try {
    if (btn.dataset.action === 'handle') {
      await markWinnerHandledFn({
        gameId,
        winnerId: btn.dataset.winner,
        handled: btn.dataset.handled !== '1',
      });
    } else if (btn.dataset.action === 'hide') {
      await hideNicknameFn({
        gameId,
        cardId: btn.dataset.card,
        hidden: btn.dataset.hidden !== '1',
      });
    }
    // 変更は購読(onResults / onLeaderboard)で再描画される
  } catch (err) {
    alert(err.message || String(err));
    btn.disabled = false;
  }
}

function handleReset() {
  if (!confirm('表示をリセットしますか?\n(進行中のゲーム自体は継続され、参加者には影響しません)')) return;
  if (unwatch) unwatch();
  if (unwatchLeaderboard) unwatchLeaderboard();
  if (unwatchResults) unwatchResults();
  gameId = null;
  gameStatus = null;
  lastRenderedBallIndex = 0;
  localStorage.removeItem(CURRENT_KEY);
  $('create-error').textContent = '';
  $('ranking-panel').hidden = true;
  showPanel('create-panel');
}

// ---------- イベント登録 ----------
$('create-btn').addEventListener('click', handleCreate);
$('start-btn').addEventListener('click', handleStart);
$('draw-btn').addEventListener('click', handleDraw);
$('finish-btn').addEventListener('click', handleFinish);
$('ranking-body').addEventListener('click', handleRankingClick);
$('reset-btn').addEventListener('click', handleReset);

// ---------- 初期化 ----------
(async () => {
  if (!ONLINE_AVAILABLE) {
    $('conn-status').className = 'hint error-text';
    $('conn-status').innerHTML =
      'オンラインモードは Firebase の設定が必要です。' +
      'このサイトではまだ有効化されていません。<br>' +
      '<a href="../index.html">オフラインモード</a>は今すぐ利用できます。';
    return;
  }
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
