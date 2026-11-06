// QRBingo オンライン — プラン(参加上限)の表示用ヘルパー。
// 上限の強制はサーバー(createGame)が行う。ここは表示だけ。
export const FREE_MAX_PLAYERS = 20;

export function planSummary(ent) {
  let maxPlayers = FREE_MAX_PLAYERS;
  let label = null; // null = 無料
  if (ent && Number.isInteger(ent.maxPlayers) && ent.maxPlayers > 0) {
    const validMs = ent.validUntil && ent.validUntil.toMillis ? ent.validUntil.toMillis() : null;
    const expired = validMs != null && validMs < Date.now();
    if (!expired) {
      maxPlayers = ent.maxPlayers;
      label = `${ent.plan || '有料'}プラン`;
    }
  }
  const text = label
    ? `現在のプラン: ${label}(1ゲーム最大 ${maxPlayers} 人)`
    : `現在のプラン: 無料(1ゲーム最大 ${maxPlayers} 人)`;
  return { maxPlayers, text };
}
