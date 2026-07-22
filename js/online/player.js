// QRBingo v2 (オンラインモード) — プレイヤー画面ロジック
// 手動タップは廃止し、サーバーの抽選結果(draws)から自動でマークする。
// 勝利条件に達したら自動で submitClaim を送り、順位・当選コードを表示する。
import {
  ONLINE_AVAILABLE,
  ensureSignedIn,
  callable,
  watchGame,
  watchDocPath,
} from './firebase-init.js';
import { watchAnnouncements, initChat, fmtCountdown } from './live-extras.js';

const $ = (id) => document.getElementById(id);
const LAST_GAME_KEY = 'qrbingo:online:player:last';
const SECTIONS = ['gamecode-panel', 'nickname-panel', 'error-panel', 'game-area'];

const joinGameFn = callable('joinGame');
const submitClaimFn = callable('submitClaim');
const reportReachFn = callable('reportReach');
const createTipCheckoutFn = callable('createTipCheckout');

let currentGameId = null;
let myUid = null;
let grid = null;
let winLines = 1;
let gameStatus = null;
let latestDraws = [];
let pendingTimers = [];
let unwatch = null;
let unwatchWinner = null;
let unwatchLeaderboard = null;
let claiming = false;
let claimed = false; // verified 済み(重複送信防止)
let isWinnerFinal = false; // 当選ドキュメント受信済み(順位表示の上書き防止)
let lastReachKey = null; // リーチ報告の重複送信防止(状態が変わった時だけ送る)
let reportingReach = false;
let celebrated = false; // ビンゴ演出は初回のみ
let announceStarted = false; // リーチ/ビンゴのアナウンス購読は1回だけ
let chatUnwatch = null; // チャット購読(有効化時に開始)
let countdownTimer = null; // カウントダウンの更新タイマー

function showOnly(id) {
  for (const s of SECTIONS) $(s).hidden = s !== id;
}

function isValidGameCode(code) {
  return /^[A-Z0-9]{4,8}$/.test(String(code || '').trim().toUpperCase());
}

function errCode(err) {
  return String((err && err.code) || '').replace(/^functions\//, '');
}

// ---------- 参加フロー ----------
async function resolveAndJoin(gameId) {
  currentGameId = gameId;
  try {
    // ニックネーム無しでの「サイレント再参加」試行。既存カードがあればそのまま復帰する
    // (FR-013 セッション継続)。無ければ invalid-argument (ニックネーム必須) で
    // 判別できる — gameId は事前に形式検証済みのため、ここでの invalid-argument は
    // 常にニックネーム起因である。
    const res = await joinGameFn({ gameId });
    onJoined(res);
  } catch (err) {
    if (errCode(err) === 'invalid-argument') {
      showOnly('nickname-panel');
      $('in-nickname').focus();
    } else {
      showError(err);
    }
  }
}

async function submitNickname() {
  const nickname = $('in-nickname').value;
  $('nickname-error').textContent = '';
  $('nickname-btn').disabled = true;
  try {
    const res = await joinGameFn({ gameId: currentGameId, nickname });
    onJoined(res);
  } catch (err) {
    if (errCode(err) === 'invalid-argument') {
      // ニックネーム自体の問題(長さ・NGワード)。フォームに留めて訂正させる
      $('nickname-error').textContent = err.message || String(err);
    } else {
      // 定員超過・終了済みなど、ニックネームを直しても解決しない失敗
      showError(err);
    }
  } finally {
    $('nickname-btn').disabled = false;
  }
}

function showError(err) {
  $('error-message').textContent = err.message || String(err);
  showOnly('error-panel');
}

function onJoined(res) {
  localStorage.setItem(LAST_GAME_KEY, currentGameId);
  grid = QRB.generateCard(res.seed);

  $('game-label').textContent = currentGameId;
  $('nickname-label').textContent = 'ニックネーム: ' + res.nickname;
  showOnly('game-area');

  if (unwatch) unwatch();
  unwatch = watchGame(currentGameId, onGameSnapshot);

  // 当選ドキュメント(自分宛)を購読 → finishGame 後に当選コードを表示
  if (unwatchWinner) unwatchWinner();
  unwatchWinner = watchDocPath(['winners', `${currentGameId}_${myUid}`], onWinnerSnapshot);

  // 公開ランキングを購読 → 自分の順位(暫定/確定)を反映(非当選でも最終順位が出る)
  if (unwatchLeaderboard) unwatchLeaderboard();
  unwatchLeaderboard = watchDocPath(
    ['games', currentGameId, 'public', 'leaderboard'],
    onLeaderboardSnapshot
  );

  // リーチ/ビンゴのアナウンスを全員向けに購読(1回だけ)
  if (!announceStarted) {
    announceStarted = true;
    watchAnnouncements(currentGameId);
  }
}

// ---------- チャット / カウントダウン ----------
function updateChat(game) {
  const enabled = !!(game.settings && game.settings.chatEnabled) && gameStatus !== 'finished';
  $('chat-panel').hidden = !enabled;
  if (enabled && !chatUnwatch) {
    chatUnwatch = initChat(currentGameId, {
      listEl: $('chat-list'),
      inputEl: $('chat-input'),
      sendBtn: $('chat-send'),
      errEl: $('chat-error'),
    });
  }
}

function updateCountdown(game) {
  const box = $('countdown-box');
  const enabled = !!(game.settings && game.settings.countdownEnabled);
  const targetMs =
    game.countdownTarget && game.countdownTarget.toMillis ? game.countdownTarget.toMillis() : null;
  const show = enabled && targetMs && gameStatus === 'lobby';
  if (!show) {
    box.hidden = true;
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    return;
  }
  box.hidden = false;
  const tick = () => {
    const remain = targetMs - Date.now();
    $('countdown-value').textContent = remain > 0 ? fmtCountdown(remain) : 'まもなく開始!';
  };
  tick();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 250);
}

function onLeaderboardSnapshot(lb) {
  if (isWinnerFinal || !lb || !lb.entries) return;
  const mine = lb.entries.find((e) => e.uid === myUid);
  if (mine) showRank(mine.rank, gameStatus === 'finished');
}

// ---------- 抽選の反映(自動マーキング) ----------
function revealMillis(draw) {
  return draw.revealAt && typeof draw.revealAt.toMillis === 'function'
    ? draw.revealAt.toMillis()
    : new Date(draw.revealAt).getTime();
}

function computeRevealedSet(draws) {
  const now = Date.now();
  const revealed = new Set();
  for (const d of draws) if (revealMillis(d) <= now) revealed.add(d.n);
  return revealed;
}

function scheduleRevealTimers(draws) {
  pendingTimers.forEach(clearTimeout);
  pendingTimers = [];
  const now = Date.now();
  for (const d of draws) {
    const ms = revealMillis(d);
    if (ms > now) pendingTimers.push(setTimeout(renderCard, ms - now + 50));
  }
}

function onGameSnapshot(game) {
  if (!game) return;
  gameStatus = game.status;
  winLines = (game.settings && game.settings.winLines) || 1;
  latestDraws = game.draws || [];
  scheduleRevealTimers(latestDraws);
  renderCard();
  // 投げ銭: 常に表示可(勝敗に無関係・いつでも送れる)。送金先で文言を正直に切替。
  $('tip-panel').hidden = !game.tipsEnabled;
  if (game.tipsEnabled) {
    if (game.tipsToHost) {
      $('tip-title').textContent = 'ホストを応援(投げ銭)';
      $('tip-desc').textContent =
        '勝敗には関係ありません。主催者への「応援」として送れます。決済は Stripe(安全な外部決済)で行われ、カード情報はこのサイトには保存されません。';
    } else {
      $('tip-title').textContent = '運営を応援(投げ銭)';
      $('tip-desc').textContent =
        '勝敗には関係ありません。このゲームの主催者は受け取り設定をしていないため、いただいた応援は運営(アプリ提供者)への支援になります。決済は Stripe で行われ、カード情報はこのサイトには保存されません。';
    }
  }
  updateChat(game);
  updateCountdown(game);
}

// ---------- 投げ銭 ----------
async function sendTip(amount) {
  $('tip-error').textContent = '';
  try {
    const res = await createTipCheckoutFn({ gameId: currentGameId, amount, origin: location.origin });
    if (res && res.url) {
      location.href = res.url; // Stripe の決済画面へ
    } else {
      $('tip-error').textContent = '決済ページを開けませんでした。';
    }
  } catch (err) {
    $('tip-error').textContent = err.message || String(err);
  }
}

// 決済からの戻り(?tip=thanks|cancel)の案内
function showTipBanner() {
  const state = new URLSearchParams(location.search).get('tip');
  if (!state) return;
  const banner = $('tip-banner');
  banner.hidden = false;
  if (state === 'thanks') {
    banner.className = 'checkout-banner ok';
    banner.textContent = '応援ありがとうございます!ホストに届きました。';
  } else {
    banner.className = 'checkout-banner';
    banner.textContent = '投げ銭はキャンセルされました。';
  }
  const url = new URL(location.href);
  url.searchParams.delete('tip');
  history.replaceState(null, '', url.toString());
}

// ---------- 当選条件の自動検知とクレーム送信 ----------
async function maybeClaim(bingoLineCount) {
  if (claimed || claiming) return;
  if (bingoLineCount < winLines) return;
  claiming = true;
  try {
    const res = await submitClaimFn({ gameId: currentGameId });
    if (res.status === 'verified') {
      claimed = true;
      // 順位はサーバーのランキング再構築(スロットリング)後に leaderboard 購読で届く。
      // それまでは集計中プレースホルダーを表示する。
      showRankPending();
    }
  } catch (e) {
    // 一時的な失敗(通信断など)は次回のスナップショットで再試行される
  } finally {
    claiming = false;
  }
}

function showRankPending() {
  if (isWinnerFinal) return;
  $('rank-panel').hidden = false;
  $('rank-value').textContent = '—';
  $('rank-note').textContent = '順位を集計中…';
}

function showRank(rank, isFinal) {
  $('rank-panel').hidden = false;
  $('rank-value').textContent = rank;
  $('rank-note').textContent = isFinal
    ? '最終順位です'
    : '暫定順位です。順位は「何球目でビンゴしたか」で決まるため、' +
      '通信の遅れで申告があとから届いた人が上に入ると変わることがあります(ゲーム終了時に確定)';
}

function onWinnerSnapshot(winner) {
  if (!winner) return;
  isWinnerFinal = true;
  $('rank-panel').hidden = false;
  $('rank-value').textContent = winner.rank;
  $('rank-note').textContent = 'おめでとうございます!確定順位です';
  $('win-code-box').hidden = false;
  $('win-code').textContent = winner.winCode;
}

// ---------- 描画 ----------
// リーチマス(そこが出れば1ライン揃うマス)の座標集合を返す
function computeReachCells(marked, evalResult) {
  const reachCells = new Set();
  if (evalResult.bingoLines.length >= winLines) return reachCells; // 既に達成
  for (const line of QRB.LINES) {
    const unmarked = line.filter(
      (c) => !(grid[c.col][c.row] === QRB.FREE || marked.has(grid[c.col][c.row]))
    );
    if (unmarked.length === 1) {
      reachCells.add(unmarked[0].col + ':' + unmarked[0].row);
    }
  }
  return reachCells;
}

function renderCard() {
  const marked = computeRevealedSet(latestDraws);
  const evalResult = QRB.evaluateCard(grid, marked);
  const bingoCells = new Set();
  evalResult.bingoLines.forEach((line) => line.forEach((c) => bingoCells.add(c.col + ':' + c.row)));
  const reachCells = computeReachCells(marked, evalResult);

  const table = $('card');
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  QRB.COLUMNS.forEach((c, i) => {
    const th = document.createElement('th');
    th.className = 'col-' + i;
    th.textContent = c;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let row = 0; row < 5; row++) {
    const tr = document.createElement('tr');
    for (let col = 0; col < 5; col++) {
      const n = grid[col][row];
      const free = n === QRB.FREE;
      const td = document.createElement('td');
      td.textContent = free ? 'FREE' : n;
      const key = col + ':' + row;
      if (free || marked.has(n)) td.classList.add('marked');
      if (free) td.classList.add('free');
      if (bingoCells.has(key)) td.classList.add('bingo-cell');
      if (reachCells.has(key)) td.classList.add('reach-cell');
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  renderStatus(evalResult);
}

// ---------- ビンゴ演出(紙吹雪) ----------
function celebrate() {
  if (celebrated) return;
  celebrated = true;
  const box = document.createElement('div');
  box.className = 'confetti';
  const COLORS = ['var(--col-b)', 'var(--col-i)', 'var(--col-n)', 'var(--col-g)', 'var(--col-o)'];
  for (let i = 0; i < 28; i++) {
    const s = document.createElement('span');
    s.style.background = COLORS[i % COLORS.length];
    s.style.left = Math.random() * 100 + 'vw';
    s.style.animationDelay = (Math.random() * 0.7).toFixed(2) + 's';
    const size = Math.round(8 + Math.random() * 10);
    s.style.width = size + 'px';
    s.style.height = size + 'px';
    box.appendChild(s);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4000);
}

function renderStatus(evalResult) {
  const lines = evalResult.bingoLines.length;
  const banner = $('status-banner');
  if (lines >= winLines) {
    banner.className = 'status-banner bingo';
    banner.textContent = winLines > 1 ? `${winLines}ライン達成!` : 'ビンゴ!';
    celebrate();
  } else if (lines > 0) {
    banner.className = 'status-banner reach';
    banner.textContent = `あと ${winLines - lines} ライン(${lines}/${winLines})`;
  } else if (evalResult.reachCount > 0) {
    banner.className = 'status-banner reach';
    banner.textContent = `リーチ!(${evalResult.reachCount}本)`;
  } else {
    banner.className = 'status-banner';
    banner.textContent = '番号が呼ばれると自動でマークされます';
  }

  // 勝利条件に達していれば自動でクレーム送信(サーバーが最終判定)
  maybeClaim(lines);
  // リーチ状態が変わったらホストのリーチリストへ報告(演出用・順位に無関係)
  maybeReportReach(evalResult);
}

// リーチ状態の変化をサーバーへ報告する。同じ状態の再送はしない。
// 失敗しても次のスナップショット(状態変化)で再試行される軽量処理。
async function maybeReportReach(evalResult) {
  if (claimed || gameStatus !== 'playing') return;
  const lines = evalResult.bingoLines.length;
  if (lines >= winLines) return; // ビンゴ側の処理(maybeClaim)に任せる
  const key = lines + ':' + evalResult.reachCount;
  if (key === lastReachKey || reportingReach) return;
  if (evalResult.reachCount === 0 && lines === 0) {
    lastReachKey = key; // リーチ無し状態も記録だけして送信しない
    return;
  }
  reportingReach = true;
  try {
    await reportReachFn({ gameId: currentGameId });
    lastReachKey = key;
  } catch (e) {
    // 一時的失敗は無視(次の状態変化で再送)
  } finally {
    reportingReach = false;
  }
}

// ---------- イベント登録 ----------
$('gamecode-btn').addEventListener('click', () => {
  const code = $('in-gamecode').value.trim().toUpperCase();
  if (!isValidGameCode(code)) return;
  resolveAndJoin(code);
});
$('in-gamecode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('gamecode-btn').click();
});

$('nickname-btn').addEventListener('click', submitNickname);
$('in-nickname').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNickname();
});

$('tip-panel').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.tip-btn[data-amount]');
  if (btn) sendTip(Number(btn.dataset.amount));
});

$('error-retry-btn').addEventListener('click', () => {
  localStorage.removeItem(LAST_GAME_KEY);
  const url = new URL(location.href);
  url.searchParams.delete('g');
  history.replaceState(null, '', url.toString());
  showOnly('gamecode-panel');
});

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

  showTipBanner();

  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('g');
  const last = localStorage.getItem(LAST_GAME_KEY);
  const gameId = isValidGameCode(fromUrl) ? fromUrl.trim().toUpperCase() : last;

  if (gameId) {
    resolveAndJoin(gameId);
  } else {
    showOnly('gamecode-panel');
  }
})();
