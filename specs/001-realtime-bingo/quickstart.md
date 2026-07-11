# Quickstart: リアルタイム配信ビンゴ (v2) 開発環境

**Date**: 2026-07-11 | **Plan**: [plan.md](./plan.md)

## 前提

- Node.js 20+
- Firebase CLI: `npm i -g firebase-tools`
- Java 11+(Firestore Emulator 用)

## 初回セットアップ

```bash
# 1. Firebase プロジェクト作成(ブラウザで console.firebase.google.com → プロジェクト追加)
#    Anonymous Auth を有効化、Firestore を作成(ロケーション: asia-northeast1)

# 2. ローカル設定
firebase login
firebase use --add          # 作成したプロジェクトを選択

# 3. 依存インストール
cd functions && npm install && cd ..

# 4. Web アプリ設定を js/online/firebase-config.js に貼り付け
#    (console → プロジェクトの設定 → マイアプリ → SDK 設定)
#    ※ この値は公開可能。防御は firestore.rules と App Check で行う
```

## ローカル開発(Emulator)

```bash
firebase emulators:start    # Firestore + Functions + Auth + Hosting
# → http://localhost:5000 でフロント、http://localhost:4000 で Emulator UI
```

フロントは `firebase-init.js` が `location.hostname === 'localhost'` のとき自動で
Emulator に接続する。

## テスト

```bash
cd functions && npm test                 # 公平性ロジック unit test (NFR-004)
node scripts/e2e-online.js               # Playwright E2E(Emulator 起動中に実行)
node scripts/load-sim.js --players 1000  # 同着シミュレーション (SC-002)
```

## デプロイ

```bash
firebase deploy --only firestore:rules,functions,hosting
```

## 動作確認シナリオ(手動)

1. `/online/host.html` → ゲーム作成(1ライン・ディレイ0)→ 開始
2. 別ブラウザ(シークレット)で参加QR → ニックネーム入力 → カード表示
3. ホストで抽選連打 → 参加者のカードが自動マークされること
4. 参加者タブを閉じて再度開く → 同じカードに復帰すること
5. ビンゴ成立 → 参加者に順位と当選コード、ホストにランキングが出ること
