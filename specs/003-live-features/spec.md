# Feature Specification: ライブ機能(アナウンス・チャット・カウントダウン)

## 概要
配信/イベントの盛り上げと進行のため、以下の3機能を追加する。いずれも順位・当選判定
には一切影響しない(公平性=憲章Iを維持)。書き込みはすべて Cloud Functions 経由
(rules は該当コレクションの write を禁止)。

## Functional Requirements

- **FR-L1**: 誰かがリーチ/ビンゴになったら、全参加者とホストの画面にアナウンス(トースト)を出す。
  - リーチは各プレイヤーの**初回のみ**通知(件数=最大 参加者数)。ビンゴは成立ごとに通知。
  - サーバーがシードから再計算した結果に基づく(虚偽のリーチ/ビンゴは通知されない)。
  - データ: `games/{id}/feed/{autoId}` = `{ type:'reach'|'bingo', nickname, ballIndex, reachLines, createdAt }`。
    read=参加者全員 / write=Function(reportReach・submitClaim)のみ。
  - コスト特性: 1イベントにつき参加者数ぶんの read。リーチを初回限定にすることで件数を抑える。
- **FR-L2**: チャット機能。ホストが **ON/OFF** を切り替えられる(作成時 + 進行中いつでも)。
  - 送信は `sendChat`(参加者=カード保有 or ホスト、1〜200文字、制御文字除去)。
  - データ: `games/{id}/chat/{autoId}` = `{ uid, nickname, text, isHost, createdAt }`。
    read=参加者全員 / write=Function のみ。ホストは「主催者」名義で送信。
  - 切替: `setChatEnabled`(ホストのみ)→ `settings.chatEnabled`。
- **FR-L1b**: 投げ銭(スパチャ)着金も全員にアナウンス(スーパーチャット風)。
  stripeWebhook が feed に `{ type:'tip', nickname, amount }` を追記し、既存の feed 購読で
  全員のトーストに表示。金色・大きめ・長め(5.5秒)で別格に見せる。頻度が低いため制限不要。
  ニックネームは送り主のカードから取得(取得不可なら「応援」)。
- **FR-L3**: 開始までのカウントダウン表示。ホストが **ON/OFF** でき、秒数を指定して開始できる。
  - `setCountdown({seconds})`(ホストのみ): seconds>0 で `countdownTarget = now + seconds`、
    `settings.countdownEnabled=true`。seconds=0 で解除。範囲 0〜3600秒。
  - プレイヤー/ホストは lobby 中に残り時間を毎秒表示。0 で「まもなく開始」。実際の開始は
    従来どおりホストの「ゲームを開始」操作で行う(自動開始はしない)。

- **FR-L4**: 抽選番号は抽選と同時に参加者へ届く。WebChannel のストリーミングがプロキシ等で
  バッファされ「次の更新まで届かない」環境があるため、Firestore は `experimentalForceLongPolling`
  で接続する(js/online/firebase-init.js)。
- **FR-L5**: 当選コードの照合。
  - 当選者の画面に当選コードと QR(`QRBINGO-WIN:<ゲーム>:<当選コード>`)を表示する。
  - ホスト画面・マイページの確定ランキングでは当選コードを既定で伏せ、「当選コードを表示」で切替。
  - ログイン中の主催者は「当選コードQRを読み取る」でカメラ(jsQR)から読み取り、
    自分のゲームの private/results と照合 → 順位・ニックネームを確認 →「対応済み」(markWinnerHandled)。
    別ゲーム・他人のゲーム・不一致のコードは理由を示して拒否する。
  - マイページ「主催したゲーム」(ログイン時のみ): 一覧・ホスト画面で開く・中止・結果・読み取り。
    ゲームの開催自体はログイン任意(未ログインは「表示」ボタンで当選コードを確認)。

## データモデル追加
- `games/{id}.settings.chatEnabled` (boolean, 既定 false)
- `games/{id}.settings.countdownEnabled` (boolean, 既定 false)
- `games/{id}.countdownTarget` (Timestamp | null)
- `games/{id}/feed/{autoId}`(アナウンス)/ `games/{id}/chat/{autoId}`(チャット)

## サーバー関数
- `sendChat`(onCall) / `setChatEnabled`(onCall) / `setCountdown`(onCall)
- `reportReach` / `submitClaim` に feed 追記を追加(reportReach は初回リーチのみ)

## 検証
- feed: 初回リーチで reach 1件、再送で重複なし、ビンゴで bingo 追記(integration)。
- chat: 無効時は失敗、有効時に参加者/ホスト送信可、未参加は permission-denied、空文字は拒否。
- countdown: ホストのみ設定/解除、範囲外は invalid-argument、target が未来に入る。
- 既存の全テストがグリーンのまま(122件)。
