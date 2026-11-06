// QRBingo オンライン — マイページ(アカウント・主催したゲーム・プラン)
import {
  ONLINE_AVAILABLE,
  ensureSignedIn,
  onUser,
  linkGoogle,
  linkEmail,
  signOutHost,
  callable,
  watchDocPath,
  watchMyGames,
} from './firebase-init.js';
import { planSummary } from './plan.js';
import { renderResultsTable, handleResultsClick, scanAndVerify, esc as escHtml } from './results-view.js';

const $ = (id) => document.getElementById(id);
const CURRENT_KEY = 'qrbingo:online:host:current'; // ホスト画面の表示中ゲーム(ログアウト時に消す)

const createCheckoutFn = callable('createCheckout');

let myUid = null;
// 認証の準備(匿名サインイン)。画面は待たずに表示し、操作の直前にだけ待つ。
let authReady = null;

// ---------- 前回の表示内容(この端末のみ) ----------
// マイページは別ページなので、開くたびに SDK の読み込み・ログイン確認・DB 接続が走る。
// その間も前回の内容(ログイン中のメール・プラン)を即座に表示し、
// 最新データが届いたら上書きする。ログアウトで消去する。
const LAST_KEY = 'qrbingo:mypage:last';
function loadLast() {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY)) || null;
  } catch (e) {
    return null;
  }
}
function saveLast(patch) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...(loadLast() || {}), ...patch }));
  } catch (e) {
    /* 保存できない環境では毎回最新を待つだけ */
  }
}
let isAnon = true; // プラン購入はログイン必須(匿名では不可)
let unwatchPlan = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// ---------- アップグレード(課金) ----------
async function handleUpgrade(ev) {
  await authReady;
  const card = ev.target.closest('.plan-card[data-plan]');
  if (!card) return;
  const plan = card.dataset.plan;
  $('upgrade-error').textContent = '';
  if (isAnon) {
    $('upgrade-error').textContent = '購入するには、上の「アカウント」からログインしてください（買ったプランを失わないため必須です）。';
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

// ---------- アカウント(ログイン) ----------
// 認証状態を画面に反映する。匿名アカウントをそのまま昇格(link)した場合は UID が
// 変わらないため onAuthStateChanged が発火しない。ログイン成功時にも直接呼ぶ。
let lastUid = null;
function applyUser(u) {
  if (!u) return; // ログアウト直後(reload で匿名に入り直す)
  myUid = u.uid;
  renderAuth(u);
  if (u.uid !== lastUid) {
    lastUid = u.uid;
    resubscribeHostDocs(u.uid);
  }
}

function renderAuth(user) {
  isAnon = !user || user.isAnonymous;
  saveLast({ email: isAnon ? null : user.email || user.displayName || 'ログイン済み' });
  const status = $('account-status');
  const loginBtn = $('login-btn');
  const logoutBtn = $('logout-btn');
  if (isAnon) {
    status.innerHTML =
      '未ログインです。<strong>プランの購入にはログインが必要</strong>です。';
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
  // ログインが必要な操作(プラン購入)は、ログイン後のみUIを表示
  document.querySelectorAll('.login-gated').forEach((el) => {
    el.hidden = isAnon;
  });
  document.querySelectorAll('.anon-only').forEach((el) => {
    el.hidden = !isAnon;
  });
}

async function handleEmailLogin() {
  await authReady;
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
    applyUser(await linkEmail(email, pass));
    $('login-pass').value = '';
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
  await authReady;
  $('account-error').textContent = '';
  $('login-btn').disabled = true;
  try {
    applyUser(await linkGoogle());
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
  await authReady;
  if (!confirm('ログアウトしますか?\n(匿名に戻ります。ホスト画面のゲーム表示もリセットされます)')) return;
  try {
    localStorage.removeItem(CURRENT_KEY);
    localStorage.removeItem(LAST_KEY);
    await signOutHost();
    location.reload(); // 匿名で入り直す
  } catch (err) {
    $('account-error').textContent = err.message || String(err);
  }
}

// ログインUID変更時に、そのUIDのプランを購読し直す。
function resubscribeHostDocs(uid) {
  if (unwatchPlan) unwatchPlan();
  unwatchPlan = watchDocPath(['entitlements', uid], renderPlan);
  if (unwatchGames) unwatchGames();
  unwatchGames = watchMyGames(uid, (games) => {
    myGames = games;
    renderGames();
  });
}

function renderPlan(ent) {
  const text = planSummary(ent).text;
  $('plan-badge-mypage').textContent = text;
  saveLast({ planText: text });
}

function renderLast() {
  const last = loadLast();
  if (!last) return;
  if ('email' in last) renderAuth(last.email ? { isAnonymous: false, email: last.email } : null);
  if (last.planText) $('plan-badge-mypage').textContent = last.planText;
}

// ---------- イベント登録 ----------
$('upgrade-plans').addEventListener('click', handleUpgrade);
$('mp-scan-btn').addEventListener('click', async () => {
  await authReady;
  scanAndVerify({ myUid });
});
$('mygames-body').addEventListener('click', handleGamesClick);
$('login-btn').addEventListener('click', handleLogin);
$('logout-btn').addEventListener('click', handleLogout);
$('email-login-btn').addEventListener('click', handleEmailLogin);
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleEmailLogin(); });

// ---------- 初期化 ----------
(async () => {
  if (!ONLINE_AVAILABLE) {
    $('conn-status').className = 'hint error-text';
    $('conn-status').textContent = 'オンライン機能が有効化されていません。';
    return;
  }
  // 前回の内容ですぐに表示し、認証・DB の準備は裏で進める
  renderLast();
  $('conn-status').hidden = true;
  $('mypage-main').hidden = false;

  // 匿名で入っておく(ログイン=匿名アカウントの昇格。UIDを維持してプランを引き継ぐ)
  authReady = ensureSignedIn();
  await authReady;

  // 決済からの戻り(?checkout=success|cancel)の案内
  showCheckoutBanner();
  stripConnectParam();

  onUser(applyUser);
})();

// 以前の口座接続(Stripe Connect)からの戻り(?connect=...)は、受け取り機能の停止中は
// 表示するものがないため URL から消すだけにする。
function stripConnectParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has('connect')) return;
  url.searchParams.delete('connect');
  history.replaceState(null, '', url.toString());
}

// ---------- 主催したゲーム(一覧・ホスト画面で開く・中止・結果) ----------
// ログイン中の主催者のみ表示(.login-gated)。結果は開いたゲームだけ購読する。
const HOST_CURRENT_KEY = 'qrbingo:online:host:current'; // ホスト画面が開くゲーム
const cancelGameFn = callable('cancelGame');
const GAME_STATUS = { lobby: '受付中', playing: '進行中', finished: '終了(順位確定)', expired: '中止' };
let unwatchGames = null;
let myGames = [];
let openGameId = null; // 結果を開いているゲーム
let openResults = null;
let unwatchOpenResults = null;
let showCodesInMypage = false;

function fmtDate(ts) {
  if (!ts || !ts.toDate) return '';
  const d = ts.toDate();
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderGames() {
  const body = $('mygames-body');
  const list = myGames.slice().sort((a, b) => {
    const am = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const bm = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return bm - am; // 新しい順
  });
  if (list.length === 0) {
    body.innerHTML = '<p class="hint">まだ主催したゲームはありません。</p>';
    return;
  }
  const rows = list
    .map((g) => {
      const active = g.status === 'lobby' || g.status === 'playing';
      const actions = active
        ? `<button data-g="open" data-id="${g.id}">ホスト画面で開く</button><button data-g="cancel" data-id="${g.id}">中止</button>`
        : g.status === 'finished'
          ? `<button data-g="results" data-id="${g.id}">${openGameId === g.id ? '結果を閉じる' : '結果'}</button>`
          : '';
      const row = `<tr class="${openGameId === g.id ? 'is-open' : ''}">
        <td><strong>${escHtml(g.id)}</strong></td>
        <td>${GAME_STATUS[g.status] || escHtml(g.status)}</td>
        <td class="hint">${fmtDate(g.createdAt)}</td>
        <td>${g.participantCount || 0}人</td>
        <td><div class="row-actions">${actions}</div></td>
      </tr>`;
      return openGameId === g.id ? row + `<tr class="results-row"><td colspan="5">${renderOpenResults()}</td></tr>` : row;
    })
    .join('');
  body.innerHTML = `<table class="leaderboard games-table"><thead><tr>
      <th>コード</th><th>状態</th><th>作成</th><th>参加</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderOpenResults() {
  if (!openResults) return '<p class="hint">結果を読み込み中…</p>';
  const entries = openResults.entries || [];
  if (entries.length === 0) return '<p class="hint">ビンゴ成立者はいませんでした。</p>';
  return `<div class="btn-row results-tools">
      <button class="btn-primary" data-g="scan" data-id="${openGameId}" type="button">このゲームの当選コードQRを読み取る</button>
      <button class="btn-ghost" data-g="codes" type="button">${showCodesInMypage ? '当選コードを隠す' : '当選コードを表示'}</button>
    </div>
    <div class="results-table" data-game="${openGameId}">${renderResultsTable(entries, { gameId: openGameId, showCodes: showCodesInMypage })}</div>`;
}

function openResultsOf(id) {
  if (unwatchOpenResults) unwatchOpenResults();
  unwatchOpenResults = null;
  openResults = null;
  showCodesInMypage = false;
  openGameId = openGameId === id ? null : id;
  if (openGameId) {
    unwatchOpenResults = watchDocPath(['games', openGameId, 'private', 'results'], (r) => {
      openResults = r || { entries: [] };
      renderGames();
    });
  }
  renderGames();
}

async function handleGamesClick(ev) {
  // 結果表の中のボタン(対応済み・非表示)
  const table = ev.target.closest('.results-table');
  if (table) return handleResultsClick(ev, table.dataset.game);
  const btn = ev.target.closest('button[data-g]');
  if (!btn) return;
  const id = btn.dataset.id;
  switch (btn.dataset.g) {
    case 'open':
      localStorage.setItem(HOST_CURRENT_KEY, JSON.stringify({ gameId: id }));
      location.href = 'host.html';
      break;
    case 'cancel':
      if (!confirm(`ゲーム ${id} を中止しますか?\n順位は確定されず、参加者の画面も「終了」になります。`)) return;
      btn.disabled = true;
      try {
        await cancelGameFn({ gameId: id });
      } catch (err) {
        alert(err.message || String(err));
        btn.disabled = false;
      }
      break;
    case 'results':
      openResultsOf(id);
      break;
    case 'codes':
      showCodesInMypage = !showCodesInMypage;
      renderGames();
      break;
    case 'scan':
      scanAndVerify({ expectedGameId: id, myUid });
      break;
  }
}
