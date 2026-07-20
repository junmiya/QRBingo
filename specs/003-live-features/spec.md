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
- **FR-L3**: 開始までのカウントダウン表示。ホストが **ON/OFF** でき、秒数を指定して開始できる。
  - `setCountdown({seconds})`(ホストのみ): seconds>0 で `countdownTarget = now + seconds`、
    `settings.countdownEnabled=true`。seconds=0 で解除。範囲 0〜3600秒。
  - プレイヤー/ホストは lobby 中に残り時間を毎秒表示。0 で「まもなく開始」。実際の開始は
    従来どおりホストの「ゲームを開始」操作で行う(自動開始はしない)。

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
