# QRBingo 🎱

QRコードで参加できる、**サーバー不要**の75球ビンゴゲーム。
静的ファイルだけで動作するため、GitHub Pages などにそのまま公開できます。

## あそびかた

1. **ホスト**が `host.html` を開くとゲームが作成され、参加用QRコードとゲームコード(4文字)が表示されます。
2. **参加者**はスマホでQRコードを読み取る(またはゲームコードを入力する)と、自分だけのビンゴカードが配られます。
3. ホストが「抽選する!」で番号を引き、読み上げます。参加者は自分のカードの番号をタップしてマークします。
4. 縦・横・斜めのいずれか1列が揃ったら**ビンゴ**!参加者は「カードQRを表示」してホストに見せます。
5. ホストがそのQRを読み取ると、**実際の抽選結果に対して本当にビンゴかを自動検証**します。

## しくみ

- ビンゴカードはカードID(例: `ABCD-XY23K7`)から**決定論的に生成**されます(シード付き乱数)。
- そのためサーバーやデータベースが無くても、ホストはカードIDだけから参加者と同一のカードを再現でき、抽選履歴と突き合わせて不正なく検証できます。
- ゲームの状態(抽選履歴・カード・マーク)は各端末の `localStorage` に保存されるので、ページを再読み込みしても続きから遊べます。

## ファイル構成

```
index.html      # トップページ(ホスト / プレイヤーの選択)
host.html       # ホスト画面(QR表示・抽選・ビンゴ検証)
player.html     # プレイヤー画面(カード表示・マーク・ビンゴ申告QR)
css/style.css   # スタイル
js/common.js    # カード生成・ビンゴ判定・QR生成などの共通ロジック
js/host.js      # ホスト画面ロジック
js/player.js    # プレイヤー画面ロジック
lib/qrcode.js   # QRコード生成 (qrcode-generator v1.4.4, MIT License)
lib/jsQR.js     # QRコード読み取り (jsQR v1.4.0, Apache-2.0 License)
```

## ローカルでの実行

静的ファイルなので任意のHTTPサーバーで配信するだけです。

```bash
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

> **Note:** ビンゴ検証のカメラ読み取り(`getUserMedia`)は `localhost` または HTTPS 環境でのみ動作します。カメラが使えない環境でも、カードIDの手入力で検証できます。

## 公開方法(GitHub Pages)

リポジトリの Settings → Pages → Branch にこのブランチ(またはmain)のルートを指定するだけで公開できます。

## オンラインモード(v2: リアルタイム配信ビンゴ)

TV・YouTube Live などの配信でも使えるモード。カードはネットワーク経由で配布され、
抽選結果は Firebase 経由でリアルタイムに全参加者へ配信・自動マーキングされます
(手動タップは不要)。**Phase 1(基盤・リアルタイム抽選)と Phase 2(ビンゴ判定・
ランキング・当選コード)を実装・検証済み**です。

- `online/host.html` — ゲーム作成(勝利ライン数・定員・景品数・同一カード許可)、
  参加用QR表示、抽選、抽選履歴のリアルタイム表示、暫定/確定ランキング、
  ゲーム終了による順位確定、当選コードの照合(対応済みトグル)、ニックネーム伏字化
- `online/player.html` — QR/ゲームコードで参加、初回のみニックネーム入力、
  カードは抽選結果に応じて自動でマークされる。勝利条件に達すると自動でビンゴ申告し、
  順位を表示。当選者には当選コードを表示。リロードしても同じカード・順位に復帰

**順位の公平性**: 順位は「何球目でビンゴが成立したか(ball index)」だけで決まり、
申告時刻や通信速度は一切影響しません。ビンゴ判定はサーバーがカードのシードから
再計算するため、クライアント側の改竄は受理されません。景品数を超える同着は、
記録される乱数シード(tieBreakSeed)による決定論的抽選で確定します(後から検証可能)。
当選者への連絡はメールを収集せず、当選コードを主催者チャネルで照合する方式です。

まだ公開ディレイ設定 UI・リーチ人数表示・App Check・負荷試験(Phase 3)は未実装です。
詳細は下記の Spec Kit ドキュメントと `tasks.md` の進捗を参照してください。

```
.specify/memory/constitution.md        # プロジェクト憲章(公平性・PIIフリー等の原則)
specs/001-realtime-bingo/
  spec.md          # 機能仕様(ユーザーストーリー・FR/NFR・受け入れ基準)
  research.md      # 設計判断の記録(同着ルール・配信遅延・当選コード・Firebase採用)
  plan.md          # 実装計画(アーキテクチャ・フェーズ分割・進捗)
  data-model.md    # Firestore データモデル
  contracts/functions-api.md   # Cloud Functions API 契約
  quickstart.md    # 開発環境セットアップ(Firebase Emulator Suite)
  tasks.md         # タスクリストと完了状況
```

### オンラインモードのファイル構成

```
online/host.html          # ホスト画面(オンライン)
online/player.html        # プレイヤー画面(オンライン)
js/online/firebase-init.js   # SDK初期化・匿名認証・Emulator自動接続
js/online/host.js            # ホスト画面ロジック
js/online/player.js          # プレイヤー画面ロジック
js/online/firebase-config.js # Firebase Web設定(要:本番プロジェクトの値に置き換え)
lib/firebase/                # Firebase JS SDK (Apache-2.0、ベンダリング済み)
firebase.json, .firebaserc, firestore.rules, firestore.indexes.json
functions/                   # Cloud Functions
  src/createGame|startGame|joinGame|drawNumber.js   # Phase 1
  src/submitClaim|finishGame|hideNickname|markWinnerHandled.js  # Phase 2
  src/lib/ranking.js            # 順位付け・同着抽選(純粋ロジック)
  src/lib/leaderboardService.js # 公開ランキング投影(DB読取)
  src/lib/bingo.js              # js/common.js の @shared ブロックから自動生成(要 npm run sync-lib)
  test/unit/, test/integration/ # Jest: unit 30件 + Firestore Emulator 結合 52件
e2e/online-flow.test.js      # Phase 1 の実ブラウザ E2E
e2e/phase2-flow.test.js      # Phase 2(判定・順位・当選コード)の実ブラウザ E2E
```

### オンラインモードをローカルで試す

```bash
cd functions && npm install
npm run test:unit          # ロジック単体テスト(Emulator不要)
npm run test:integration   # Firestore Emulatorを自動起動して結合テスト
```

ブラウザで試す場合は `specs/001-realtime-bingo/quickstart.md` の手順で
Auth/Firestore/Functions Emulator を起動し、リポジトリルートを別途 HTTP サーバーで
配信して `online/host.html` を開いてください(本番デプロイには実際の Firebase
プロジェクトの作成が必要です)。`e2e/online-flow.test.js` で一連の流れを自動検証できます。

## クレジット

- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) © Kazuhiko Arase (MIT License)
- [jsQR](https://github.com/cozmo/jsQR) © Cosmo Wolfe (Apache License 2.0)
- [Firebase JS SDK](https://github.com/firebase/firebase-js-sdk) © Google (Apache License 2.0) — `lib/firebase/` にベンダリング(CDN 非依存化のため gstatic.com への内部参照をローカルパスに書き換え済み)
