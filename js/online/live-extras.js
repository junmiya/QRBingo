// QRBingo v2 — リーチ/ビンゴのアナウンス・チャット・カウントダウンの共通UI
// host.js / player.js の双方から使う。順位・当選には一切影響しない演出/交流機能。
import { callable, watchOrdered } from './firebase-init.js';

const sendChatFn = callable('sendChat');

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// ---------- アナウンス(リーチ/ビンゴ)を全員にトースト表示 ----------
function toastContainer() {
  let c = document.getElementById('announce-toasts');
  if (!c) {
    c = document.createElement('div');
    c.id = 'announce-toasts';
    c.className = 'announce-toasts';
    document.body.appendChild(c);
  }
  return c;
}

function showToast(ev) {
  const el = document.createElement('div');
  el.className = 'announce-toast ' + (ev.type || 'reach');
  const name = esc(ev.nickname || '(不明)');
  let dwell = 3800;
  if (ev.type === 'bingo') {
    el.textContent = `${name} さんが BINGO!`;
  } else if (ev.type === 'tip') {
    const amount = Number(ev.amount || 0).toLocaleString();
    el.textContent = `${name} さんが ¥${amount} 応援!`;
    dwell = 5500; // スパチャは別格・長めに表示
  } else {
    el.textContent = `${name} さんがリーチ!`;
  }
  toastContainer().appendChild(el);
  setTimeout(() => el.classList.add('show'), 20);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, dwell);
}

// feed を購読し、購読開始後に追加された分だけトーストする(履歴は出さない)。
export function watchAnnouncements(gameId) {
  const startMs = Date.now();
  const seen = new Set();
  return watchOrdered(['games', gameId, 'feed'], 'createdAt', 'desc', 12, (docs) => {
    const toShow = [];
    for (const d of docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const ms = d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0;
      if (ms >= startMs - 1500) toShow.push(d);
    }
    toShow.reverse().forEach(showToast); // 古い順に表示
  });
}

// ---------- チャット ----------
function renderChat(listEl, docs) {
  listEl.innerHTML = docs
    .map(
      (m) => `<div class="chat-msg${m.isHost ? ' host' : ''}">
        <span class="chat-name">${esc(m.nickname || '(不明)')}</span>
        <span class="chat-text">${esc(m.text || '')}</span>
      </div>`
    )
    .join('');
  listEl.scrollTop = listEl.scrollHeight;
}

// チャットパネルを起動する。戻り値は購読解除関数。
export function initChat(gameId, els) {
  const unwatch = watchOrdered(
    ['games', gameId, 'chat'],
    'createdAt',
    'asc',
    200,
    (docs) => renderChat(els.listEl, docs)
  );

  async function send() {
    const text = els.inputEl.value.trim();
    if (!text) return;
    els.sendBtn.disabled = true;
    if (els.errEl) els.errEl.textContent = '';
    try {
      await sendChatFn({ gameId, text });
      els.inputEl.value = '';
    } catch (e) {
      if (els.errEl) els.errEl.textContent = e.message || String(e);
    } finally {
      els.sendBtn.disabled = false;
      els.inputEl.focus();
    }
  }

  els.sendBtn.addEventListener('click', send);
  els.inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  return unwatch;
}

// ---------- カウントダウン整形 ----------
// 残りミリ秒を mm:ss(1時間以上は h:mm:ss)に整形。
export function fmtCountdown(remainMs) {
  const total = Math.max(0, Math.floor(remainMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
