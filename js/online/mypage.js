// QRBingo オンライン — マイページ(アカウント・プラン)
import {
  ONLINE_AVAILABLE,
  ensureSignedIn,
  onUser,
  linkGoogle,
  linkEmail,
  signOutHost,
  callable,
  watchDocPath,
} from './firebase-init.js';
import { planSummary } from './plan.js';

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
