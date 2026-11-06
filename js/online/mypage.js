// QRBingo オンライン — マイページ(アカウント・プラン・投げ銭の受け取り設定)
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
const createConnectAccountFn = callable('createConnectAccount');
const refreshConnectStatusFn = callable('refreshConnectStatus');

let myUid = null;
let isAnon = true; // 課金・投げ銭受け取りはログイン必須(匿名では不可)
let unwatchPlan = null;
let unwatchConnect = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// ---------- アップグレード(課金) ----------
async function handleUpgrade(ev) {
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
    $('connect-error').textContent = '投げ銭を受け取るには、上の「アカウント」からログインしてください（受取設定を端末間で保持するため必須です）。';
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
  document.querySelectorAll('.anon-only').forEach((el) => {
    el.hidden = !isAnon;
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
  if (!confirm('ログアウトしますか?\n(匿名に戻ります。ホスト画面のゲーム表示もリセットされます)')) return;
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
}

function renderPlan(ent) {
  $('plan-badge-mypage').textContent = planSummary(ent).text;
}

// ---------- イベント登録 ----------
$('upgrade-plans').addEventListener('click', handleUpgrade);
$('connect-btn').addEventListener('click', handleConnect);
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
  // 匿名で入っておく(ログイン=匿名アカウントの昇格。UIDを維持してプランを引き継ぐ)
  await ensureSignedIn();
  $('conn-status').hidden = true;
  $('mypage-main').hidden = false;

  // 決済からの戻り(?checkout=success|cancel)の案内
  showCheckoutBanner();
  // 投げ銭 Connect オンボーディングからの戻り(?connect=...)
  handleConnectReturn();

  onUser(applyUser);
})();
