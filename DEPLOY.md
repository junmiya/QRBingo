# デプロイ手順

QRBingo には 2 つのモードがあり、デプロイ要件が異なります。

| モード | 必要なもの | 公開先の例 |
|---|---|---|
| **v1 オフライン** | なし(静的ファイルのみ) | GitHub Pages / 任意の静的ホスト |
| **v2 オンライン** | Firebase プロジェクト(Firestore + Functions + 匿名認証) | Firebase Hosting |

---

## v2(オンラインモード)を Firebase に公開する

オンラインモードは抽選のリアルタイム配信・カード配布・ビンゴ判定を
Firebase 上で行うため、**あなたの Firebase プロジェクトが必要**です。
以下のうち「あなたの作業」だけお願いします。残りは自動です。

### 1. あなたの作業(Firebase コンソール、約10分)

1. <https://console.firebase.google.com> でプロジェクトを新規作成
2. **Authentication** → Sign-in method → **匿名**(Anonymous)を有効化
3. **Firestore Database** を作成(本番モード、ロケーション: `asia-northeast1` 推奨)
4. **プラン**を **Blaze(従量課金)**にアップグレード
   - Cloud Functions は Blaze が必須です。通常のイベント利用なら無料枠にほぼ収まります
5. プロジェクトの設定 → マイアプリ → **ウェブアプリを追加** → 表示される
   `firebaseConfig` の値(apiKey / projectId など)をコピー

### 2. Web 設定を反映

`js/online/firebase-config.js` の値を、手順 5 でコピーした本番の値に置き換えます。
(この値は公開されても安全です。アクセス制御は `firestore.rules` と将来の App Check で行います)

### 3. デプロイ(1コマンド)

Firebase CLI が使える環境(ローカル等)で:

```bash
firebase login                       # 初回のみ
firebase use --add                   # 作成したプロジェクトを選択
firebase deploy --only firestore:rules,functions,hosting
```

これで以下がまとめて公開されます:

- **Hosting**: フロントエンド(v1 + v2 両方)→ `https://<プロジェクトID>.web.app`
- **Functions**: createGame / joinGame / drawNumber / submitClaim / finishGame ほか
- **Firestore Rules**: 読み取り権限(書き込みは Functions 経由のみ)

`firebase deploy` は `predeploy` で `npm run sync-lib` を自動実行し、
`js/common.js` の共有ロジックを Functions 側へ同期します。

### 動作確認

`https://<プロジェクトID>.web.app/online/host.html` を開いてゲームを作成し、
表示された QR を別端末(スマホ)で読み取れば、その場で参加・自動マーキング・
順位確定まで実機で試せます。

---

## 課金(Stripe)のセットアップ

**シークレットキーは誰にも渡さないでください。** 商品/価格の作成は、あなたのキーで
下記スクリプトを実行して行います(冪等・何度実行しても安全)。

### 1. Stripe 商品/価格を作成

```bash
cd functions && npm install     # 初回のみ(stripe を含む)

# まずテストモードで作成して確認
STRIPE_SECRET_KEY=sk_test_xxxxx npm run setup-stripe

# 確認できたら本番でも作成
STRIPE_SECRET_KEY=sk_live_xxxxx npm run setup-stripe
```

作成される価格(すべて一回払い・JPY):

| lookup_key | 内容 | 金額 |
|---|---|---|
| `qrbingo_onetime_300` | 都度 300人(1ヶ月・複数月は数量で) | ¥1,000 |
| `qrbingo_onetime_1000` | 都度 1000人(1ヶ月) | ¥3,000 |
| `qrbingo_annual_300` | 年 300人 | ¥3,000 |
| `qrbingo_annual_1000` | 年 1000人 | ¥10,000 |

各価格の metadata に `maxPlayers` / `durationDays` / `kind` が入り、購入時に Webhook が
これを読んで entitlement(人数上限・有効期限)を付与します(価格IDのハードコード不要)。
1000人超のカスタムは Stripe ダッシュボードで個別価格を作り、同じ metadata を設定します。

### 2. Checkout と Webhook のキー設定

`createCheckout`(Callable)と `stripeWebhook`(HTTP)を動かすため、キーを
Firebase Secrets に投入します(**あなたの手元で実行**。私にキーを渡す必要はありません)。

まずは**テストキー**で確認してください:

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY        # sk_test_xxx を貼る
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET    # 手順3で発行する whsec_xxx を貼る
firebase deploy --only functions
```

`sk_test_` を入れると自動でテスト価格(`PRICE_TO_PLAN_TEST` の Price ID)を使い、
`sk_live_` を入れると本番価格を使います(モードはキーで自動判定)。

### 3. Stripe Webhook の登録(署名シークレットの取得)

支払い完了を受け取るため、Stripe に Webhook エンドポイントを登録します。

1. `firebase deploy --only functions` の出力(または Firebase コンソール → Functions)で
   **`stripeWebhook` の URL** を確認(例: `https://us-central1-qrbingo-5c613.cloudfunctions.net/stripeWebhook`)
2. Stripe ダッシュボード(**テストモード**)→ 開発者 → Webhooks → **エンドポイントを追加**
   - URL: 上記の `stripeWebhook` URL
   - イベント: **`checkout.session.completed`** を選択
3. 作成後に表示される **署名シークレット(`whsec_...`)** をコピーし、上記
   `firebase functions:secrets:set STRIPE_WEBHOOK_SECRET` に設定 → 再デプロイ

> ローカルで試す場合は Stripe CLI:
> `stripe listen --forward-to localhost:5001/<project>/us-central1/stripeWebhook`
> が発行する `whsec_...` を使います。

### 4. 本番(Live)へ切り替え

1. Stripe を**本番モード**にして、テストと同じ4商品(一括・JPY)を作成
2. 本番の Price ID を `functions/src/lib/plans.js` の `PRICE_TO_PLAN_LIVE` に追記
   (または `setup-stripe.js` を `sk_live_` で実行すると metadata 付き価格が作られ、
   コード追記なしでも Webhook が metadata から解決します)
3. `STRIPE_SECRET_KEY` を `sk_live_`、`STRIPE_WEBHOOK_SECRET` を本番 Webhook の
   `whsec_` に差し替えて再デプロイ

### 動作確認(テスト決済)

ホスト画面 → 「⬆️ 人数を増やす」→ プランを選択 → Stripe のテストカード
`4242 4242 4242 4242`(有効期限=未来・CVC=任意)で決済 → 戻ると数十秒で
プラン上限が反映され、より大人数のゲームを作成できます。

---

## 投げ銭(スパチャ)= Stripe Connect のセットアップ(Phase B)

投げ銭は **Stripe Connect** を使い、参加者→ホストへ直接送金します(運営は手数料のみ受領。
アプリは資金を保持しない)。以下は主催者課金とは別に、**Connect の有効化**が必要です。

### 1. プラットフォームで Connect を有効化(あなたの作業・一度だけ)

1. Stripe ダッシュボード → **Connect** → 利用開始(プラットフォームのプロフィール入力)
2. Express アカウント作成を許可する設定にする(既定でOK)

> Connect の有効化には Stripe の審査/プロフィール入力が伴います。これが完了しないと
> `createConnectAccount` が失敗します。

### 2. Webhook に Connect イベントを追加

手順3(前述)で作った Webhook に、イベント **`account.updated`** を追加します
(または「接続済みアカウントのイベントを受信」を有効化)。これでホストの受取可否が
自動で反映されます(未設定でも、ホストがオンボーディングから戻れば
`refreshConnectStatus` で反映されます)。

### 3. 運営手数料率(可変・既定50%)

既定は 50%。変えたい場合は Firestore の **`config/tips.commissionRate`**(0〜0.9)に
値を入れます(例: 0.3 で 30%)。Stripe 手数料は運営負担(destination charge の既定)。

### 動作確認

1. **ホスト画面** → 「🎁 投げ銭の受け取り設定」→「Stripeで受け取り口座を接続」→
   Stripe のテスト用オンボーディングを完了(戻ると「受け取り可能」になる)
2. その状態で**新しいゲームを作成**(作成時に受取可否を games に記録)
3. **プレイヤー画面**に「🎁 ホストを応援(投げ銭)」が表示 → 金額を選び
   テストカードで決済 → ホストの進行画面に投げ銭件数・受取額が反映

---

## GitHub Actions で自動デプロイ(push で自動反映)

`.github/workflows/firebase-deploy.yml` を追加済み。作業ブランチに push すると
Functions / Firestore Rules / Hosting を自動デプロイします(ローカルでのコマンド不要)。

### 一度だけの準備:サービスアカウントと GitHub Secret

1. **Google Cloud Console**(プロジェクト qrbingo-5c613)→ **IAM と管理 → サービス アカウント**
   → **サービス アカウントを作成**(例: `github-deployer`)
2. 次のロールを付与(v2 Functions + Secrets + Hosting のデプロイに必要):
   - 編集者(Editor)
   - Firebase Admin
   - サービス アカウント ユーザー(Service Account User)
   - Secret Manager 管理者(Secret Manager Admin)
3. 作成したサービスアカウント → **キー → 鍵を追加 → JSON** をダウンロード
4. **GitHub リポジトリ** → Settings → Secrets and variables → **Actions** → New repository secret
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Secret: ダウンロードした JSON の中身を**そのまま貼り付け**
5. 以降は作業ブランチへ push すると自動デプロイ。手動実行は Actions タブの
   「Run workflow」から可能。

> Stripe のキー(STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET)は Secret Manager に
> 設定済みのものが使われます(ワークフローには含めません)。値を変える時だけ
> `firebase functions:secrets:set ...` を実行してください。

---

## v1(オフラインモード)だけをすぐ公開する

Firebase 不要。**GitHub Pages** が最短です。

1. リポジトリの **Settings → Pages → Build and deployment → Source** を
   **「GitHub Actions」**に設定(1回だけ)
2. `.github/workflows/deploy-pages.yml` が push 時に自動デプロイします
   (手動再実行も可)
3. 公開 URL: `https://<ユーザー名>.github.io/QRBingo/`

> Pages のソース設定は、セキュリティ上 CI トークンでは自動化できないため、
> 最初の1回だけ手動での切り替えが必要です。設定後はプッシュで自動更新されます。

この方法では v1 は完全動作し、v2 のページは「Firebase の設定が必要」と
案内表示になります(バックエンド未接続のため)。v2 も公開したい場合は
上記の Firebase 手順を実施してください。
