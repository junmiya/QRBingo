'use strict';

// 投げ銭(スパチャ)の純粋ロジック(spec 002・Phase B)。
// - 決済は Stripe Connect(destination charge)。ホストが直接受け取り、運営は手数料を取る。
// - Stripe 手数料は運営負担(destination charge では既定でプラットフォームが負担する)。
// - 運営手数料率は可変(既定 50%)。config/tips.commissionRate で上書き可能。

const DEFAULT_COMMISSION_RATE = 0.5; // 既定 50%(可変)

// 現時点では投げ銭は運営のみが受領する(主催者への分配なし)。
// true にすると、Stripe Connect を接続済みの主催者へ手数料を差し引いて送金する
// 従来の動作に戻る(接続 UI もマイページに戻すこと)。
const TIPS_TO_HOST_ENABLED = false;
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
  TIPS_TO_HOST_ENABLED,
  TIP_PRESETS,
  TIP_MIN,
  TIP_MAX,
  validateTipAmount,
  normalizeRate,
  computeApplicationFee,
};
