'use strict';

const { db } = require('../admin');

// 無料プランの既定上限(spec 002: 無料は20人・運営がカスタム可)
const FREE_MAX_PLAYERS = 20;

// ホストの entitlement を取得する。未設定・期限切れは無料(20人)扱い。
// 返り値: { maxPlayers, plan, expired }
async function getEntitlement(uid) {
  const snap = await db.doc(`entitlements/${uid}`).get();
  if (!snap.exists) {
    return { maxPlayers: FREE_MAX_PLAYERS, plan: 'free', expired: false };
  }
  const e = snap.data();
  const validUntil = e.validUntil ? e.validUntil.toMillis() : null;
  const expired = validUntil != null && validUntil < Date.now();
  if (expired) {
    // 期限切れは無料に戻す(サーバー時刻基準・FR-M3)
    return { maxPlayers: FREE_MAX_PLAYERS, plan: 'free', expired: true };
  }
  const maxPlayers =
    Number.isInteger(e.maxPlayers) && e.maxPlayers > 0 ? e.maxPlayers : FREE_MAX_PLAYERS;
  return { maxPlayers, plan: e.plan || 'free', expired: false };
}

module.exports = { getEntitlement, FREE_MAX_PLAYERS };
