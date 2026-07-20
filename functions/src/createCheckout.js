'use strict';

// Stripe Checkout セッションを作成する Callable(主催者課金・spec 002)。
// クライアントには URL だけを返し、実際の決済は Stripe のホスト画面で行う
// (カード情報はアプリを通らず Stripe に隔離=PIIフリー原則を維持)。
// 支払い完了は stripeWebhook が受け取り、entitlements/{uid} を付与する。

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { PLANS, priceIdForPlan } = require('./lib/plans');

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

// リダイレクト先の許可リスト(オープンリダイレクト防止)。
// 公開URL・Hosting/Functions エミュレータ・静的サーバを許可する。
const ALLOWED_ORIGINS = [
  'https://qrbingo.web.app',
  'https://qrbingo.firebaseapp.com',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://localhost:8377',
  'http://127.0.0.1:8377',
];

exports.createCheckout = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const input = request.data || {};

  const planKey = String(input.plan || '');
  const plan = PLANS[planKey];
  if (!plan) throw new HttpsError('invalid-argument', '不明なプランです');

  // 都度プランのみ複数月(数量)を許可。年プランは数量1固定。
  let quantity = 1;
  if (plan.multiMonth && input.months !== undefined && input.months !== null) {
    const m = Number(input.months);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new HttpsError('invalid-argument', '契約月数は 1〜12 で指定してください');
    }
    quantity = m;
  }

  const key = STRIPE_SECRET_KEY.value();
  if (!key) throw new HttpsError('failed-precondition', '決済が設定されていません(STRIPE_SECRET_KEY 未設定)');
  const isLive = key.startsWith('sk_live_');

  const priceId = priceIdForPlan(planKey, isLive);
  if (!priceId) {
    throw new HttpsError(
      'failed-precondition',
      isLive ? '本番の価格が未登録です。管理者にお問い合わせください' : 'テスト用の価格が未登録です'
    );
  }

  const origin = String(input.origin || '');
  const base = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  const Stripe = require('stripe');
  const stripe = new Stripe(key);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: priceId, quantity }],
    // 匿名UIDと購入を Webhook で紐づけるための最小情報(PIIではない)
    client_reference_id: request.auth.uid,
    metadata: { uid: request.auth.uid, planKey, quantity: String(quantity) },
    success_url: `${base}/online/host.html?checkout=success`,
    cancel_url: `${base}/online/host.html?checkout=cancel`,
  });

  return { url: session.url };
});
