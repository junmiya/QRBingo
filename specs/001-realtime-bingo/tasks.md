# Tasks: リアルタイム配信ビンゴ (v2)

**Input**: [spec.md](./spec.md) / [plan.md](./plan.md) / [data-model.md](./data-model.md) / [contracts/functions-api.md](./contracts/functions-api.md)

`[P]` = 並行実行可能(依存なし・別ファイル)

## Phase 1: 基盤とリアルタイム抽選 (US-1, US-2, US-3)

### Setup

- [x] T001 Firebase プロジェクト初期化(firebase.json, .firebaserc, emulator 設定)
- [x] T002 `functions/` 雛形(Node 20, jest)と `firestore.rules` の骨格
- [x] T003 [P] Firebase JS SDK のベンダリングと `js/online/firebase-init.js`(Emulator 自動接続込み)
- [x] T004 [P] `js/common.js` の @shared ブロックを `functions/src/lib/bingo.js` へ同期するスクリプト(`functions/scripts/sync-lib.js`)

### Functions

- [x] T010 `createGame` 実装+integration test(設定バリデーション、FR-001)
- [x] T011 `startGame` 実装+integration test(設定ロック、FR-002)
- [x] T012 `joinGame` 実装+integration test(冪等・定員・NGワード・gridHash 重複排除トランザクション・allowDuplicateCards、FR-003/004/005)
- [x] T013 `drawNumber` 実装+integration test(直列化・revealAt 付与・75球上限、FR-006/007)
- [x] T014 `firestore.rules` 本実装(cards/winners は本人+ホストのみ read 等)。rules 単体テストは Phase 2/3 の実データ(claims/winners)投入時に追加

### Frontend

- [x] T020 `index.html` にモード選択(オフライン/オンライン)を追加 ※v1 導線は温存(FR-015)
- [x] T021 `online/host.html` + `js/online/host.js` — ゲーム作成フォーム、参加QR表示、抽選ボタン、抽選履歴(v1 の UI 部品を流用)
- [x] T022 `online/player.html` + `js/online/player.js` — 参加フロー(ニックネーム)、カード表示、draws 購読と自動マーキング(revealAt はサーバー時刻基準で発行。クライアント比較はローカル Date.now() — サーバー時刻オフセット補正は T050 で revealDelaySec の UI が入る際に追加)
- [x] T023 セッション復帰(匿名認証永続化+`joinGame` のニックネーム省略呼び出しによる冪等リジョインで実現、FR-013)。ホスト側はブラウザ localStorage の gameId ポインタ+hostUid のサーバー側検証(別デバイスへの引き継ぎは Out of Scope、同一ブラウザの再読み込みのみ対応)

### Verify (Phase 1 gate)

- [x] T030 Playwright E2E(Firestore+Auth+Functions Emulator 上、実ブラウザ): ゲーム作成→ロビー参加→開始→ゲーム中参加→39/49球抽選→ビンゴ判定一致→両者リロードでのセッション復帰→定員境界での参加拒否、を確認。バックエンドは unit 19件+integration 32件(計51件)が別途green

**Phase 1 completed 2026-07-11.** 既知のスコープ限定事項:
- クライアント側の revealAt 判定はサーバー時刻オフセット補正なし(revealDelaySec=0 が既定の間は無影響。補正は T050 で対応)
- ホストの「別デバイスでの復帰」はセッション機構としては未対応(hostUid によるサーバー側の権限チェックは常に有効)

## Phase 2: 判定・ランキング・当選コード (US-4, US-5)

- [ ] T040 `submitClaim` 実装+unit test(seed 再計算・公開済み draws のみ・achievedBallIndex 算出・冪等、FR-008)
- [ ] T041 順位付けと leaderboard 投影(同 ballIndex 同順位)+unit test
- [ ] T042 `finishGame` 実装+unit test(同着抽選 tieBreakSeed・winCode 発行、FR-009/010)
- [ ] T043 [P] クライアント: 条件到達の自動検知→submitClaim→当選画面(順位+winCode 表示)
- [ ] T044 [P] ホスト: ランキング画面(順位・ニックネーム・winCode・handled トグル、FR-011)
- [ ] T045 [P] NGワードフィルタ(client+server 共通リスト)と hideNickname
- [ ] T046 同着シミュレーションテスト: 1,000 人・意図的同着で順位が ballIndex 順と完全一致(SC-002)、改竄クレーム受理 0%(SC-003)

## Phase 3: 仕上げ (US-6, NFR)

- [ ] T050 [P] 公開ディレイ設定 UI とホスト側の「配信用画面」(大画面レイアウト)
- [ ] T051 [P] リーチ人数・参加人数のリアルタイム表示(reachCount 集計、US-6)
- [ ] T052 App Check 導入(reCAPTCHA v3 / Enterprise、NFR-003)
- [ ] T053 `expireGame` とゲーム失効の UI/導線(FR-014)
- [ ] T054 負荷試験スクリプト(10k 相当の购読シミュレーション、NFR-001/002 の実測)
- [ ] T055 README 更新(v1/v2 の使い分け、quickstart への導線)
- [ ] T056 総合 E2E(全 User Story 受け入れシナリオ)+ デプロイ手順の実行確認

## Dependencies

```
T001-T004 → T010-T014 → T020-T023 → T030(Phase 1 ゲート)
T030 → T040-T046(Phase 2)→ T050-T056(Phase 3)
```

## 実装しないもの(Out of Scope 再掲)

メール送信 / アプリ内チャット / 別端末引き継ぎ / 90球バリアント / 課金
