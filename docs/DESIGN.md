# QRBingo デザインシステム & スタイルガイド

QRBingo のビジュアルアイデンティティと、`css/style.css` に実装されたコンポーネントの仕様をまとめる。
既存のバニラ HTML/CSS/JS 構成(ビルドツールなし)を維持したまま、「活気」「楽しさ」「視認性」を軸に構成している。

## 1. デザインコンセプト

ビンゴのワクワク感を出すため、暖色のブランドカラーと立体的な抽選ボールを軸に据えつつ、
TV 配信・大画面での利用を想定して情報の階層と文字サイズを設計している。

### 1.1 配色パレット (CSS変数)

ライトモードとダークモードの両方を CSS 変数で管理する。

| 役割 | CSS変数 | ライト | ダーク |
| :--- | :--- | :--- | :--- |
| Primary | `--primary` | `#FF6B6B` (Coral Red) | `#FF7B7B` |
| Primary (濃) | `--primary-strong` | `#F05252` | `#FF9A9A` |
| Secondary | `--secondary` | `#4ECDC4` (Turquoise) | `#5EDDD4` |
| Accent | `--accent-yellow` | `#FFD166` (Sunny Yellow) | `#FFE08F` |
| Success | `--success` | `#06D6A0` (Emerald) | `#2FE0B5` |
| Danger | `--danger` | `#E63946` | `#FF6B6B` |
| Background | `--bg` | `#F8F9FA` | `#0F1419` |
| Panel | `--panel` | `#FFFFFF` | `#1E2533` |
| Text | `--text` | `#2C3E50` | `#E8EAED` |
| Text (副) | `--text-secondary` | `#6B7C8D` | `#9AA7B8` |
| Border | `--border` | `#E3E8EE` | `#313B4D` |

既存 HTML の inline style が参照している旧変数(`--accent` / `--muted` / `--line` / `--ok`)は
新変数への別名として残してあるため、過去のマークアップもそのまま動作する。

### 1.2 ビンゴ列カラー

| 列 | 変数 | ライト | ダーク |
| :--- | :--- | :--- | :--- |
| B | `--col-b` | `#FF6B6B` | `#FF7B7B` |
| I | `--col-i` | `#4ECDC4` | `#5EDDD4` |
| N | `--col-n` | `#FFD166` | `#FFE08F` |
| G | `--col-g` | `#FF9F43` | `#FFB067` |
| O | `--col-o` | `#A78BFA` | `#BCA6FF` |

### 1.3 コントラストのための例外

- **マーク済みマス** (`--mark-from` / `--mark-to`): マス上の白文字が読めるよう、
  `--primary` とは別に濃いめの赤を持たせている。ダークモードで `--primary` を明るく振っても、
  マーク済みマスは濃い赤のまま保たれる。
- **ゲームコード / カウントダウン**: 赤と青緑(補色)を混ぜると中間が灰色に濁って視認性が落ちるため、
  グラデーションは `--primary-strong` → `--col-g` の暖色でまとめている。

## 2. タイポグラフィ

- フォント: `"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif`
- 見出し: `font-weight: 800`〜`900`
- 数字: ビンゴボール・カード・順位・カウントダウンには `font-variant-numeric: tabular-nums` を適用し、
  桁が変わっても幅が揃うようにしている。

## 3. 主要コンポーネント

### 3.1 ボタン
- `.btn-primary`: グラデーション背景 + シャドウ。主要アクション(ゲーム作成・抽選など)。
- `.btn-ghost`: 枠線のみ。キャンセルや補助アクション。
- `.btn-row`: 横並びコンテナ。430px 以下では自動で縦積みになる。

### 3.2 パネル (`.panel`)
角丸 + 控えめなシャドウのコンテナ。ホバーでシャドウが深くなる。

### 3.3 ビンゴカード (`table.bingo`)
- セル: 正方形(`aspect-ratio: 1`)。ホバーで拡大。
- `.marked`: グラデーション背景 + `mark-pop` アニメーション。
- `.reach-cell`: オレンジの破線 + 点滅(`reach-cell-blink`)。
- `.bingo-cell`: 緑のグロー(`glow-success`)。
- `.readonly`: オンラインモードの自動マーク用。ホバー拡大とカーソルを無効化。

### 3.4 抽選ボール (`.ball`)
`radial-gradient` と `::before` のハイライトで球体を表現。
抽選中は `.rolling`(`shake`)、確定時は `.pop`。

### 3.5 アナウンストースト (`.announce-toast`)
リーチ/ビンゴ/投げ銭の発生時に画面上部へ表示されるピル型通知。
コンテナ(`#announce-toasts`)は `js/online/live-extras.js` が自動生成するため、HTML に記述は不要。

## 4. レスポンシブ設計

| # | 幅 | 想定 | 主な調整 |
| :-- | :-- | :-- | :-- |
| 1 | ~400px | 小型スマホ | 基準フォント 16px、ボール 124px、プラン/投げ銭を1〜2列に |
| 2 | ~430px | スマホ全般 | `.btn-row` を縦積みにして文字の折り返しを防ぐ |
| 3 | 640px~ | タブレット | 余白拡大、ボタンを横並びに |
| 4 | 1024px~ | PC | ボール 168px。オンラインホストは2カラムのダッシュボード |
| 5 | 1440px~ | TV・配信 | 基準フォント 18px、ボール 210px、見出し・バナーを拡大 |

オンラインホスト画面(`online/host.html`)のダッシュボードは、
主要パネル(アカウント/作成/ロビー/抽選)を全幅、サブパネル(リーチ・ランキング・ライブ・チャット・投げ銭・管理)を
2カラムに自動で流す。`grid-row` を固定していないため、`hidden` のパネルがあってもレイアウトは崩れない。

## 5. ダークモード

OS 設定(`prefers-color-scheme: dark`)に自動追従する。
`<html data-theme="dark">` / `data-theme="light"` を付ければ強制的に切り替えられる。

## 6. ロゴ / ファビコン

- `img/logo.svg`: QRコードのモジュールとビンゴボールを組み合わせたシンボル + ワードマーク。
- `img/favicon.svg`: ボール単体。全ページの `<link rel="icon">` で共通利用。

いずれもベクター形式のため、大画面でも高精細に表示される。

## 7. 実装上の約束

- **JS が参照する id / class は変更しない。** マークアップを差し替える際は、
  `js/` 配下が `$('...')` で引いている id が欠けていないかを必ず確認する。
- アニメーションは `prefers-reduced-motion: reduce` で無効化される。
