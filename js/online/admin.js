// QRBingo オンライン — 運営メニュー(全ゲームの一覧・一時停止・終了)
// 表示は運営者ログイン時のみ。操作の権限はサーバー(adminOps)が検証する。
import { ONLINE_AVAILABLE, onUser, callable } from './firebase-init.js';
import { isAdminUser } from './admin-config.js';

const $ = (id) => document.getElementById(id);
const adminListGamesFn = callable('adminListGames');
const adminPauseGameFn = callable('adminPauseGame');
const adminEndGameFn = callable('adminEndGame');

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
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

$('admin-refresh-btn').addEventListener('click', loadAdminGames);
$('admin-body').addEventListener('click', handleAdminClick);

if (!ONLINE_AVAILABLE) {
  $('conn-status').textContent = 'オンライン機能が有効化されていません。';
} else {
  let loaded = false;
  onUser((u) => {
    $('conn-status').hidden = true;
    const admin = isAdminUser(u);
    $('admin-panel').hidden = !admin;
    $('admin-denied').hidden = admin;
    if (admin && !loaded) {
      loaded = true;
      loadAdminGames();
    }
  });
}
