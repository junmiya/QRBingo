// 確定ランキング(当選コード・受け渡し管理)の共通部品。ホスト画面とマイページで使う。
// - 当選コードは既定で伏せて表示し、「当選コードを表示」で切り替える
// - ログイン中の主催者は、当選者の画面の QR をカメラで読み取って照合できる
//   (照合はこの主催者だけが読める private/results と突き合わせる)
import { callable, readDocPath } from './firebase-init.js';
import { openWinScanner } from './win-scanner.js';
import { parseWinQr } from './wincode.js';

const markWinnerHandledFn = callable('markWinnerHandled');
const hideNicknameFn = callable('hideNickname');

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// 同着(同じ球目でビンゴ)の表示。順位は同じで、景品数を超える場合のみ終了時に抽選。
export function tieBadge(e) {
  return e.tied ? ' <span class="tie-badge">同率</span>' : '';
}

const MASK = '••••••••';

// 確定ランキングの表(HTML)。showCodes=false なら当選コードを伏せる。
export function renderResultsTable(entries, { gameId, showCodes }) {
  const rows = entries
    .map((e) => {
      const cardId = `${gameId}_${e.uid}`;
      const winCell = e.isWinner
        ? `<span class="wincode-cell">${showCodes ? esc(e.winCode) : MASK}</span>`
        : '<span class="hint">—</span>';
      const status = e.isWinner
        ? `<span class="handled-badge ${e.handled ? 'done' : ''}">${e.handled ? '対応済み' : '未対応'}</span>`
        : '';
      const handleBtn = e.isWinner
        ? `<button data-action="handle" data-winner="${cardId}" data-handled="${e.handled ? '1' : '0'}">${e.handled ? '取消' : '対応済'}</button>`
        : '';
      const hideBtn = `<button data-action="hide" data-card="${cardId}" data-hidden="${e.nicknameHidden ? '1' : '0'}">${e.nicknameHidden ? '再表示' : '非表示'}</button>`;
      return `<tr class="${e.isWinner ? 'is-winner' : ''} ${e.handled ? 'handled' : ''}">
        <td class="rank-col">${e.rank}${tieBadge(e)}</td>
        <td>${esc(e.nickname)}${e.nicknameHidden ? ' <span class="hint">(伏字中)</span>' : ''}</td>
        <td>${e.achievedBallIndex}球目</td>
        <td>${winCell} ${status}</td>
        <td><div class="row-actions">${handleBtn}${hideBtn}</div></td>
      </tr>`;
    })
    .join('');
  return `<table class="leaderboard"><thead><tr>
       <th>順位</th><th>ニックネーム</th><th>成立</th><th>当選コード</th><th></th>
     </tr></thead><tbody>${rows}</tbody></table>`;
}

// 表内のボタン(対応済み・非表示)。変更は購読側(private/results)で再描画される。
export async function handleResultsClick(ev, gameId) {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  btn.disabled = true;
  try {
    if (btn.dataset.action === 'handle') {
      await markWinnerHandledFn({ gameId, winnerId: btn.dataset.winner, handled: btn.dataset.handled !== '1' });
    } else if (btn.dataset.action === 'hide') {
      await hideNicknameFn({ gameId, cardId: btn.dataset.card, hidden: btn.dataset.hidden !== '1' });
    }
  } catch (err) {
    alert(err.message || String(err));
    btn.disabled = false;
  }
}

// ---------- QR 読み取り → 照合 → 確認 → 対応済み ----------
let verifyDialog = null;
function ensureVerifyDialog() {
  if (verifyDialog) return verifyDialog;
  verifyDialog = document.createElement('dialog');
  verifyDialog.id = 'win-verify-dialog';
  document.body.appendChild(verifyDialog);
  return verifyDialog;
}

// 読み取った文字列を照合する。結果 { ok, message } か { ok:true, gameId, entry }。
// expectedGameId を渡すと、そのゲーム以外のコードは受け付けない。
export async function verifyWinText(text, { expectedGameId, myUid }) {
  const parsed = parseWinQr(text);
  if (!parsed) return { ok: false, message: 'QRBingo の当選コードではありません。' };
  if (expectedGameId && parsed.gameId && parsed.gameId !== expectedGameId) {
    return { ok: false, message: `このゲーム(${expectedGameId})の当選コードではありません(ゲーム ${parsed.gameId} のコードです)。` };
  }
  const gameId = parsed.gameId || expectedGameId;
  if (!gameId) return { ok: false, message: 'ゲームを特定できません。対象ゲームの「結果」から読み取ってください。' };
  const game = await readDocPath(['games', gameId]).catch(() => null);
  if (!game || game.hostUid !== myUid) {
    return { ok: false, message: `あなたが主催したゲームの当選コードではありません(ゲーム ${gameId})。` };
  }
  const results = await readDocPath(['games', gameId, 'private', 'results']).catch(() => null);
  if (!results || !results.entries) return { ok: false, message: `ゲーム ${gameId} はまだ順位が確定していません。` };
  const entry = results.entries.find((e) => e.isWinner && e.winCode === parsed.winCode);
  if (!entry) return { ok: false, message: `当選コードが一致しません(ゲーム ${gameId} の当選者ではありません)。` };
  return { ok: true, gameId, entry };
}

// 読み取り〜確認〜対応済みまでの一連の流れ。続けて読み取る場合は繰り返す。
export async function scanAndVerify({ expectedGameId = null, myUid }) {
  const text = await openWinScanner();
  if (text == null) return;
  const result = await verifyWinText(text, { expectedGameId, myUid });
  showVerifyResult(result, { expectedGameId, myUid });
}

function showVerifyResult(result, ctx) {
  const dlg = ensureVerifyDialog();
  if (!result.ok) {
    dlg.innerHTML = `
      <h2 style="margin-top:0">照合できません</h2>
      <p class="verify-result ng">${esc(result.message)}</p>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn-primary" data-v="again" type="button">もう一度読み取る</button>
        <button class="btn-ghost" data-v="close" type="button">閉じる</button>
      </div>`;
  } else {
    const e = result.entry;
    dlg.innerHTML = `
      <h2 style="margin-top:0">当選コードを確認しました</h2>
      <p class="verify-result ok">ゲーム ${esc(result.gameId)} ・ <strong>${e.rank}位${e.tied ? '(同率)' : ''}</strong> ・ ${esc(e.nickname)}</p>
      <p class="hint">${e.handled ? 'この当選者は<strong>対応済み</strong>です(景品を渡し済み)。' : '景品を渡したら「対応済みにする」を押してください。'}</p>
      <div class="btn-row" style="margin-top:12px">
        ${e.handled
          ? '<button class="btn-ghost" data-v="undo" type="button">対応済みを取り消す</button>'
          : '<button class="btn-primary" data-v="handle" type="button">景品を渡した(対応済みにする)</button>'}
        <button class="btn-ghost" data-v="again" type="button">続けて読み取る</button>
        <button class="btn-ghost" data-v="close" type="button">閉じる</button>
      </div>
      <p class="hint error-text verify-error"></p>`;
  }
  dlg.onclick = async (ev) => {
    const btn = ev.target.closest('button[data-v]');
    if (!btn) return;
    const v = btn.dataset.v;
    if (v === 'close') return dlg.close();
    if (v === 'again') {
      dlg.close();
      return scanAndVerify(ctx);
    }
    btn.disabled = true;
    try {
      await markWinnerHandledFn({
        gameId: result.gameId,
        winnerId: `${result.gameId}_${result.entry.uid}`,
        handled: v === 'handle',
      });
      showVerifyResult({ ...result, entry: { ...result.entry, handled: v === 'handle' } }, ctx);
    } catch (err) {
      dlg.querySelector('.verify-error').textContent = err.message || String(err);
      btn.disabled = false;
    }
  };
  if (!dlg.open) dlg.showModal();
}
