'use strict';

// 投げ銭(スパチャ)の Checkout セッションを作成する Callable(spec 002・Phase B)。
// destination charge でホストの接続アカウントへ送金し、運営は application_fee を受け取る。
// Stripe 手数料は運営負担(destination charge の既定挙動)。
// 勝敗に無関係な「応援」なので賭博に当たらない(legal 前提)。

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { db } = require('./admin');
const {
  validateTipAmount,
  computeApplicationFee,
  DEFAULT_COMMISSION_RATE,
  TIPS_TO_HOST_ENABLED,
  tipReturnUrl,
} = require('./lib/tips');

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

  // 投げ銭は運営への応援。ゲームは任意(ゲームから送ると、そのゲームの全員にアナウンスする)
  const gameId = String(input.gameId || '').trim().toUpperCase();

  const amountR = validateTipAmount(input.amount);
  if (!amountR.ok) throw new HttpsError('invalid-argument', '金額は100〜50000円の範囲で指定してください');
  const amount = amountR.value;

  // ゲーム → ホスト → 接続アカウントを解決(ゲーム指定時のみ)
  let hostUid = null;
  if (gameId) {
    const gameSnap = await db.doc(`games/${gameId}`).get();
    if (!gameSnap.exists) throw new HttpsError('not-found', 'ゲームが見つかりません');
    hostUid = gameSnap.data().hostUid;
  }

  // 現時点では投げ銭はすべて運営が受領する(TIPS_TO_HOST_ENABLED=false)。
  // 有効化した場合のみ、Stripe Connect 接続済みのホストへ振り分ける:
  //  - 接続済み  : destination charge。ホストへ送金し、運営は手数料(既定50%)を受領。
  //  - 未接続    : 通常課金(送金なし)。投げ銭は 100% 運営に入る。
  const acctSnap =
    TIPS_TO_HOST_ENABLED && hostUid ? await db.doc(`hostAccounts/${hostUid}`).get() : null;
  const connected = !!(
    acctSnap &&
    acctSnap.exists &&
    acctSnap.data().stripeAccountId &&
    acctSnap.data().chargesEnabled
  );

  const origin = String(input.origin || '');
  const base = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const backUrl = (state) => tipReturnUrl(base, input.returnPath, gameId, state);

  const Stripe = require('stripe');
  const stripe = new Stripe(STRIPE_SECRET_KEY.value());

  const params = {
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'jpy',
          unit_amount: amount,
          product_data: { name: connected ? 'QRBingo 投げ銭(ホストへの応援)' : 'QRBingo 投げ銭(運営への応援)' },
        },
        quantity: 1,
      },
    ],
    metadata: {
      kind: 'tip',
      ...(gameId ? { gameId, hostUid } : {}),
      fromUid: request.auth.uid,
      amount: String(amount),
      toHost: connected ? '1' : '0',
    },
    success_url: backUrl('thanks'),
    cancel_url: backUrl('cancel'),
  };

  if (connected) {
    const rate = await commissionRate();
    const fee = computeApplicationFee(amount, rate);
    params.payment_intent_data = {
      application_fee_amount: fee, // 運営の取り分(Stripe手数料は運営負担)
      transfer_data: { destination: acctSnap.data().stripeAccountId }, // ホストへ送金
    };
    params.metadata.fee = String(fee); // ホスト受取 = amount - fee
  } else {
    params.metadata.fee = String(amount); // 全額が運営分(ホスト受取 0)
  }

  const session = await stripe.checkout.sessions.create(params);
  return { url: session.url };
});
