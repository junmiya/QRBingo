// 投げ銭コーナー(運営への応援)。各ページの最下部に置く共通部品。
// <section id="tip-panel"></section> があるページで自動的に表示する。
// ゲームが決まっているページ(プレイヤー画面)では setTipGame() で指定すると、
// そのゲームの全員の画面にも応援が表示される。
import { ensureSignedIn, callable } from './firebase-init.js';

const AMOUNTS = [100, 300, 500, 1000];
const createTipCheckoutFn = callable('createTipCheckout');
let root = null;
let tipGameId = null;

function q(sel) {
  return root.querySelector(sel);
}

function render() {
  root.classList.add('panel', 'tip-corner');
  root.innerHTML = `
    <h2>投げ銭コーナー</h2>
    <p class="hint"><strong>QRBingo の運営を応援</strong>できます。勝敗・順位には関係ありません。</p>
    <p class="hint">いただいた投げ銭は<strong>すべて運営(aiueon)が受け取り</strong>、サービスの運営・改善に使います。ゲームの主催者への分配はありません。</p>
    <p class="hint tip-game-note" hidden></p>
    <p class="checkout-banner tip-banner" hidden></p>
    <div class="tip-grid">
      ${AMOUNTS.map((a) => `<button class="tip-btn" data-amount="${a}" type="button">¥${a.toLocaleString()}</button>`).join('')}
    </div>
    <p class="hint">決済は Stripe(安全な外部決済)で行われ、カード情報はこのサイトには保存されません。決済後の返金はできません。</p>
    <p class="hint error-text tip-error"></p>`;
  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tip-btn[data-amount]');
    if (btn) sendTip(Number(btn.dataset.amount));
  });
}

// ゲームを指定(null で解除)。指定中はそのゲームの全員に応援を表示する旨を出す。
export function setTipGame(gameId) {
  tipGameId = gameId || null;
  if (!root) return;
  const note = q('.tip-game-note');
  note.hidden = !tipGameId;
  note.textContent = tipGameId
    ? `このゲーム(${tipGameId})から送ると、参加者全員の画面に応援が表示されます。`
    : '';
}

async function sendTip(amount) {
  const err = q('.tip-error');
  err.textContent = '';
  const buttons = root.querySelectorAll('.tip-btn');
  buttons.forEach((b) => (b.disabled = true));
  try {
    await ensureSignedIn(); // 匿名でも送れる(ボタンを押した人だけ匿名アカウントを作る)
    const res = await createTipCheckoutFn({
      amount,
      gameId: tipGameId || undefined,
      origin: location.origin,
      returnPath: location.pathname,
    });
    if (res && res.url) {
      location.href = res.url; // Stripe の決済画面へ
      return;
    }
    err.textContent = '決済ページを開けませんでした。';
  } catch (e) {
    err.textContent = e.message || String(e);
  }
  buttons.forEach((b) => (b.disabled = false));
}

// 決済からの戻り(?tip=thanks|cancel)の案内
function showReturnBanner() {
  const url = new URL(location.href);
  const state = url.searchParams.get('tip');
  if (!state) return;
  const banner = q('.tip-banner');
  banner.hidden = false;
  if (state === 'thanks') {
    banner.className = 'checkout-banner tip-banner ok';
    banner.textContent = '応援ありがとうございます!運営に届きました。';
  } else {
    banner.className = 'checkout-banner tip-banner';
    banner.textContent = '投げ銭はキャンセルされました。';
  }
  url.searchParams.delete('tip');
  history.replaceState(null, '', url.toString());
  root.scrollIntoView({ block: 'center' });
}

const el = document.getElementById('tip-panel');
if (el) {
  root = el;
  render();
  setTipGame(tipGameId);
  showReturnBanner();
  if (location.hash === '#support') root.scrollIntoView({ block: 'start' });
}
