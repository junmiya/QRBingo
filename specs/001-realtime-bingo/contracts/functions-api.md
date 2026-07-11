# Contracts: Cloud Functions API

**Date**: 2026-07-11 | **Plan**: [../plan.md](../plan.md)

すべて HTTPS Callable Functions。認証(匿名可)+ App Check 必須。
エラーは `functions.https.HttpsError` の code / message で返す。

## createGame

ゲームを作成する。

```jsonc
// request
{
  "winLines": 1,             // 1-12
  "revealDelaySec": 0,       // 0-60
  "capacity": null,          // null | 1-100000
  "allowDuplicateCards": false,
  "prizeCount": 3            // 1-100
}
// response
{ "gameId": "W2Y6", "joinUrl": "https://.../online/player.html?g=W2Y6" }
```

エラー: `invalid-argument`(範囲外)

## startGame

設定をロックし抽選を可能にする。host のみ。

```jsonc
// request
{ "gameId": "W2Y6" }
// response
{ "status": "playing", "startedAt": "..." }
```

エラー: `permission-denied`(host 以外)、`failed-precondition`(lobby 以外)

## joinGame

参加しカードを受け取る。冪等: 参加済み UID には既存カードを返す。

```jsonc
// request
{ "gameId": "W2Y6", "nickname": "たろう" }
// response
{
  "cardId": "W2Y6_<uid>",
  "seed": "W2Y6-92R5QW",     // ここからクライアントがグリッドを再現
  "nickname": "たろう",
  "rejoined": false
}
```

エラー: `not-found`(ゲームなし/expired)、`resource-exhausted`(定員)、
`invalid-argument`(ニックネーム長/NGワード)、`failed-precondition`(finished)

処理: トランザクションで
(1) capacity チェック → (2) シード生成 → (3) allowDuplicateCards=false なら
`gridHashes/{hash}` を create(衝突時は最大5回再シード)→ (4) `cards` 作成 →
(5) participantCount++。

## drawNumber

抽選する。host のみ。連打・並行呼び出しはトランザクションで直列化。

```jsonc
// request
{ "gameId": "W2Y6" }
// response
{ "n": 47, "ballIndex": 12, "revealAt": "..." }   // revealAt = now + revealDelaySec
```

エラー: `permission-denied`、`failed-precondition`(playing 以外)、
`resource-exhausted`(75球抽選済み)

## submitClaim

ビンゴ申告。クライアントは条件到達を検知したら自動で呼ぶ。冪等。

```jsonc
// request
{ "gameId": "W2Y6" }          // カードは uid から一意に特定
// response(成立)
{ "status": "verified", "achievedBallIndex": 34, "lines": 1, "provisionalRank": 2 }
// response(不成立)
{ "status": "rejected", "reason": "lines_not_met" }
```

エラー: `not-found`(未参加)、`failed-precondition`(lobby)

処理: seed からグリッド再計算 → 公開済み(revealAt<=now)draws のみで判定 →
`achievedBallIndex` 算出 → `claims` 確定(既存 verified は再計算しない)→
leaderboard 再投影。**リクエスト中のグリッドや時刻は受け取らない。**

## finishGame

ゲームを終了し順位・当選を確定する。host のみ。

```jsonc
// request
{ "gameId": "W2Y6" }
// response
{
  "winners": [
    { "rank": 1, "nickname": "たろう", "winCode": "WIN-7XK2Q9AB", "achievedBallIndex": 30 }
  ],
  "tieBreakApplied": true,
  "tieBreakSeed": "a3f9..."   // 監査用に leaderboard にも公開
}
```

処理: verified claims を achievedBallIndex 昇順に順位付け(同値同順位)→
prizeCount 境界に同着がいる場合は `tieBreakSeed` による決定論的シャッフルで当選者を選出 →
winners 作成(winCode 発行)→ status=finished。

## その他(Phase 2-3)

- **hideNickname** `{ gameId, cardId, hidden }` — host のみ。leaderboard 再投影
- **markWinnerHandled** `{ gameId, winnerId, handled }` — host のみ
- **expireGame** `{ gameId }` — host のみ。以後 join/claim 不可

## クライアント購読(Firestore read)

| パス | 誰が | 用途 |
|---|---|---|
| `games/{id}` | 全員 | draws(revealAt フィルタ)・status・reachCount |
| `cards/{gameId}_{uid}` | 本人 | 自カード復帰 |
| `games/{id}/public/leaderboard` | 全員 | ランキング表示 |
| `winners/{gameId}_{uid}` | 本人 | 当選コード表示 |
