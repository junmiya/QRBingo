# Feature Specification: 課金(マネタイズ)

**Feature Branch**: `claude/qr-code-bingo-game-y9ix04`
**Created**: 2026-07-19
**Status**: Draft(Phase A 着手)
**Input**: 主催者課金(人数上限つきプラン)とユーザ課金(投げ銭・装飾)。決済は Stripe。

---

## 法務の大前提(設計を規定する)

- **「参加者が有料参加して賞品を得る」= 賭博罪リスク → 実装しない。** 有料参加チケットは作らない。
- **投げ銭(勝敗に無関係)は適法。** ただしアプリが資金を保持しないよう **Stripe Connect** で
  決済〜ホスト入金を Stripe に担わせ、運営はプラットフォーム手数料のみ受領。
- 装飾アイテム(勝敗に無関係)は通常のデジタル物販。
- 有料サービスには **特商法表記・利用規約・プライバシーポリシー** が必須。
- **PIIフリー原則(憲章II)維持**: カード情報・メール等は Stripe 側に隔離し、
  Firestore には課金状態フラグ(プラン・上限・有効期限)のみ保存する。憲章の逸脱に当たる
  「ホストのログイン用メール保持」は Firebase Auth 側に保持され Firestore には保存しない。

---

## 課金モデル(確定)

### 主催者課金(Phase A)
「1ゲームあたりの最大参加人数」を上限とするプラン制。運営が任意に上限を調整可能。

| プラン | 上限人数 | 価格 | 種別 |
|---|---|---|---|
| 無料 | **20人**(運営がカスタム可) | ¥0 | 恒久 |
| 都度 300 | 300人 | **¥1,000**(複数月契約可) | 1ヶ月相当パス |
| 都度 1000 | 1,000人 | **¥3,000** | 1ヶ月相当パス |
| 都度 カスタム | 1,000超 | 個別見積 | 個別 |
| 年 300 | 300人 | **¥3,000/年** | 年額 |
| 年 1000 | 1,000人 | **¥10,000/年** | 年額 |

- 「都度=1ヶ月相当」で分かりやすく。年額は割安。
- 有効期限つき(都度=購入から1ヶ月、年=1年)。切れたら無料(20人)に戻る。

### ユーザ課金
- **投げ銭(Phase B)**: 参加者→ホストへ任意のチップ(Stripe Connect)。
  運営手数料は**可変・既定50%**。参加者へ「運営手数料込み」と明示。
- **スパチャ相殺(Phase B)**: あるゲームで運営が得た投げ銭手数料が、そのホストの
  参加費(プラン料金)以上になったら参加費を実質無料化(運営は損しない自己資金方式)。
- **装飾アイテム(Phase C)**: カード配色・演出など勝敗無関係の物販。

### 費用負担
- **Stripe 実費(約3.6%)は運営負担**(ホストの手取り・チップ額から差し引かない)。

---

## Functional Requirements

- **FR-M1**: 各ホストは entitlement(`{ maxPlayers, validUntil }`)を持つ。未設定は無料(20人・無期限)。
- **FR-M2**: `createGame` は entitlement を検証し、要求 capacity が maxPlayers を超えたら拒否
  (アップグレード導線用のエラー)。capacity 未指定は maxPlayers に丸める(無料の「無制限」を禁止)。
- **FR-M3**: entitlement は有効期限切れなら無料扱いに戻る(サーバー時刻基準)。
- **FR-M4**: entitlement の付与は Stripe Webhook(購入時)または運営の手動設定のみ。
  クライアント直接 write は禁止(`allow write: if false` 維持、サーバー権威=憲章I)。
- **FR-M5**: サブスク/都度購入は Stripe Checkout。購入完了で entitlement を書き込む。
- **FR-M6**(Phase B): 投げ銭は Stripe Connect。運営手数料は可変(既定50%)。
- **FR-M7**(Phase B): ゲーム単位で「投げ銭手数料 ≥ プラン料金」なら参加費を相殺(無料化)。
- **FR-M8**: PII(カード・メール)は Firestore に保存しない。
- **FR-M9**: `createCheckout`(Callable)はプランキーを受け取り、mode(sk_test/sk_live)に
  応じた Price ID で Stripe Checkout セッションを作成し URL を返す。都度プランのみ
  `months`(1〜12)で数量=複数月を許可。リダイレクト先は許可リストで検証(オープンリダイレクト防止)。
- **FR-M10**: `stripeWebhook`(HTTP)は署名を検証し、`checkout.session.completed`(paid)で
  entitlement を付与する。付与期間 = `durationDays × quantity`。未失効なら現行期限から延長(積み増し)。
  `stripeEvents/{sessionId}` で冪等化(二重配信を無視)。
- **FR-M11**: Price ID → プランは `functions/src/lib/plans.js` で管理。price.metadata
  (maxPlayers/durationDays)があればそれを優先し、なければ mode 別マップで解決する。

## 段階リリース

- **Phase A**(本着手): entitlement モデル + `createGame` ゲート + 無料20人の強制。
  次いで Stripe Checkout(都度/年)+ Webhook + ホストのアカウント昇格(Google/メール)。
- **Phase B**: 投げ銭(Connect)+ 手数料 + スパチャ相殺。
- **Phase C**: 装飾アイテム物販。
- 各フェーズで特商法/規約/プライバシーポリシーを整備。

## データモデル

### entitlements/{uid}
| フィールド | 型 | 説明 |
|---|---|---|
| maxPlayers | number | 1ゲームの最大参加人数(無料=20) |
| validUntil | Timestamp\|null | 有効期限(null=無期限)。過去なら無料扱い |
| plan | string | 表示用ラベル(free/onetime_300/annual_1000/custom 等) |
| source | string | free \| stripe \| admin |
| lastPriceId | string | 直近購入の Stripe Price ID |
| lastSessionId | string | 直近の Checkout セッションID |
| updatedAt | Timestamp | |

- read: 本人のみ / write: Functions(Webhook・管理)のみ。
- 運営の手動調整は当面 Firebase コンソールで entitlements/{uid} を直接編集(rules を迂回)。

### stripeEvents/{sessionId}(冪等記録・内部専用)
| フィールド | 型 | 説明 |
|---|---|---|
| uid | string | 付与先ホスト |
| priceId | string | 購入した Price ID |
| quantity | number | 数量(複数月) |
| at | Timestamp | 処理時刻 |

- read/write ともクライアント禁止(`allow read/write: if false`)。Webhook が Admin SDK で書く。

### Stripe 価格カタログ(plans.js)
| planKey | 上限 | 期間 | 価格 | テスト Price ID |
|---|---|---|---|---|
| onetime_300 | 300 | 30日 | ¥1,000 | price_1Tv5Fm… |
| onetime_1000 | 1000 | 30日 | ¥3,000 | price_1Tv5Ie… |
| annual_300 | 300 | 365日 | ¥3,000 | price_1Tv5J6… |
| annual_1000 | 1000 | 365日 | ¥10,000 | price_1Tv5JR… |

- 本番 Price ID は `PRICE_TO_PLAN_LIVE` に追記(または metadata 付き価格で自動解決)。

## 検証

- entitlement ゲート: 無料(20)で capacity 50 要求→拒否、capacity 未指定→20 に丸め、
  paid(1000)付与で 1000 まで許可、期限切れで無料に戻る、を integration test。
- Stripe は **テストモード** + Stripe CLI(`stripe listen`)で Webhook をローカル検証。
- 既存の全テスト(現行90)がグリーンのまま。
