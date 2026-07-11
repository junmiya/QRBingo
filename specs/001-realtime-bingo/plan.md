# Implementation Plan: リアルタイム配信ビンゴ (v2)

**Branch**: `001-realtime-bingo` | **Date**: 2026-07-11 | **Spec**: [spec.md](./spec.md)

## Summary

v1(静的・サーバーレス)に「オンラインモード」を追加する。Firebase を採用し、
抽選・カード発行・ビンゴ検証・順位確定をサーバー権威で行う。順位は ball index 基準
(R-1)、公開ディレイで配信遅延に対応(R-2)、当選コード方式で PII レス(R-3)。

## Technical Context

- **Language**: JavaScript (ES2020, ビルドなし) / Cloud Functions は Node.js 20
- **Backend**: Firebase — Firestore, Cloud Functions (callable), Anonymous Auth, App Check
- **Frontend**: 既存の静的構成に `online/` 系画面を追加。Firebase JS SDK はベンダリング(憲章: CDN 依存禁止)
- **Testing**: Playwright E2E(Firebase Emulator Suite 上で実行)+ 公平性ロジックの unit test
- **Hosting**: Firebase Hosting または GitHub Pages(フロント)+ Firebase(バック)
- **Performance**: 参加 10,000 人 / 抽選配信 p95 3秒以内 / 1ゲーム数百円以内

## Constitution Check

| 原則 | 適合 |
|---|---|
| I. サーバー権威の公平性 | ✅ 抽選・検証・順位は Cloud Functions。ball index 基準 |
| II. PII フリー | ✅ 当選コード方式。メール保存なし |
| III. 決定論的カード | ✅ サーバーはシードのみ発行。v1 と同じ生成関数を共有 |
| IV. v1 温存 | ✅ 既存ページは無変更。オンラインモードは追加ページ |
| V. 検証ファースト | ✅ Emulator + Playwright、公平性ロジックに unit test |

## Project Structure

```
index.html                  # モード選択(オフライン / オンライン)を追加
host.html, player.html      # v1 (無変更)
online/
  host.html                 # v2 ホスト(ゲーム作成・抽選・ランキング)
  player.html               # v2 プレイヤー(参加・自動マーク・当選表示)
js/
  common.js                 # v1/v2 共有: カード生成・ライン判定 (無変更中心)
  online/
    firebase-init.js        # SDK 初期化(設定は firebase-config.js に分離)
    host.js
    player.js
functions/                  # Cloud Functions (Node 20)
  src/
    createGame.js           # ゲーム作成
    joinGame.js             # 参加+カード発行(重複排除トランザクション)
    drawNumber.js           # 抽選(直列化・公開ディレイ設定)
    submitClaim.js          # クレーム検証+順位確定
    finishGame.js           # 終了・同着抽選・当選コード発行
    lib/bingo.js            # common.js と同一ロジック(生成・判定)※単一ソースから同期
  test/                     # 公平性ロジック unit test
firestore.rules             # セキュリティルール
specs/001-realtime-bingo/   # 本スペックキット
```

## Architecture

### データフロー

1. **参加**: player → `joinGame(gameId, nickname)` → シード発行・グリッドハッシュ重複チェック → `cards/{cardId}`
2. **抽選**: host → `drawNumber(gameId)` → Firestore トランザクションで未抽選から選出 → `games/{id}.draws[]` に `{n, ballIndex, revealAt}` 追記
3. **配信**: 全 player は `games/{id}` を onSnapshot。`revealAt <= serverNow` の番号のみ表示・自動マーク(サーバー時刻オフセットで時計ずれ補正)
4. **クレーム**: player 側でライン数が条件到達 → 自動で `submitClaim(cardId)` → Functions がシードからグリッド再計算し、公開済み draws と突き合わせて成立 ball index を算出 → `claims/{id}` 確定
5. **順位**: ball index 昇順・同値同順位。`finishGame` で景品数超過の同着をシード付き乱数で抽選し、当選コードを発行

### 公開ディレイの実装

`drawNumber` が `revealAt = serverTimestamp + delaySec` を書き込む。クライアントは
Firestore のサーバー時刻オフセットを用いて `revealAt` 到来時に表示。判定(claim 検証)は
`revealAt` を過ぎた draws のみを対象とするため、ディレイ中の番号で先にビンゴすることはできない。

### セキュリティルール方針

- `games`: read は全員可(公開情報のみ)。write は Functions のみ
- `cards`: read は所有 UID のみ(他人のカードを覗けない)。write は Functions のみ
- `claims` / `winners`: 当人と host のみ read。write は Functions のみ
- ニックネーム一覧・ランキングは `games/{id}/public/leaderboard` に Functions が投影

## Phases

### Phase 1 — 基盤とリアルタイム抽選 (US-1, US-2, US-3)
Firebase プロジェクト設定、Emulator、createGame / joinGame / drawNumber、
オンライン版 host/player 画面、自動マーキング、セッション復帰。

### Phase 2 — 判定・ランキング・当選コード (US-4, US-5)
submitClaim / finishGame、ball index 順位、同着抽選、当選コード、
ホストのランキング画面、ニックネーム NG フィルタ。

### Phase 3 — 仕上げ (US-6, NFR)
公開ディレイ UI、リーチ/参加人数表示、App Check、負荷試験(10k 接続シミュレーション)、
ゲーム失効、E2E 一式。

## Risks

| リスク | 対策 |
|---|---|
| 一斉参加スパイクで joinGame が詰まる | 重複チェックをハッシュの determinisitic doc ID + create で O(1) に |
| クレーム殺到(同球で数百件) | 検証は O(1)/件・冪等。Functions の同時実行に任せる |
| Functions のコールドスタート | 抽選系は min instances 1(イベント中のみ)を検討 |
| Firebase 設定がリポジトリに必要 | firebase-config.js は公開可能な値のみ(API キーは秘密ではない)。ルールと App Check で防御 |

## Progress Tracking

- [ ] Phase 1 complete
- [ ] Phase 2 complete
- [ ] Phase 3 complete
