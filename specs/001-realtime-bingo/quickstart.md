# Quickstart: リアルタイム配信ビンゴ (v2) 開発環境

**Date**: 2026-07-11 | **Plan**: [plan.md](./plan.md)

## 前提

- Node.js 20+
- Java 11+(Firestore Emulator 用。firebase-tools は `functions/` の devDependency として
  インストールされるため、グローバル導入は不要)

## Emulator のみでの開発(Firebase プロジェクト不要)

`.firebaserc` の既定プロジェクトは `demo-qrbingo`(`demo-` プレフィックスは
Firebase Emulator Suite の「オフライン専用プロジェクト」の規約)。これにより
**実際の Firebase プロジェクトを作成しなくても** ローカルで全機能を検証できる。
`js/online/firebase-config.js` のプレースホルダー値もこの用途専用。

```bash
# 1. 依存インストール
cd functions && npm install && cd ..

# 2. Emulator 起動(Firestore + Auth + Functions)
./functions/node_modules/.bin/firebase emulators:start \
  --only firestore,auth,functions --project demo-qrbingo
# → Emulator UI: http://127.0.0.1:4000/

# 3. 別ターミナルでフロントを配信(任意の静的サーバーでよい)
python3 -m http.server 8377
# → http://localhost:8377/online/host.html
```

`js/online/firebase-init.js` は `location.hostname` が `localhost`/`127.0.0.1` の場合、
自動的に Auth(9099)・Firestore(8080)・Functions(5001)の Emulator に接続する。

## 本番プロジェクトへのデプロイ

```bash
# 1. Firebase プロジェクト作成(ブラウザで console.firebase.google.com → プロジェクト追加)
#    Anonymous Auth を有効化、Firestore を作成(ロケーション: asia-northeast1 推奨)
firebase login
firebase use --add                # 作成したプロジェクトを選択(demo-qrbingo とは別名で管理)

# 2. Web アプリ設定を js/online/firebase-config.js に貼り付け
#    (console → プロジェクトの設定 → マイアプリ → SDK 設定)
#    ※ この値は公開可能。防御は firestore.rules と App Check(Phase 3)で行う

# 3. デプロイ
firebase deploy --only firestore:rules,functions,hosting
```

## テスト

```bash
cd functions
npm run test:unit          # ロジック単体テスト(Emulator 不要、19件)
npm run test:integration   # Firestore Emulator を自動起動して結合テスト(32件)
npm test                   # 上記両方

# ブラウザE2E(Emulator起動中 & 静的サーバー配信中に別ターミナルで)
cd ../e2e && npm install
STATIC_BASE_URL=http://localhost:8377/ node online-flow.test.js
```

Phase 2 で `submitClaim`/`finishGame` を追加した際は、同着シミュレーション
(SC-002)・改竄クレーム拒否率(SC-003)の検証スクリプトをこのセクションに追記する。

## 動作確認シナリオ(手動、`e2e/online-flow.test.js` が自動化済み)

1. `/online/host.html` → ゲーム作成(1ライン・定員10)→ ロビーで参加用QR確認
2. 別ブラウザ(シークレット)で参加QR → ニックネーム入力 → カード表示
3. ホストで開始 → ゲーム中に別プレイヤーが参加できること
4. ホストで抽選連打 → 参加者のカードが自動マークされ、ビンゴが成立すること
5. 参加者・ホストともにリロードしても状態が復元されること
6. 定員を超える参加が正しく拒否されること

Phase 2 実装後は「ビンゴ成立 → 参加者に順位と当選コード、ホストにランキングが
出ること」をこのシナリオに追加する。
