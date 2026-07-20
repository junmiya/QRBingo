'use strict';

// Stripe Webhook(主催者課金・spec 002)。
// 署名を検証し、checkout.session.completed を受けて entitlements/{uid} を付与する。
// 書き込みは Admin SDK 経由のみ(firestore.rules は entitlements の write を禁止)。
// PII(カード情報・メール)は保持せず、人数上限と有効期限だけを記録する。

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { Timestamp } = require('firebase-admin/firestore');
const { db } = require('./admin');
const { planFromPrice } = require('./lib/plans');

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

const DAY_MS = 24 * 60 * 60 * 1000;

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

    // 署名検証(rawBody を使う=改ざん・なりすまし防止)
    let event;
    try {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.rawBody, sig, whsec);
    } catch (err) {
      console.error('Webhook 署名検証に失敗:', err.message);
      res.status(400).send('signature verification failed');
      return;
    }

    if (event.type !== 'checkout.session.completed') {
      res.status(200).send('ignored');
      return;
    }

    const session = event.data.object;
    if (session.payment_status && session.payment_status !== 'paid') {
      res.status(200).send('not paid');
      return;
    }

    const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
    if (!uid) {
      console.error('Webhook: uid を特定できません', session.id);
      res.status(200).send('no uid');
      return;
    }

    try {
      // 購入した価格を取得(line_items を展開して price.metadata も読む)
      const items = await stripe.checkout.sessions.listLineItems(session.id, {
        limit: 1,
        expand: ['data.price'],
      });
      const li = items.data[0];
      if (!li || !li.price) {
        console.error('Webhook: line item がありません', session.id);
        res.status(200).send('no line item');
        return;
      }
      const priceId = li.price.id;
      const quantity = li.quantity || 1;
      const plan = planFromPrice(priceId, li.price.metadata, isLive);
      if (!plan) {
        console.error('Webhook: プランを解決できません', priceId);
        res.status(200).send('unknown price');
        return;
      }

      const durationMs = plan.durationDays * quantity * DAY_MS;
      const procRef = db.doc(`stripeEvents/${session.id}`);
      const entRef = db.doc(`entitlements/${uid}`);

      await db.runTransaction(async (tx) => {
        // 冪等: 同じ session を二重処理しない(Stripe は再送しうる)
        const done = await tx.get(procRef);
        const cur = await tx.get(entRef);
        if (done.exists) return;

        const now = Date.now();
        let baseMs = now;
        if (cur.exists) {
          const v = cur.data().validUntil;
          const vMs = v && v.toMillis ? v.toMillis() : null;
          // まだ失効していなければ、その期限から延長する(積み増し)
          if (vMs && vMs > now) baseMs = vMs;
        }
        const validUntil = Timestamp.fromMillis(baseMs + durationMs);

        tx.set(
          entRef,
          {
            maxPlayers: plan.maxPlayers,
            plan: plan.plan,
            source: 'stripe',
            validUntil,
            lastPriceId: priceId,
            lastSessionId: session.id,
            updatedAt: Timestamp.fromMillis(now),
          },
          { merge: true }
        );
        tx.set(procRef, {
          uid,
          priceId,
          quantity,
          sessionId: session.id,
          at: Timestamp.fromMillis(now),
        });
      });

      res.status(200).send('ok');
    } catch (err) {
      console.error('Webhook 処理エラー:', err);
      res.status(500).send('error');
    }
  }
);
