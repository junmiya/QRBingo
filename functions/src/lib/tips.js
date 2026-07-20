'use strict';

// 投げ銭(スパチャ)の純粋ロジック(spec 002・Phase B)。
// - 決済は Stripe Connect(destination charge)。ホストが直接受け取り、運営は手数料を取る。
// - Stripe 手数料は運営負担(destination charge では既定でプラットフォームが負担する)。
// - 運営手数料率は可変(既定 50%)。config/tips.commissionRate で上書き可能。

const DEFAULT_COMMISSION_RATE = 0.5; // 既定 50%(可変)
const TIP_PRESETS = [100, 300, 500, 1000]; // 提示する金額(円)
const TIP_MIN = 100; // JPY の最低(Stripe 最低は¥50だが下限を100に)
const TIP_MAX = 50000;

// 金額(円・整数)の検証。範囲外・非整数は { ok:false }。
function validateTipAmount(amount) {
  const n = Number(amount);
  if (!Number.isInteger(n) || n < TIP_MIN || n > TIP_MAX) return { ok: false };
  return { ok: true, value: n };
}

// 手数料率を 0〜0.9 に丸める。無効値は既定(0.5)。
function normalizeRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r < 0 || r > 0.9) return DEFAULT_COMMISSION_RATE;
  return r;
}

// 運営が受け取る手数料額(円・整数)。ホスト受取 = amount - fee。
function computeApplicationFee(amount, rate) {
  return Math.round(amount * normalizeRate(rate));
}

module.exports = {
  DEFAULT_COMMISSION_RATE,
  TIP_PRESETS,
  TIP_MIN,
  TIP_MAX,
  validateTipAmount,
  normalizeRate,
  computeApplicationFee,
};
