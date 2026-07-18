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
