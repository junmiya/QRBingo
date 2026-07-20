'use strict';

// 投げ銭(スパチャ)の Checkout セッションを作成する Callable(spec 002・Phase B)。
// destination charge でホストの接続アカウントへ送金し、運営は application_fee を受け取る。
// Stripe 手数料は運営負担(destination charge の既定挙動)。
// 勝敗に無関係な「応援」なので賭博に当たらない(legal 前提)。

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { db } = require('./admin');
const { validateTipAmount, computeApplicationFee, DEFAULT_COMMISSION_RATE } = require('./lib/tips');

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

const ALLOWED_ORIGINS = [
  'https://qrbingo.web.app',
  'https://qrbingo.firebaseapp.com',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://localhost:8377',
  'http://127.0.0.1:8377',
];

// 運営手数料率(可変)。config/tips.commissionRate があれば採用、なければ既定50%。
async function commissionRate() {
  try {
    const snap = await db.doc('config/tips').get();
    if (snap.exists && snap.data().commissionRate != null) {
      return Number(snap.data().commissionRate);
    }
  } catch (e) {
    /* 取得失敗時は既定 */
  }
  return DEFAULT_COMMISSION_RATE;
}

exports.createTipCheckout = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const input = request.data || {};

  const gameId = String(input.gameId || '');
  if (!gameId) throw new HttpsError('invalid-argument', 'ゲームIDが必要です');

  const amountR = validateTipAmount(input.amount);
  if (!amountR.ok) throw new HttpsError('invalid-argument', '金額は100〜50000円の範囲で指定してください');
  const amount = amountR.value;

  // ゲーム → ホスト → 接続アカウントを解決
  const gameSnap = await db.doc(`games/${gameId}`).get();
  if (!gameSnap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
  const hostUid = gameSnap.data().hostUid;

  const acctSnap = await db.doc(`hostAccounts/${hostUid}`).get();
  if (!acctSnap.exists || !acctSnap.data().stripeAccountId || !acctSnap.data().chargesEnabled) {
    throw new HttpsError('failed-precondition', 'このゲームは投げ銭を受け付けていません');
  }
  const destination = acctSnap.data().stripeAccountId;

  const rate = await commissionRate();
  const fee = computeApplicationFee(amount, rate);

  const origin = String(input.origin || '');
  const base = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  const Stripe = require('stripe');
  const stripe = new Stripe(STRIPE_SECRET_KEY.value());

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'jpy',
          unit_amount: amount,
          product_data: { name: 'QRBingo 投げ銭(ホストへの応援)' },
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: fee, // 運営の取り分(Stripe手数料は運営負担)
      transfer_data: { destination }, // ホストの接続アカウントへ送金
    },
    metadata: {
      kind: 'tip',
      gameId,
      hostUid,
      fromUid: request.auth.uid,
      amount: String(amount),
      fee: String(fee),
    },
    success_url: `${base}/online/player.html?g=${encodeURIComponent(gameId)}&tip=thanks`,
    cancel_url: `${base}/online/player.html?g=${encodeURIComponent(gameId)}&tip=cancel`,
  });

  return { url: session.url };
});
