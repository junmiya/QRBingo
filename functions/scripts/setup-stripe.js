'use strict';

/*
 * QRBingo の Stripe 商品/価格を作成する冪等スクリプト。
 *
 * 使い方(あなたの Stripe アカウントで実行):
 *   1) cd functions && npm install
 *   2) テストモードでまず作成:
 *        STRIPE_SECRET_KEY=sk_test_xxx npm run setup-stripe
 *   3) 動作確認後、本番でも作成:
 *        STRIPE_SECRET_KEY=sk_live_xxx npm run setup-stripe
 *
 * 冪等: lookup_key で既存 Price を検出し、あれば再利用(重複作成しない)。
 * 何度実行しても安全です。作成された Price ID / lookup_key を最後に一覧表示します。
 *
 * 価格モデル(spec 002): すべて一回払い(mode=payment)。購入で一定期間の
 * entitlement(人数上限)を付与する。metadata.maxPlayers / durationDays を
 * Webhook が読んで entitlement を計算するため、Functions 側に価格IDのハードコードは不要。
 * JPY はゼロ小数通貨なので unit_amount は円そのもの(1000 = ¥1,000)。
 */

const Stripe = require('stripe');

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('環境変数 STRIPE_SECRET_KEY が未設定です。');
  console.error('例: STRIPE_SECRET_KEY=sk_test_xxx npm run setup-stripe');
  process.exit(1);
}
const MODE = KEY.startsWith('sk_live_') ? 'LIVE(本番)' : 'TEST(テスト)';
const stripe = new Stripe(KEY);

const PRODUCT_META_KEY = 'qrbingo_host_plan';

// 作成する価格カタログ。lookup_key で冪等管理。
// kind: onetime=都度(1ヶ月・複数月は数量で対応) / annual=年
const PRICES = [
  {
    lookup_key: 'qrbingo_onetime_300',
    nickname: '都度 300人 (1ヶ月)',
    unit_amount: 1000,
    metadata: { maxPlayers: '300', durationDays: '30', kind: 'onetime' },
  },
  {
    lookup_key: 'qrbingo_onetime_1000',
    nickname: '都度 1000人 (1ヶ月)',
    unit_amount: 3000,
    metadata: { maxPlayers: '1000', durationDays: '30', kind: 'onetime' },
  },
  {
    lookup_key: 'qrbingo_annual_300',
    nickname: '年 300人',
    unit_amount: 3000,
    metadata: { maxPlayers: '300', durationDays: '365', kind: 'annual' },
  },
  {
    lookup_key: 'qrbingo_annual_1000',
    nickname: '年 1000人',
    unit_amount: 10000,
    metadata: { maxPlayers: '1000', durationDays: '365', kind: 'annual' },
  },
];

async function findOrCreateProduct() {
  // metadata で既存商品を探す(冪等)
  const existing = await stripe.products.list({ active: true, limit: 100 });
  const found = existing.data.find((p) => p.metadata && p.metadata[PRODUCT_META_KEY] === '1');
  if (found) {
    console.log(`商品を再利用: ${found.id} (${found.name})`);
    return found;
  }
  const created = await stripe.products.create({
    name: 'QRBingo ホストプラン',
    description: '1ゲームの最大参加人数を引き上げるプラン(都度/年)',
    metadata: { [PRODUCT_META_KEY]: '1' },
  });
  console.log(`商品を作成: ${created.id} (${created.name})`);
  return created;
}

async function findOrCreatePrice(productId, spec) {
  const existing = await stripe.prices.list({ lookup_keys: [spec.lookup_key], limit: 1 });
  if (existing.data.length > 0) {
    const p = existing.data[0];
    console.log(`  価格を再利用: ${spec.lookup_key.padEnd(24)} ${p.id} (¥${p.unit_amount})`);
    return p;
  }
  const created = await stripe.prices.create({
    product: productId,
    currency: 'jpy',
    unit_amount: spec.unit_amount,
    nickname: spec.nickname,
    lookup_key: spec.lookup_key,
    metadata: spec.metadata,
  });
  console.log(`  価格を作成: ${spec.lookup_key.padEnd(24)} ${created.id} (¥${created.unit_amount})`);
  return created;
}

async function main() {
  console.log(`=== QRBingo Stripe セットアップ [${MODE}] ===\n`);
  const product = await findOrCreateProduct();
  console.log('価格:');
  const results = [];
  for (const spec of PRICES) {
    const price = await findOrCreatePrice(product.id, spec);
    results.push({ lookup_key: spec.lookup_key, id: price.id, amount: price.unit_amount });
  }

  console.log('\n=== 完了 ===');
  console.log('以下の lookup_key を Functions が参照します(価格IDのハードコードは不要):');
  for (const r of results) {
    console.log(`  ${r.lookup_key.padEnd(24)} = ${r.id}  (¥${r.amount})`);
  }
  console.log('\n1000人超のカスタムプランは Stripe ダッシュボードで個別の価格を作成し、');
  console.log('metadata に maxPlayers / durationDays / kind を設定してください。');
  console.log(`\nこのモード: ${MODE}。テストで確認したら sk_live_ キーで再実行して本番にも作成してください。`);
}

main().catch((err) => {
  console.error('\nエラー:', err.message || err);
  process.exit(1);
});
