// 当選コードの QR 表現。ゲームを特定できるよう「QRBINGO-WIN:<ゲームコード>:<当選コード>」を載せる。
// 当選コード単体(WIN-XXXXXXXXX)も受け付ける(ゲームは読み取り側の画面で特定する)。
const PREFIX = 'QRBINGO-WIN:';
const WIN_CODE_RE = /^WIN-[A-Z0-9]{6,16}$/;
const GAME_ID_RE = /^[A-Z0-9]{4,8}$/;

export function winQrText(gameId, winCode) {
  return `${PREFIX}${gameId}:${winCode}`;
}

// 読み取った文字列 → { gameId|null, winCode } / 当選コードでなければ null
export function parseWinQr(text) {
  const t = String(text || '').trim().toUpperCase();
  if (t.startsWith(PREFIX)) {
    const [gameId, winCode] = t.slice(PREFIX.length).split(':');
    if (GAME_ID_RE.test(gameId || '') && WIN_CODE_RE.test(winCode || '')) return { gameId, winCode };
    return null;
  }
  return WIN_CODE_RE.test(t) ? { gameId: null, winCode: t } : null;
}
