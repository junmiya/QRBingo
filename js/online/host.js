// QRBingo v2 (オンラインモード) — ホスト画面ロジック
import {
  ONLINE_AVAILABLE,
  ensureSignedIn,
  onUser,
  linkGoogle,
  linkEmail,
  signOutHost,
  callable,
  watchGame,
  readGame,
  watchMyGames,
  watchDocPath,
  watchCollectionPath,
} from './firebase-init.js';
import { watchAnnouncements, initChat, fmtCountdown } from './live-extras.js';

const $ = (id) => document.getElementById(id);
const CURRENT_KEY = 'qrbingo:online:host:current';

const createGameFn = callable('createGame');
const createCheckoutFn = callable('createCheckout');
const createConnectAccountFn = callable('createConnectAccount');
const refreshConnectStatusFn = callable('refreshConnectStatus');
const setChatEnabledFn = callable('setChatEnabled');
const setCountdownFn = callable('setCountdown');
const cancelGameFn = callable('cancelGame');
const adminListGamesFn = callable('adminListGames');
const adminPauseGameFn = callable('adminPauseGame');
const adminEndGameFn = callable('adminEndGame');
const ADMIN_EMAILS = ['miyajun@gmail.com'];
const startGameFn = callable('startGame');
const drawNumberFn = callable('drawNumber');
const finishGameFn = callable('finishGame');
const hideNicknameFn = callable('hideNickname');
const markWinnerHandledFn = callable('markWinnerHandled');

const BALL_COLORS = ['var(--col-b)', 'var(--col-i)', 'var(--col-n)', 'var(--col-g)', 'var(--col-o)'];
const ballColor = (n) => BALL_COLORS[Math.floor((n - 1) / 15)];

let gameId = null;
let myUid = null;
let isAnon = true; // 課金・投げ銭受け取りはログイン必須(匿名では不可)
let unwatchPlan = null;
let unwatchConnect = null;
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

// ---------- アップグレード(課金) ----------
function toggleUpgrade() {
  const box = $('upgrade-plans');
  const btn = $('upgrade-toggle');
  const show = box.hidden;
  box.hidden = !show;
  btn.setAttribute('aria-expanded', show ? 'true' : 'false');
}

async function handleUpgrade(ev) {
  const card = ev.target.closest('.plan-card[data-plan]');
  if (!card) return;
  const plan = card.dataset.plan;
  $('upgrade-error').textContent = '';
  if (isAnon) {
    $('upgrade-error').textContent = '購入するには、上部「アカウント」から Google でログインしてください（買ったプランを失わないため必須です）。';
    $('account-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  card.disabled = true;
  try {
    const res = await createCheckoutFn({ plan, origin: location.origin });
    if (res && res.url) {
      location.href = res.url; // Stripe の決済画面へ
    } else {
      $('upgrade-error').textContent = '決済ページを開けませんでした。';
      card.disabled = false;
    }
  } catch (err) {
    $('upgrade-error').textContent = err.message || String(err);
    card.disabled = false;
  }
}

// 決済からの戻り(?checkout=success|cancel)を検知して案内を出す。
function showCheckoutBanner() {
  const params = new URLSearchParams(location.search);
  const state = params.get('checkout');
  if (!state) return;
  const banner = $('checkout-banner');
  banner.hidden = false;
  if (state === 'success') {
    banner.className = 'checkout-banner ok';
    banner.textContent = 'ご購入ありがとうございます。プランへの反映まで数十秒かかる場合があります(自動更新されます)。';
  } else {
    banner.className = 'checkout-banner';
    banner.textContent = '決済はキャンセルされました。';
  }
  // URL から checkout パラメータを消す(リロードで再表示しない)
  params.delete('checkout');
  const q = params.toString();
  history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
}

// ---------- 投げ銭の受け取り設定(Stripe Connect) ----------
function renderConnect(acct) {
  const text = $('connect-status-text');
  const btn = $('connect-btn');
  if (acct && acct.chargesEnabled) {
    text.textContent = '受け取り可能です。作成したゲームで参加者から投げ銭を受け取れます。';
    btn.hidden = true;
  } else if (acct && acct.stripeAccountId) {
    text.textContent = '接続手続きが未完了です。続きから設定してください。';
    btn.hidden = false;
    btn.textContent = '接続手続きを続ける';
  } else {
    text.textContent = 'まだ接続されていません。投げ銭を受け取るには Stripe で口座を接続してください。';
    btn.hidden = false;
    btn.textContent = 'Stripeで受け取り口座を接続';
  }
}

async function handleConnect() {
  $('connect-error').textContent = '';
  if (isAnon) {
    $('connect-error').textContent = '投げ銭を受け取るには、上部「アカウント」から Google でログインしてください（受取設定を端末間で保持するため必須です）。';
    $('account-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  $('connect-btn').disabled = true;
  try {
    const res = await createConnectAccountFn({ origin: location.origin });
    if (res && res.url) {
      location.href = res.url; // Stripe のオンボーディングへ
    } else {
      $('connect-error').textContent = '接続ページを開けませんでした。';
      $('connect-btn').disabled = false;
    }
  } catch (err) {
    $('connect-error').textContent = err.message || String(err);
    $('connect-btn').disabled = false;
  }
}

// オンボーディングからの戻り(?connect=return|refresh)で最新状態を取得する。
async function handleConnectReturn() {
  const state = new URLSearchParams(location.search).get('connect');
  if (!state) return;
  const banner = $('connect-banner');
  try {
    const res = await refreshConnectStatusFn({});
    banner.hidden = false;
    if (res && res.chargesEnabled) {
      banner.className = 'checkout-banner ok';
      banner.textContent = '接続が完了しました。投げ銭を受け取れます。';
    } else {
      banner.className = 'checkout-banner';
      banner.textContent = '接続はまだ完了していません。手続きを最後まで進めてください。';
    }
  } catch (e) {
    /* 状態は購読で反映される */
  }
  const url = new URL(location.href);
  url.searchParams.delete('connect');
  history.replaceState(null, '', url.toString());
}

// ---------- ライブ機能(チャット切替・カウントダウン) ----------
function updateLive(game) {
  const active = game.status === 'lobby' || game.status === 'playing';
  $('live-panel').hidden = !active;

  const chatEnabled = !!(game.settings && game.settings.chatEnabled);
  chatCurrentlyEnabled = chatEnabled;
  $('chat-toggle-btn').textContent = 'チャット: ' + (chatEnabled ? 'ON(タップでOFF)' : 'OFF(タップでON)');

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

async function handleChatToggle() {
  $('live-error').textContent = '';
  $('chat-toggle-btn').disabled = true;
  try {
    await setChatEnabledFn({ gameId, enabled: !chatCurrentlyEnabled });
  } catch (err) {
    $('live-error').textContent = err.message || String(err);
  } finally {
    $('chat-toggle-btn').disabled = false;
  }
}

async function handleCountdownStart() {
  $('live-error').textContent = '';
  const seconds = parseInt($('countdown-sec').value, 10);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    $('live-error').textContent = '秒は 1〜3600 で入力してください';
    return;
  }
  try {
    await setCountdownFn({ gameId, seconds });
  } catch (err) {
    $('live-error').textContent = err.message || String(err);
  }
}

async function handleCountdownStop() {
  $('live-error').textContent = '';
  try {
    await setCountdownFn({ gameId, seconds: 0 });
  } catch (err) {
    $('live-error').textContent = err.message || String(err);
  }
}

// ---------- 進行中ゲームへの再接続 ----------
function attachToGame(id) {
  gameId = id;
  QRB.saveJSON(CURRENT_KEY, { gameId });
  attachWatcher();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function handleResume() {
  const code = ($('resume-code').value || '').trim().toUpperCase();
  $('resume-error').textContent = '';
  if (!/^[A-Z0-9]{4,8}$/.test(code)) {
    $('resume-error').textContent = 'ゲームコードを入力してください';
    return;
  }
  $('resume-btn').disabled = true;
  try {
    const game = await readGame(code);
    if (!game) {
      $('resume-error').textContent = 'そのゲームは見つかりません';
      return;
    }
    if (game.hostUid !== myUid) {
      $('resume-error').textContent =
        'このゲームのホストではありません(別の端末やブラウザで作成された可能性があります)';
      return;
    }
    if (game.status === 'finished' || game.status === 'expired') {
      $('resume-error').textContent = 'このゲームは既に終了しています';
      return;
    }
    attachToGame(code);
  } catch (err) {
    $('resume-error').textContent = err.message || String(err);
  } finally {
    $('resume-btn').disabled = false;
  }
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
  const list = (games || []).slice().sort((a, b) => {
    const am = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const bm = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return bm - am; // 新しい順
  });
  if (list.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const rows = list
    .map((g) => {
      const active = g.status === 'lobby' || g.status === 'playing';
      const label = STATUS_LABEL[g.status] || g.status;
      const back = active ? `<button data-act="back" data-id="${g.id}">戻る</button>` : '';
      const end = active ? `<button data-act="end" data-id="${g.id}">終了(中止)</button>` : '';
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

  // 投げ銭の集計(受取ベース)。件数があれば進行画面に表示する。
  const tipNote = $('tip-total-note');
  if (game.tipsEnabled && (game.tipCount || 0) > 0) {
    tipNote.hidden = false;
    tipNote.textContent = `投げ銭: ${game.tipCount}件 / ホスト受取 ¥${(game.tipTotalNet || 0).toLocaleString()}`;
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
    return;
  }

  // finished / expired
  showPanel('playing-panel');
  $('finish-btn').hidden = true;
  renderHistory(game.draws || []);
  renderReaches(); // 終了後はリーチ表示を畳む
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
  $('live-panel').hidden = true;
  $('chat-panel').hidden = true;
  showPanel('create-panel');
}

function handleReset() {
  if (!confirm(
    '表示をリセットしますか?\n\n' +
    '※ 進行中のゲームは「終了」しません(参加者はそのまま継続)。\n' +
    'ゲームを本当に終わらせたいときは、先に「ゲームを終了して順位を確定」を押してください。\n' +
    'リセット後も、同じ端末なら下の「再接続」にゲームコードを入れて戻れます。'
  )) return;
  clearGameView();
}

// ゲームを中止する(順位を出さずに終了)。ロビー・進行中どちらからでも可能。
async function handleCancel() {
  if (!gameId) return;
  if (!confirm('このゲームを中止しますか?\n順位は確定されず、参加者の画面も「終了」になります。\nこの操作は取り消せません。')) return;
  try {
    await cancelGameFn({ gameId });
    clearGameView();
  } catch (err) {
    const box = gameStatus === 'lobby' ? 'lobby-error' : 'draw-error';
    $(box).textContent = err.message || String(err);
  }
}

// ---------- イベント登録 ----------
$('create-btn').addEventListener('click', handleCreate);
$('start-btn').addEventListener('click', handleStart);
$('draw-btn').addEventListener('click', handleDraw);
$('finish-btn').addEventListener('click', handleFinish);
$('ranking-body').addEventListener('click', handleRankingClick);
$('reset-btn').addEventListener('click', handleReset);
$('resume-btn').addEventListener('click', handleResume);
$('cancel-lobby-btn').addEventListener('click', handleCancel);
$('cancel-playing-btn').addEventListener('click', handleCancel);
$('mygames-body').addEventListener('click', handleMyGamesClick);
$('admin-refresh-btn').addEventListener('click', loadAdminGames);
$('admin-body').addEventListener('click', handleAdminClick);
$('upgrade-toggle').addEventListener('click', toggleUpgrade);
$('upgrade-plans').addEventListener('click', handleUpgrade);
$('connect-btn').addEventListener('click', handleConnect);
$('login-btn').addEventListener('click', handleLogin);
$('logout-btn').addEventListener('click', handleLogout);
$('email-login-btn').addEventListener('click', handleEmailLogin);
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleEmailLogin(); });
$('chat-toggle-btn').addEventListener('click', handleChatToggle);
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

  // 決済からの戻り(?checkout=success|cancel)の案内
  showCheckoutBanner();
  // 投げ銭 Connect オンボーディングからの戻り(?connect=...)
  handleConnectReturn();

  // 認証状態(匿名/Google)を購読。UIDが変わったらプラン・接続状態を購読し直す。
  let lastUid = null;
  onUser((u) => {
    if (!u) return; // ログアウト直後(reload で匿名に入り直す)
    myUid = u.uid;
    renderAuth(u);
    updateAdminMode(u);
    if (u.uid !== lastUid) {
      lastUid = u.uid;
      resubscribeHostDocs(u.uid);
    }
  });

  const saved = QRB.loadJSON(CURRENT_KEY, null);
  if (saved && saved.gameId) {
    gameId = saved.gameId;
    attachWatcher();
  } else {
    showPanel('create-panel');
  }
})();

// ---------- アカウント(ログイン) ----------
function renderAuth(user) {
  isAnon = !user || user.isAnonymous;
  $('account-panel').hidden = false;
  const status = $('account-status');
  const loginBtn = $('login-btn');
  const logoutBtn = $('logout-btn');
  if (isAnon) {
    status.innerHTML =
      '未ログインです。<strong>プラン購入・投げ銭の受け取りにはログインが必要</strong>です。';
    loginBtn.hidden = false;
    logoutBtn.hidden = true;
    $('email-login').hidden = false;
  } else {
    const who = user.email || user.displayName || 'ログイン済み';
    status.innerHTML = `ログイン中: <strong>${esc(who)}</strong>(プランは端末をまたいで引き継がれます)`;
    loginBtn.hidden = true;
    logoutBtn.hidden = false;
    $('email-login').hidden = true;
  }
  // ログインが必要な操作(プラン購入・投げ銭の受け取り)は、ログイン後のみUIを表示
  document.querySelectorAll('.login-gated').forEach((el) => {
    el.hidden = isAnon;
  });
}

async function handleEmailLogin() {
  $('account-error').textContent = '';
  const email = ($('login-email').value || '').trim();
  const pass = $('login-pass').value || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    $('account-error').textContent = 'メールアドレスの形式が正しくありません。';
    return;
  }
  if (pass.length < 6) {
    $('account-error').textContent = 'パスワードは6文字以上で入力してください。';
    return;
  }
  $('email-login-btn').disabled = true;
  try {
    await linkEmail(email, pass);
    $('login-pass').value = '';
    // 認証状態は onUser 購読で反映される
  } catch (err) {
    const code = String((err && err.code) || '');
    if (code.includes('wrong-password') || code.includes('invalid-credential')) {
      $('account-error').textContent = 'パスワードが違います(既に登録済みのメールの場合)。';
    } else if (code.includes('weak-password')) {
      $('account-error').textContent = 'パスワードが弱すぎます。6文字以上にしてください。';
    } else {
      $('account-error').textContent = err.message || String(err);
    }
  } finally {
    $('email-login-btn').disabled = false;
  }
}

async function handleLogin() {
  $('account-error').textContent = '';
  $('login-btn').disabled = true;
  try {
    await linkGoogle();
    // 認証状態は onUser 購読で反映される
  } catch (err) {
    const code = String((err && err.code) || '');
    if (code.includes('popup-closed') || code.includes('cancelled')) {
      $('account-error').textContent = 'ログインがキャンセルされました。';
    } else {
      $('account-error').textContent = err.message || String(err);
    }
  } finally {
    $('login-btn').disabled = false;
  }
}

async function handleLogout() {
  if (!confirm('ログアウトしますか?\n(このゲーム表示はリセットされ、匿名に戻ります)')) return;
  try {
    localStorage.removeItem(CURRENT_KEY);
    await signOutHost();
    location.reload(); // 匿名で入り直す
  } catch (err) {
    $('account-error').textContent = err.message || String(err);
  }
}

// ログインUID変更時に、そのUIDのプラン・投げ銭接続状態を購読し直す。
function resubscribeHostDocs(uid) {
  if (unwatchPlan) unwatchPlan();
  unwatchPlan = watchDocPath(['entitlements', uid], renderPlan);
  if (unwatchConnect) unwatchConnect();
  unwatchConnect = watchDocPath(['hostAccounts', uid], renderConnect);
  if (unwatchMyGames) unwatchMyGames();
  unwatchMyGames = watchMyGames(uid, renderMyGames);
}

// ---------- 運営モード(全ゲーム管理) ----------
const ADMIN_STATUS = {
  lobby: '受付中',
  playing: '進行中',
  finished: '終了',
  expired: '中止',
};

async function loadAdminGames() {
  $('admin-error').textContent = '';
  $('admin-refresh-btn').disabled = true;
  try {
    const res = await adminListGamesFn({});
    renderAdminGames((res && res.games) || []);
  } catch (err) {
    $('admin-error').textContent = err.message || String(err);
  } finally {
    $('admin-refresh-btn').disabled = false;
  }
}

function renderAdminGames(games) {
  if (!games.length) {
    $('admin-body').innerHTML = '<p class="hint">ゲームはありません。</p>';
    return;
  }
  const rows = games
    .map((g) => {
      const active = g.status === 'lobby' || g.status === 'playing';
      const label = ADMIN_STATUS[g.status] || g.status;
      const pauseLabel = g.paused ? '再開' : '一時停止';
      const pauseBtn = active
        ? `<button data-aact="pause" data-id="${g.gameId}" data-paused="${g.paused ? '1' : '0'}">${pauseLabel}</button>`
        : '';
      const endBtn = active ? `<button data-aact="end" data-id="${g.gameId}">終了</button>` : '';
      const st = label + (g.paused ? '(停止中)' : '');
      return `<tr>
        <td><strong>${esc(g.gameId)}</strong></td>
        <td>${st}</td>
        <td>${g.participantCount}人 / ${g.drawsCount}球</td>
        <td><div class="row-actions">${pauseBtn}${endBtn}</div></td>
      </tr>`;
    })
    .join('');
  $('admin-body').innerHTML =
    `<table class="leaderboard"><thead><tr>
       <th>コード</th><th>状態</th><th>参加/抽選</th><th></th>
     </tr></thead><tbody>${rows}</tbody></table>`;
}

async function handleAdminClick(ev) {
  const btn = ev.target.closest('button[data-aact]');
  if (!btn) return;
  const id = btn.dataset.id;
  btn.disabled = true;
  try {
    if (btn.dataset.aact === 'pause') {
      const toPaused = btn.dataset.paused !== '1';
      await adminPauseGameFn({ gameId: id, paused: toPaused });
    } else if (btn.dataset.aact === 'end') {
      if (!confirm(`【運営】ゲーム ${id} を強制終了しますか?\n順位は確定されず、参加者の画面も「終了」になります。\nこの操作は取り消せません。`)) {
        btn.disabled = false;
        return;
      }
      await adminEndGameFn({ gameId: id });
    }
    await loadAdminGames(); // 反映後に一覧を更新
  } catch (err) {
    $('admin-error').textContent = err.message || String(err);
    btn.disabled = false;
  }
}

function updateAdminMode(user) {
  const email = (user && user.email ? String(user.email) : '').toLowerCase();
  const isAdmin = !user.isAnonymous && ADMIN_EMAILS.includes(email);
  $('admin-panel').hidden = !isAdmin;
  if (isAdmin) loadAdminGames();
}

// ---------- 課金プラン表示 ----------
const FREE_MAX_PLAYERS = 20;
function renderPlan(ent) {
  let maxPlayers = FREE_MAX_PLAYERS;
  let label = '無料プラン';
  if (ent && Number.isInteger(ent.maxPlayers) && ent.maxPlayers > 0) {
    const validMs = ent.validUntil && ent.validUntil.toMillis ? ent.validUntil.toMillis() : null;
    const expired = validMs != null && validMs < Date.now();
    if (!expired) {
      maxPlayers = ent.maxPlayers;
      label = `${ent.plan || '有料'}プラン`;
    }
  }
  const badge = $('plan-badge');
  badge.hidden = false;
  badge.textContent =
    maxPlayers >= FREE_MAX_PLAYERS && label === '無料プラン'
      ? `現在のプラン: 無料(1ゲーム最大 ${maxPlayers} 人)`
      : `現在のプラン: ${label}(1ゲーム最大 ${maxPlayers} 人)`;
  $('capacity-hint').textContent = `(最大 ${maxPlayers} 人・空欄で上限まで)`;
  $('in-capacity').setAttribute('placeholder', `最大 ${maxPlayers}`);
}
