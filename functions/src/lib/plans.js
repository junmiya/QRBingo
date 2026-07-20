'use strict';

// 課金プラン定義(spec 002・主催者課金)。
// すべて一回払い(One-off)。購入で maxPlayers の上限を durationDays 日ぶん付与する。
// 期限管理は Stripe の自動更新に頼らず、Webhook が entitlements/{uid}.validUntil に付与する。
const PLANS = {
  onetime_300: { label: '都度 300人', maxPlayers: 300, durationDays: 30, price: 1000, multiMonth: true },
  onetime_1000: { label: '都度 1000人', maxPlayers: 1000, durationDays: 30, price: 3000, multiMonth: true },
  annual_300: { label: '年 300人', maxPlayers: 300, durationDays: 365, price: 3000, multiMonth: false },
  annual_1000: { label: '年 1000人', maxPlayers: 1000, durationDays: 365, price: 10000, multiMonth: false },
};

// Stripe Price ID → planKey。テスト(sandbox)と本番(live)でカタログが別なので分ける。
// 価格IDは秘密情報ではない(公開されても安全)。本番の価格を作成したら LIVE 側に追記する。
const PRICE_TO_PLAN_TEST = {
  price_1Tv5Fm3fM9MR8XaqcH0ksLTZ: 'onetime_300',
  price_1Tv5Ie3fM9MR8XaqhRVCgmZM: 'onetime_1000',
  price_1Tv5J63fM9MR8XaqW0zUMCxi: 'annual_300',
  price_1Tv5JR3fM9MR8XaqJJbgH4Vy: 'annual_1000',
};
const PRICE_TO_PLAN_LIVE = {
  price_1TvF8R3fM9MR8XaqeDq5YArB: 'onetime_300',
  price_1TvF8p3fM9MR8XaqOOHrDllb: 'onetime_1000',
  price_1TvF9J3fM9MR8XaquzVlZRPe: 'annual_300',
  price_1TvF9c3fM9MR8Xaq3IHLDX3L: 'annual_1000',
  // metadata(maxPlayers/durationDays/kind)を設定した価格なら、この表になくても
  // planFromPrice が metadata から解決する(setup-stripe.js 経由で作成した場合)。
};

function priceMap(isLive) {
  return isLive ? PRICE_TO_PLAN_LIVE : PRICE_TO_PLAN_TEST;
}

// planKey → Price ID(mode 別)。未登録なら null。Checkout セッション作成で使う。
function priceIdForPlan(planKey, isLive) {
  const map = priceMap(isLive);
  for (const [priceId, key] of Object.entries(map)) {
    if (key === planKey) return priceId;
  }
  return null;
}

// Price ID → 付与内容 { maxPlayers, durationDays, plan }。
// まず price.metadata(maxPlayers/durationDays)を優先し、なければ mode 別マップで解決する。
// Webhook が entitlement を計算するのに使う。
function planFromPrice(priceId, metadata, isLive) {
  const md = metadata || {};
  const mdMax = parseInt(md.maxPlayers, 10);
  const mdDur = parseInt(md.durationDays, 10);
  if (Number.isInteger(mdMax) && mdMax > 0 && Number.isInteger(mdDur) && mdDur > 0) {
    return { maxPlayers: mdMax, durationDays: mdDur, plan: md.kind || 'paid' };
  }
  const key = priceMap(isLive)[priceId] || PRICE_TO_PLAN_TEST[priceId] || PRICE_TO_PLAN_LIVE[priceId];
  if (key && PLANS[key]) {
    const p = PLANS[key];
    return { maxPlayers: p.maxPlayers, durationDays: p.durationDays, plan: key };
  }
  return null;
}

module.exports = {
  PLANS,
  priceIdForPlan,
  planFromPrice,
  PRICE_TO_PLAN_TEST,
  PRICE_TO_PLAN_LIVE,
};
