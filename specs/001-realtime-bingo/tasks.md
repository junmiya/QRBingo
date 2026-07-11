# Tasks: リアルタイム配信ビンゴ (v2)

**Input**: [spec.md](./spec.md) / [plan.md](./plan.md) / [data-model.md](./data-model.md) / [contracts/functions-api.md](./contracts/functions-api.md)

`[P]` = 並行実行可能(依存なし・別ファイル)

## Phase 1: 基盤とリアルタイム抽選 (US-1, US-2, US-3)

### Setup

- [ ] T001 Firebase プロジェクト初期化(firebase.json, .firebaserc, emulator 設定)
- [ ] T002 `functions/` 雛形(Node 20, eslint, jest)と `firestore.rules` の骨格
- [ ] T003 [P] Firebase JS SDK のベンダリングと `js/online/firebase-init.js`(Emulator 自動接続込み)
- [ ] T004 [P] `js/common.js` のカード生成・ライン判定を `functions/src/lib/bingo.js` へ共有する仕組み(コピー同期スクリプト or 共通ファイル参照)

### Functions

- [ ] T010 `createGame` 実装+unit test(設定バリデーション、FR-001)
- [ ] T011 `startGame` 実装+unit test(設定ロック、FR-002)
- [ ] T012 `joinGame` 実装+unit test(冪等・定員・NGワード・gridHash 重複排除トランザクション、FR-003/004/005)
- [ ] T013 `drawNumber` 実装+unit test(直列化・revealAt 付与・75球上限、FR-006/007)
- [ ] T014 `firestore.rules` 本実装+rules unit test(cards は本人のみ read 等)

### Frontend

- [ ] T020 `index.html` にモード選択(オフライン/オンライン)を追加 ※v1 導線は温存(FR-015)
- [ ] T021 `online/host.html` + `js/online/host.js` — ゲーム作成フォーム、参加QR表示、抽選ボタン、抽選履歴(v1 の UI 部品を流用)
- [ ] T022 `online/player.html` + `js/online/player.js` — 参加フロー(ニックネーム)、カード表示、draws 購読と自動マーキング(revealAt+サーバー時刻オフセット)
- [ ] T023 セッション復帰(匿名認証永続化+cards/{gameId}_{uid} 読み戻し、FR-013)

### Verify (Phase 1 gate)

- [ ] T030 Playwright E2E: 作成→参加→抽選→自動マーク→リロード復帰(Emulator 上、US-1/2/3 の受け入れシナリオ全件)

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
