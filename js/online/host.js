// QRBingo v2 (オンラインモード) — ホスト画面ロジック
import {
  ONLINE_AVAILABLE,
  ensureSignedIn,
  onUser,
  callable,
  watchGame,
  watchMyGames,
  watchDocPath,
  watchCollectionPath,
} from './firebase-init.js';
import { watchAnnouncements, initChat, fmtCountdown } from './live-extras.js';
import { planSummary } from './plan.js';

const $ = (id) => document.getElementById(id);
const CURRENT_KEY = 'qrbingo:online:host:current';

const createGameFn = callable('createGame');
const setChatEnabledFn = callable('setChatEnabled');
const setCountdownFn = callable('setCountdown');
const cancelGameFn = callable('cancelGame');
const startGameFn = callable('startGame');
const drawNumberFn = callable('drawNumber');
const finishGameFn = callable('finishGame');
const hideNicknameFn = callable('hideNickname');
const markWinnerHandledFn = callable('markWinnerHandled');

const BALL_COLORS = ['var(--col-b)', 'var(--col-i)', 'var(--col-n)', 'var(--col-g)', 'var(--col-o)'];
const ballColor = (n) => BALL_COLORS[Math.floor((n - 1) / 15)];

let gameId = null;
let myUid = null;
let unwatchPlan = null;
let unwatchMyGames = null;
let unwatch = null;
let unwatchLeaderboard = null;
let unwatchResults = null;
let unwatchReaches = null;
let drawing = false;
let finishing = false;
let gameStatus = null;
let lastRenderedBallIndex = 0;
let latestDrawsCount = 0;
let latestReaches = [];
let announceStarted = false; // アナウンス購読は1回だけ
let chatUnwatch = null; // チャット購読(有効化時に開始)
let hostCountdownTimer = null; // ホスト側カウントダウン表示の更新
let chatCurrentlyEnabled = false;
let latestMyGames = []; // 主催したゲーム(進行中ゲームへの「戻る」バナー用)
let drawBtnVisible = true; // 抽選ボタンが画面内にあるか(ドック表示の判定)

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// ゲームタブは状態ごとに必要なパネルだけを出す。
// ゲームなし=作成 / lobby=参加受付 / playing=抽選+進行操作 / finished・expired=終了
function showPanel(name) {
  for (const p of ['create-panel', 'lobby-panel', 'playing-panel', 'finished-panel']) {
    $(p).hidden = p !== name;
  }
  $('ops-panel').hidden = name !== 'playing-panel';
  renderActiveBanner();
  syncDock();
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
      chatEnabled: $('in-chat').checked,
      countdownEnabled: $('in-countdown').checked,
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

// ---------- ライブ機能(チャット切替・カウントダウン) ----------
function updateLive(game) {
  const active = game.status === 'lobby' || game.status === 'playing';

  const chatEnabled = !!(game.settings && game.settings.chatEnabled);
  chatCurrentlyEnabled = chatEnabled;
  document.querySelectorAll('.chat-toggle').forEach((b) => {
    b.textContent = 'チャット: ' + (chatEnabled ? 'ON(タップでOFF)' : 'OFF(タップでON)');
  });

  // チャットパネル(進行中=lobby/playing かつ有効化時のみ表示・購読)。
  // finished/expired では隠して購読解除する(終了/中止後に送信して
  // 「ゲームは終了しました」エラーが出るのを防ぐ)。
  const showChat = chatEnabled && active;
  $('chat-panel').hidden = !showChat;
  if (showChat && !chatUnwatch) {
    chatUnwatch = initChat(gameId, {
      listEl: $('chat-list'),
      inputEl: $('chat-input'),
      sendBtn: $('chat-send'),
      errEl: $('chat-error'),
    });
  } else if (!active && chatUnwatch) {
    chatUnwatch();
    chatUnwatch = null;
  }

  // カウントダウン操作(作成時に有効化した場合のみ・ロビー中が主用途)
  const cdEnabled = !!(game.settings && game.settings.countdownEnabled);
  $('countdown-controls').hidden = !cdEnabled;
  const targetMs =
    game.countdownTarget && game.countdownTarget.toMillis ? game.countdownTarget.toMillis() : null;
  if (cdEnabled && targetMs && game.status === 'lobby') {
    const tick = () => {
      const remain = targetMs - Date.now();
      $('countdown-live').textContent =
        remain > 0 ? `開始まで ${fmtCountdown(remain)}(参加者にも表示中)` : 'まもなく開始!(「ゲームを開始」を押してください)';
    };
    tick();
    if (hostCountdownTimer) clearInterval(hostCountdownTimer);
    hostCountdownTimer = setInterval(tick, 250);
  } else {
    $('countdown-live').textContent = '';
    if (hostCountdownTimer) {
      clearInterval(hostCountdownTimer);
      hostCountdownTimer = null;
    }
  }
}

// ライブ操作のエラー表示先(ロビー中はロビー、進行中は進行操作パネル)
const liveErr = () => $(gameStatus === 'lobby' ? 'lobby-error' : 'ops-error');

async function handleChatToggle(ev) {
  const btn = ev.currentTarget;
  liveErr().textContent = '';
  btn.disabled = true;
  try {
    await setChatEnabledFn({ gameId, enabled: !chatCurrentlyEnabled });
  } catch (err) {
    liveErr().textContent = err.message || String(err);
  } finally {
    btn.disabled = false;
  }
}

async function handleCountdownStart() {
  liveErr().textContent = '';
  const seconds = parseInt($('countdown-sec').value, 10);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    liveErr().textContent = '秒は 1〜3600 で入力してください';
    return;
  }
  try {
    await setCountdownFn({ gameId, seconds });
  } catch (err) {
    liveErr().textContent = err.message || String(err);
  }
}

async function handleCountdownStop() {
  liveErr().textContent = '';
  try {
    await setCountdownFn({ gameId, seconds: 0 });
  } catch (err) {
    liveErr().textContent = err.message || String(err);
  }
}

// ---------- 進行中ゲームへ戻る ----------
function attachToGame(id) {
  gameId = id;
  QRB.saveJSON(CURRENT_KEY, { gameId });
  attachWatcher();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- 主催しているゲーム一覧(管理モード) ----------
const STATUS_LABEL = {
  lobby: '受付中',
  playing: '進行中',
  finished: '終了(順位確定)',
  expired: '中止',
};

function renderMyGames(games) {
  const panel = $('mygames-panel');
  latestMyGames = games || [];
  renderActiveBanner();
  const list = latestMyGames.slice().sort((a, b) => {
    const am = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const bm = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return bm - am; // 新しい順
  });
  if (list.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('mygames-count').textContent = list.length;
  const rows = list
    .map((g) => {
      const active = g.status === 'lobby' || g.status === 'playing';
      const label = STATUS_LABEL[g.status] || g.status;
      const back =
        active && g.id !== gameId ? `<button data-act="back" data-id="${g.id}">戻る</button>` : '';
      const end = active ? `<button data-act="end" data-id="${g.id}">中止</button>` : '';
      return `<tr class="${g.id === gameId ? 'is-winner' : ''}">
        <td><strong>${esc(g.id)}</strong></td>
        <td>${label}</td>
        <td>${g.participantCount || 0}人</td>
        <td><div class="row-actions">${back}${end}</div></td>
      </tr>`;
    })
    .join('');
  $('mygames-body').innerHTML =
    `<table class="leaderboard"><thead><tr>
       <th>コード</th><th>状態</th><th>参加</th><th></th>
     </tr></thead><tbody>${rows}</tbody></table>`;
}

// 表示していない進行中ゲームがあれば、ゲームタブ上部に「戻る」バナーを出す。
// (同時に主催できるのは1ゲームなので、通常は0か1件)
function renderActiveBanner() {
  const active = latestMyGames.find(
    (g) => (g.status === 'lobby' || g.status === 'playing') && g.id !== gameId
  );
  const banner = $('active-game-banner');
  if (!active || gameId) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.dataset.id = active.id;
  $('active-game-text').textContent =
    `${active.id}(${STATUS_LABEL[active.status]}・参加 ${active.participantCount || 0}人)`;
}

async function handleMyGamesClick(ev) {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === 'back') {
    attachToGame(id);
  } else if (btn.dataset.act === 'end') {
    if (!confirm(`ゲーム ${id} を終了(中止)しますか?\n順位は確定されず、参加者の画面も「終了」になります。`)) return;
    btn.disabled = true;
    try {
      await cancelGameFn({ gameId: id });
      // 一覧は購読で自動更新される。表示中のゲームなら画面もリセット。
      if (id === gameId) clearGameView();
    } catch (err) {
      alert(err.message || String(err));
      btn.disabled = false;
    }
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
  syncDock();
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
  syncDock();
}

// ---------- 抽選ドック ----------
// 抽選ボタンがスクロールで画面外に出たとき(ランキングやチャットを見ているとき)だけ、
// 画面下部に「直近の番号+抽選する!」を表示する。状態は本体の抽選ボタンに合わせる。
function syncDock() {
  const dock = $('draw-dock');
  const show = gameStatus === 'playing' && !drawBtnVisible;
  dock.hidden = !show;
  if (!show) return;
  const n = $('current-ball').querySelector('.ball-number');
  $('dock-ball').textContent = n ? n.textContent : '?';
  $('dock-count').textContent = `${latestDrawsCount} / 75`;
  $('dock-draw-btn').disabled = $('draw-btn').disabled;
  $('dock-draw-btn').textContent = $('draw-btn').textContent;
}

function renderGame(game) {
  if (!game) return;
  gameStatus = game.status;
  updateLive(game);

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

  // 投げ銭の集計(現時点ではすべて運営への応援)。件数があれば進行画面に表示する。
  const tipNote = $('tip-total-note');
  if (game.tipsEnabled && (game.tipCount || 0) > 0) {
    tipNote.hidden = false;
    const total = game.tipTotalAmount != null ? game.tipTotalAmount : game.tipTotalNet || 0;
    tipNote.textContent = `投げ銭(運営への応援): ${game.tipCount}件 / 合計 ¥${total.toLocaleString()}`;
  } else {
    tipNote.hidden = true;
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
    // 運営により一時停止中は抽選できない
    if (game.paused) {
      $('draw-btn').disabled = true;
      $('draw-btn').textContent = '一時停止中(運営)';
      $('draw-error').textContent = '運営により一時停止中です。再開までお待ちください。';
    } else if ($('draw-btn').textContent === '一時停止中(運営)') {
      $('draw-btn').textContent = '抽選する!';
      $('draw-error').textContent = '';
    }
    syncDock();
    return;
  }

  // finished / expired
  showPanel('finished-panel');
  renderReaches(); // 終了後はリーチ表示を畳む
  const drawn = (game.draws || []).length;
  if (game.status === 'finished') {
    $('finished-title').textContent = `ゲーム ${gameId} は終了しました(順位確定)`;
    $('finished-text').textContent =
      `抽選 ${drawn}球 / 参加 ${game.participantCount || 0}人。下の確定ランキングで当選コードを照合し、景品をお渡しください。`;
  } else {
    $('finished-title').textContent = `ゲーム ${gameId} は中止されました`;
    $('finished-text').textContent = `抽選 ${drawn}球 / 参加 ${game.participantCount || 0}人。順位は確定していません。`;
    $('ranking-panel').hidden = true;
  }
  $('finished-tips').hidden = tipNote.hidden;
  $('finished-tips').textContent = tipNote.textContent;
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
  // リーチ状況(演出用・進行中のみ表示)を購読
  if (unwatchReaches) unwatchReaches();
  unwatchReaches = watchCollectionPath(['games', gameId, 'reaches'], onReaches);
  // リーチ/ビンゴのアナウンスをホスト画面にも流す(1回だけ)
  if (!announceStarted) {
    announceStarted = true;
    watchAnnouncements(gameId);
  }
}

// ---------- リーチ状況 ----------
function onReaches(entries) {
  latestReaches = entries || [];
  renderReaches();
}

function renderReaches() {
  const panel = $('reach-panel');
  if (gameStatus !== 'playing' || latestReaches.length === 0) {
    panel.hidden = true;
    return;
  }
  // リーチ本数の多い順 → 早くリーチした順
  const sorted = [...latestReaches].sort(
    (a, b) => b.reachLines - a.reachLines || a.ballIndex - b.ballIndex
  );
  panel.hidden = false;
  $('reach-count').textContent = `${sorted.length}人`;
  const rows = sorted
    .map(
      (r) => `<tr>
        <td>${esc(r.nickname || '(不明)')}</td>
        <td>${r.reachLines}本</td>
        <td class="hint">${r.ballIndex}球目〜</td>
      </tr>`
    )
    .join('');
  $('reach-body').innerHTML =
    `<table class="leaderboard"><thead><tr>
       <th>ニックネーム</th><th>リーチ</th><th>時点</th>
     </tr></thead><tbody>${rows}</tbody></table>`;
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
  $('ranking-title').textContent = '暫定ランキング';
  const hasTie = lb.entries.some((e) => e.tied);
  $('ranking-note').textContent =
    'ゲーム終了時に順位・当選が確定します。' +
    (hasTie ? '「同率」は同じ球目でビンゴした同着です。景品数を超える場合は終了時に抽選で決まります。' : '');
  renderProvisional(lb.entries);
}

function onResults(results) {
  if (!results || !results.entries) return;
  $('ranking-panel').hidden = false;
  $('ranking-title').textContent = '確定ランキング';
  if (results.entries.length === 0) {
    $('ranking-note').textContent = 'ビンゴ成立者はいませんでした。';
    $('ranking-body').innerHTML = '';
    return;
  }
  $('ranking-note').textContent = results.tieBreakApplied
    ? '同着があったため一部は抽選で決定しました(当選コードを当選者に照合してください)。'
    : '当選コードを当選者に照合して景品をお渡しください。';
  renderFinal(results.entries);
}

// 同着(同じ球目でビンゴ)の表示。順位は同じで、景品数を超える場合のみ終了時に抽選。
function tieBadge(e) {
  return e.tied ? ' <span class="tie-badge">同率</span>' : '';
}

function renderProvisional(entries) {
  const rows = entries
    .map(
      (e) => `<tr class="${e.isWinner ? 'is-winner' : ''}">
        <td class="rank-col">${e.rank}${tieBadge(e)}</td>
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
        <td class="rank-col">${e.rank}${tieBadge(e)}</td>
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
    const res = await drawNumberFn({ gameId });
    // 抽選結果はレスポンスに含まれるので、スナップショット到着を待たずに
    // その場でボールを描画する(ホストの体感遅延をなくす)。
    // lastRenderedBallIndex を先に進めておくことで、直後のスナップショットで
    // 同じ球が二重にポップ演出されるのを防ぐ。
    if (res && typeof res.n === 'number' && res.ballIndex > lastRenderedBallIndex) {
      lastRenderedBallIndex = res.ballIndex;
      renderBall(res.n);
    }
  } catch (err) {
    $('draw-error').textContent = err.message || String(err);
  } finally {
    drawing = false;
    // Firestore の onSnapshot 反映を待たずに、drawing フラグの変化だけで
    // ボタンの有効・無効を確定する(スナップショット到着が drawing=false への
    // 復帰より先行すると、そのままボタンが無効固定されてしまうため)。
    $('draw-btn').disabled = latestDrawsCount >= 75;
    syncDock();
  }
}

async function handleFinish() {
  if (finishing) return;
  if (!confirm('ゲームを終了して順位を確定しますか?\nこの操作は取り消せません。')) return;
  finishing = true;
  $('finish-btn').disabled = true;
  $('ops-error').textContent = '';
  try {
    await finishGameFn({ gameId });
    // 結果は private/results の購読(onResults)で描画される
  } catch (err) {
    $('ops-error').textContent = err.message || String(err);
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

function clearGameView() {
  if (unwatch) unwatch();
  if (unwatchLeaderboard) unwatchLeaderboard();
  if (unwatchResults) unwatchResults();
  if (unwatchReaches) unwatchReaches();
  if (chatUnwatch) { chatUnwatch(); chatUnwatch = null; }
  if (hostCountdownTimer) { clearInterval(hostCountdownTimer); hostCountdownTimer = null; }
  announceStarted = false;
  gameId = null;
  gameStatus = null;
  lastRenderedBallIndex = 0;
  latestReaches = [];
  localStorage.removeItem(CURRENT_KEY);
  $('create-error').textContent = '';
  $('ranking-panel').hidden = true;
  $('reach-panel').hidden = true;
  $('chat-panel').hidden = true;
  showPanel('create-panel');
  renderMyGames(latestMyGames);
}

// ゲームを中止する(順位を出さずに終了)。ロビー・進行中どちらからでも可能。
async function handleCancel() {
  if (!gameId) return;
  if (!confirm('このゲームを中止しますか?\n順位は確定されず、参加者の画面も「終了」になります。\nこの操作は取り消せません。')) return;
  try {
    await cancelGameFn({ gameId });
    clearGameView();
  } catch (err) {
    const box = gameStatus === 'lobby' ? 'lobby-error' : 'ops-error';
    $(box).textContent = err.message || String(err);
  }
}

// ---------- イベント登録 ----------
$('create-btn').addEventListener('click', handleCreate);
$('start-btn').addEventListener('click', handleStart);
$('draw-btn').addEventListener('click', handleDraw);
$('finish-btn').addEventListener('click', handleFinish);
$('ranking-body').addEventListener('click', handleRankingClick);
$('new-game-btn').addEventListener('click', clearGameView);
$('dock-draw-btn').addEventListener('click', handleDraw);
$('active-game-back').addEventListener('click', () => {
  const id = $('active-game-banner').dataset.id;
  if (id) attachToGame(id);
});
if ('IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    drawBtnVisible = entries[entries.length - 1].isIntersecting;
    syncDock();
  }).observe($('draw-btn'));
}
$('cancel-lobby-btn').addEventListener('click', handleCancel);
$('cancel-playing-btn').addEventListener('click', handleCancel);
$('mygames-body').addEventListener('click', handleMyGamesClick);
document.querySelectorAll('.chat-toggle').forEach((b) => b.addEventListener('click', handleChatToggle));
$('countdown-start').addEventListener('click', handleCountdownStart);
$('countdown-stop').addEventListener('click', handleCountdownStop);

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
  const user = await ensureSignedIn();
  myUid = user.uid;
  $('conn-status').hidden = true;
  $('host-main').hidden = false;
  $('account-chip').hidden = false;

  // 認証状態(匿名/Google/メール)を購読。UIDが変わったらプラン・主催ゲームを購読し直す。
  // (ログインはマイページで行う。別ページでのログインもここに反映される)
  onUser(applyUser);

  const saved = QRB.loadJSON(CURRENT_KEY, null);
  if (saved && saved.gameId) {
    gameId = saved.gameId;
    attachWatcher();
  } else {
    showPanel('create-panel');
  }
})();

// ---------- アカウント状態・プラン ----------
let lastUid = null;
function applyUser(u) {
  if (!u) return;
  myUid = u.uid;
  const chip = $('account-chip');
  chip.textContent = u.isAnonymous ? 'ゲスト(未ログイン)' : u.email || u.displayName || 'ログイン中';
  chip.classList.toggle('signed-in', !u.isAnonymous);
  if (u.uid !== lastUid) {
    lastUid = u.uid;
    resubscribeHostDocs(u.uid);
  }
}

// UID ごとのプラン(作成フォームの上限表示)と主催ゲーム一覧を購読し直す。
function resubscribeHostDocs(uid) {
  if (unwatchPlan) unwatchPlan();
  unwatchPlan = watchDocPath(['entitlements', uid], renderPlan);
  if (unwatchMyGames) unwatchMyGames();
  unwatchMyGames = watchMyGames(uid, renderMyGames);
}

function renderPlan(ent) {
  const plan = planSummary(ent);
  $('plan-badge').hidden = false;
  $('plan-badge').textContent = plan.text;
  $('capacity-hint').textContent = `(最大 ${plan.maxPlayers} 人・空欄で上限まで)`;
  $('in-capacity').setAttribute('placeholder', `最大 ${plan.maxPlayers}`);
}
