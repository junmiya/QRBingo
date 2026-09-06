# Data Model: リアルタイム配信ビンゴ (v2)

**Date**: 2026-07-11 | **Plan**: [plan.md](./plan.md)

Firestore コレクション設計。**すべての write は Cloud Functions 経由**(クライアント直書き禁止)。

## games/{gameId}

ゲーム本体。参加者全員が onSnapshot でリッスンする公開ドキュメント。

| フィールド | 型 | 説明 |
|---|---|---|
| status | string | `lobby` \| `playing` \| `finished` \| `expired` |
| hostUid | string | ホストの匿名認証 UID |
| settings.winLines | number | 勝利条件ライン数 1〜12(デフォルト 1) |
| settings.revealDelaySec | number | 公開ディレイ 0〜60(デフォルト 0) |
| settings.capacity | number\|null | 定員(null = 無制限) |
| settings.allowDuplicateCards | boolean | true で重複チェック省略 |
| settings.prizeCount | number | 景品数(ランキング上位 n 名) |
| draws | array | `{ n: 1-75, ballIndex: 1-75, revealAt: Timestamp }` の配列(抽選順) |
| participantCount | number | 参加人数(集計) |
| reachCount | number | リーチ人数(集計・演出用) |
| createdAt / startedAt / finishedAt | Timestamp | ライフサイクル |

制約: `draws[].n` は一意。`status` 遷移は lobby→playing→finished→expired の一方向。
`settings` は `startedAt` 確定後は不変(FR-002)。

補助フィールド `leaderboardDirty`(boolean)/`leaderboardFlushAt`(Timestamp|null):
公開ランキング再構築のスロットリング用。submitClaim が間隔(3秒)内に来た場合は dirty を立て、
リース(`leaderboardFlushAt`)を取った1リクエストだけが間隔明けまで待って再構築する(末尾フラッシュ)。
これにより最後のクレームも次の抽選を待たずに最大3秒以内で反映される。リース保持者が落ちた場合の
保険として drawNumber 後の flush と finishGame の強制再構築が残る。
大人数時に「クレームごとの全再計算+全配信(O(N²))」を「一定間隔に最大1回(O(時間/間隔×N))」へ
抑えるための最適化(1000人規模のコストを約1/30以下に削減)。

公開 leaderboard / private results の各エントリは `tied`(boolean)を持つ: 同じ
achievedBallIndex のクレームが2件以上ある同着。順位は同順位(competition ranking)で、
景品数を超える場合のみ finishGame が tieBreakSeed による決定論的抽選で当落を決める。

## cards/{cardId}

参加者のカード。read は所有者のみ。`cardId = {gameId}_{uid}` とし「1 UID 1 カード」(FR-003)を
ドキュメント ID レベルで強制する。

| フィールド | 型 | 説明 |
|---|---|---|
| gameId | string | 参加ゲーム |
| uid | string | 所有者 |
| seed | string | カード生成シード(サーバー発行)。グリッドは保存しない(憲章 III) |
| gridHash | string | 正規化グリッドの SHA-256(重複排除用) |
| nickname | string | 1〜12 文字、NG フィルタ済み |
| nicknameHidden | boolean | ホストによる非表示フラグ |
| createdAt | Timestamp | |

## games/{gameId}/reaches/{uid}

リーチ状況(演出用・US-6)。read はホストのみ。write は reportReach Function が
サーバー検証の上で行う(虚偽報告は登録されない)。順位・当選には無関係。
ビンゴ成立(submitClaim verified)時に自動削除される。

| フィールド | 型 | 説明 |
|---|---|---|
| uid / nickname | string | 対象プレイヤー |
| reachLines | number | あと1マスのライン本数 |
| lines | number | 既に成立済みのライン本数(winLines>1 用) |
| ballIndex | number | 報告時点の公開済み最終球 |
| updatedAt | Timestamp | |

## games/{gameId}/gridHashes/{gridHash}

一意性保証用のロックドキュメント(allowDuplicateCards=false のときのみ)。
`joinGame` トランザクション内で create し、既存なら別シードで再試行。
ドキュメント ID 衝突を使うため O(1)。

| フィールド | 型 | 説明 |
|---|---|---|
| cardId | string | 使用者 |

## claims/{claimId}

ビンゴ申告。`claimId = {gameId}_{uid}` で冪等。

| フィールド | 型 | 説明 |
|---|---|---|
| gameId / cardId / uid | string | |
| status | string | `verified` \| `rejected` |
| achievedBallIndex | number | 条件を満たした球数(順位の唯一の基準・サーバー算出) |
| lines | number | 成立ライン数(検証時点) |
| verifiedAt | Timestamp | 参考情報(順位には使わない) |

## games/{gameId}/public/leaderboard

Functions が投影する公開ランキング(個別 claim は非公開のまま)。

| フィールド | 型 | 説明 |
|---|---|---|
| entries | array | `{ rank, nickname(伏字反映済), achievedBallIndex, isWinner }` |
| tieBreakSeed | string\|null | 同着抽選に使った乱数シード(監査用・finished 後に公開) |
| updatedAt | Timestamp | |

## winners/{winnerId}

当選確定情報。read は当人と host のみ。`winnerId = {gameId}_{uid}`。

| フィールド | 型 | 説明 |
|---|---|---|
| gameId / uid / cardId | string | |
| rank | number | 確定順位 |
| winCode | string | 当選コード。`WIN-` + 8文字(31進アルファベット ≈ 40bit) |
| handled | boolean | ホストの対応済みフラグ |
| createdAt | Timestamp | |

## 状態遷移

```
Game:   lobby ──開始──▶ playing ──終了──▶ finished ──失効──▶ expired
Card:   (発行) ─── ゲームに追従。playing 以降は新規発行を capacity と status で制御
Claim:  (なし) ──submitClaim──▶ verified / rejected   ※ verified は不変
Winner: finishGame 時に claims から一括生成(同着抽選込み)
```

## 検証ルール(サーバー側)

1. クレーム受理時: `seed` からグリッド再計算 → `revealAt <= now` の draws のみでライン数算出
2. `achievedBallIndex` = ライン数が `winLines` に最初に到達した draws の ballIndex(二分探索可、75 固定なので線形で十分)
3. クライアントから受け取るのは cardId のみ。グリッド・ライン数・時刻は一切信用しない(SC-003)
