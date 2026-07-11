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

## クレジット

- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) © Kazuhiko Arase (MIT License)
- [jsQR](https://github.com/cozmo/jsQR) © Cosmo Wolfe (Apache License 2.0)
