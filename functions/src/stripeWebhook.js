'use strict';

// Stripe Webhook(spec 002)。署名を検証し、以下を処理する:
//  - checkout.session.completed(プラン購入)→ entitlements/{uid} を付与
//  - checkout.session.completed(投げ銭 kind=tip)→ ゲームの投げ銭を記録
//  - account.updated(Connect)→ hostAccounts の受取可否を更新
// 書き込みは Admin SDK 経由のみ(firestore.rules は該当コレクションの write を禁止)。
// PII(カード情報・メール)は保持せず、状態フラグと金額だけを記録する。

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');
const { db } = require('./admin');
const { planFromPrice } = require('./lib/plans');
const { appendFeed } = require('./lib/feed');

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

const DAY_MS = 24 * 60 * 60 * 1000;

// --- プラン購入 → entitlement 付与 ---
async function handlePlanPurchase(stripe, session, isLive, uid) {
  const items = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 1,
    expand: ['data.price'],
  });
  const li = items.data[0];
  if (!li || !li.price) return 'no line item';
  const priceId = li.price.id;
  const quantity = li.quantity || 1;
  const plan = planFromPrice(priceId, li.price.metadata, isLive);
  if (!plan) return 'unknown price';

  const durationMs = plan.durationDays * quantity * DAY_MS;
  const procRef = db.doc(`stripeEvents/${session.id}`);
  const entRef = db.doc(`entitlements/${uid}`);

  await db.runTransaction(async (tx) => {
    const done = await tx.get(procRef);
    const cur = await tx.get(entRef);
    if (done.exists) return; // 冪等(二重配信を無視)

    const now = Date.now();
    let baseMs = now;
    if (cur.exists) {
      const v = cur.data().validUntil;
      const vMs = v && v.toMillis ? v.toMillis() : null;
      if (vMs && vMs > now) baseMs = vMs; // 未失効なら延長(積み増し)
    }
    tx.set(
      entRef,
      {
        maxPlayers: plan.maxPlayers,
        plan: plan.plan,
        source: 'stripe',
        validUntil: Timestamp.fromMillis(baseMs + durationMs),
        lastPriceId: priceId,
        lastSessionId: session.id,
        updatedAt: Timestamp.fromMillis(now),
      },
      { merge: true }
    );
    tx.set(procRef, { kind: 'plan', uid, priceId, quantity, sessionId: session.id, at: Timestamp.fromMillis(now) });
  });
  return 'ok';
}

// --- 投げ銭 → ゲームに記録(entitlement は変えない) ---
async function handleTip(session) {
  const md = session.metadata || {};
  const gameId = md.gameId;
  if (!gameId) return 'no gameId';
  const amount = Number(md.amount) || session.amount_total || 0;
  const fee = Number(md.fee) || 0;
  const net = Math.max(0, amount - fee);

  const procRef = db.doc(`stripeEvents/${session.id}`);
  const tipRef = db.doc(`games/${gameId}/tips/${session.id}`);
  const gameRef = db.doc(`games/${gameId}`);

  let firstTime = false;
  await db.runTransaction(async (tx) => {
    const done = await tx.get(procRef);
    if (done.exists) return; // 冪等
    firstTime = true;
    const now = Date.now();
    tx.set(tipRef, {
      amount,
      fee,
      net,
      fromUid: md.fromUid || null,
      hostUid: md.hostUid || null,
      at: Timestamp.fromMillis(now),
    });
    // ゲームに集計(ホスト受取ベース net と件数)。配信画面での表示にも使える。
    tx.set(
      gameRef,
      { tipTotalNet: FieldValue.increment(net), tipCount: FieldValue.increment(1) },
      { merge: true }
    );
    tx.set(procRef, { kind: 'tip', gameId, amount, fee, sessionId: session.id, at: Timestamp.fromMillis(now) });
  });

  // 全員に「応援」をアナウンス(スーパーチャット風・二重配信時は出さない)
  if (firstTime) {
    let nickname = '応援';
    try {
      const cardSnap = md.fromUid ? await db.doc(`cards/${gameId}_${md.fromUid}`).get() : null;
      if (cardSnap && cardSnap.exists && cardSnap.data().nickname) nickname = cardSnap.data().nickname;
    } catch (e) {
      /* ニックネーム取得失敗時は既定名で通知 */
    }
    await appendFeed(gameId, { type: 'tip', nickname, amount });
  }
  return 'ok';
}

// --- Connect アカウント更新 → 受取可否を反映 ---
async function handleAccountUpdated(account) {
  let uid = account.metadata && account.metadata.uid;
  if (!uid) {
    const q = await db.collection('hostAccounts').where('stripeAccountId', '==', account.id).limit(1).get();
    if (!q.empty) uid = q.docs[0].id;
  }
  if (!uid) return 'no uid';
  await db.doc(`hostAccounts/${uid}`).set(
    {
      chargesEnabled: !!account.charges_enabled,
      payoutsEnabled: !!account.payouts_enabled,
      updatedAt: Timestamp.fromMillis(Date.now()),
    },
    { merge: true }
  );
  return 'ok';
}

exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const key = STRIPE_SECRET_KEY.value();
    const whsec = STRIPE_WEBHOOK_SECRET.value();
    if (!key || !whsec) {
      res.status(500).send('not configured');
      return;
    }

    const Stripe = require('stripe');
    const stripe = new Stripe(key);
    const isLive = key.startsWith('sk_live_');

    let event;
    try {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.rawBody, sig, whsec);
    } catch (err) {
      console.error('Webhook 署名検証に失敗:', err.message);
      res.status(400).send('signature verification failed');
      return;
    }

    try {
      if (event.type === 'account.updated') {
        const result = await handleAccountUpdated(event.data.object);
        res.status(200).send(result);
        return;
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        if (session.payment_status && session.payment_status !== 'paid') {
          res.status(200).send('not paid');
          return;
        }
        const kind = session.metadata && session.metadata.kind;
        if (kind === 'tip') {
          res.status(200).send(await handleTip(session));
          return;
        }
        const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
        if (!uid) {
          console.error('Webhook: uid を特定できません', session.id);
          res.status(200).send('no uid');
          return;
        }
        res.status(200).send(await handlePlanPurchase(stripe, session, isLive, uid));
        return;
      }

      res.status(200).send('ignored');
    } catch (err) {
      console.error('Webhook 処理エラー:', err);
      res.status(500).send('error');
    }
  }
);
