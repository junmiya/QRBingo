'use strict';

// Stripe Connect(投げ銭の受け取り・spec 002 Phase B)。
// ホストが Express アカウントを接続し、本人確認・入金は Stripe が担う
// (アプリは資金を保持しない=資金決済法の資金移動業に該当しない設計)。
//
// createConnectAccount: アカウントを作成/取得しオンボーディングURLを返す。
// refreshConnectStatus: 現在の受取可否(charges_enabled)を取得して保存する。

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { Timestamp } = require('firebase-admin/firestore');
const { db } = require('./admin');

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

const ALLOWED_ORIGINS = [
  'https://qrbingo.web.app',
  'https://qrbingo.firebaseapp.com',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
  'http://localhost:8377',
  'http://127.0.0.1:8377',
];

function baseUrl(origin) {
  return ALLOWED_ORIGINS.includes(String(origin || '')) ? origin : ALLOWED_ORIGINS[0];
}

function stripeClient() {
  const key = STRIPE_SECRET_KEY.value();
  if (!key) throw new HttpsError('failed-precondition', '決済が設定されていません(STRIPE_SECRET_KEY 未設定)');
  const Stripe = require('stripe');
  return new Stripe(key);
}

exports.createConnectAccount = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const uid = request.auth.uid;
  const stripe = stripeClient();
  const ref = db.doc(`hostAccounts/${uid}`);

  // 既存のアカウントがあれば再利用、なければ Express アカウントを作成
  let accountId = null;
  const snap = await ref.get();
  if (snap.exists && snap.data().stripeAccountId) {
    accountId = snap.data().stripeAccountId;
  } else {
    const account = await stripe.accounts.create({
      type: 'express',
      // 事業者情報・本人確認は Stripe のオンボーディングで収集(PIIはStripeに隔離)
      capabilities: { transfers: { requested: true } },
      metadata: { uid },
    });
    accountId = account.id;
    await ref.set(
      {
        stripeAccountId: accountId,
        chargesEnabled: false,
        payoutsEnabled: false,
        source: 'stripe',
        updatedAt: Timestamp.fromMillis(Date.now()),
      },
      { merge: true }
    );
  }

  const base = baseUrl(request.data && request.data.origin);
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${base}/online/host.html?connect=refresh`,
    return_url: `${base}/online/host.html?connect=return`,
    type: 'account_onboarding',
  });

  return { url: link.url };
});

exports.refreshConnectStatus = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'サインインが必要です');
  const uid = request.auth.uid;
  const ref = db.doc(`hostAccounts/${uid}`);
  const snap = await ref.get();
  if (!snap.exists || !snap.data().stripeAccountId) {
    return { connected: false, chargesEnabled: false };
  }
  const accountId = snap.data().stripeAccountId;
  const stripe = stripeClient();
  const account = await stripe.accounts.retrieve(accountId);
  const chargesEnabled = !!account.charges_enabled;
  const payoutsEnabled = !!account.payouts_enabled;
  await ref.set(
    {
      chargesEnabled,
      payoutsEnabled,
      updatedAt: Timestamp.fromMillis(Date.now()),
    },
    { merge: true }
  );
  return { connected: true, chargesEnabled, payoutsEnabled };
});
