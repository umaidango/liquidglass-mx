# LiquidGlass MX

背景を**実際に屈折させる**「リキッドグラス」を、多くのブラウザで使えるようにする依存ゼロのフレームワークです。
`class="lg"` を付けた要素が、曲面ガラスとして背景をゆがめ、縁に光のハイライトを持ちます。

- デモ: [`demo/index.html`](demo/index.html)（架空の環境音アプリ「Halcyon」のホームページ）
- 最小構成の例: [`examples/minimal.html`](examples/minimal.html)
- 本体: [`dist/liquidglass.js`](dist/liquidglass.js) / [`dist/liquidglass.css`](dist/liquidglass.css)

## 仕組み

見た目を CSS で似せるのではなく、ガラスの形から光の曲がり方を計算しています。

1. **曲面の形**: 要素の角丸矩形の縁から内側へ、幅 `bezel` の範囲を曲面とします。断面は `squircle`（既定）/ `circle` / `parabolic` から選べます。
2. **屈折（スネルの法則）**: 真上から見た視線が曲面に入り、`n₁ sin θ₁ = n₂ sin θ₂`（空気 1.0 → ガラス `ior`）で曲がります。その位置のガラスの高さを進んだぶんだけ、背景を読む位置が横にずれます。ずれ = 高さ × tan(θ₁ − θ₂)。
3. **変位マップ**: このずれを要素ごとに R/G チャンネルへ書き出します（B は縁のマスク）。
4. **色収差**: R・G・B を少しずつ違う量だけずらし、分散を表現します。
5. **鏡面ハイライト**: 同じ面の法線と光源の向き（`lightAngle`）から、光が当たる側の縁は明るく、反対側は内部反射として弱く光らせます。デバイスの解像度で生成します。

## 描画方式とブラウザ対応

要素ごとに、使える中で最も忠実な方式を自動で選びます。

| 方式 | 対象ブラウザ | 屈折するもの | 実装 |
|---|---|---|---|
| `native` | Chromium 系（Chrome / Edge / Opera / Samsung Internet / Brave など） | 背後の DOM すべて（動画やスクロール中のテキストも） | SVG フィルター（`feDisplacementMap`）を `backdrop-filter: url(#…)` に適用 |
| `mirror` | Safari、Firefox、iOS のすべてのブラウザ（WebGL 対応環境） | `data-lg-backdrop` で指定した背景（canvas / img / video / CSS 背景画像） | 共有 WebGL コンテキストで背景テクスチャを屈折・ぼかし・分散処理し、要素内の canvas に描画 |
| `fallback` | 上記が使えない場合、入れ子のガラス、`prefers-reduced-transparency` | なし（すりガラス） | `backdrop-filter: blur() saturate()` ＋ 物理計算のハイライト |
| CSS のみ | JavaScript 無効時 | なし | すりガラス ＋ CSS の縁取り。`backdrop-filter` 非対応ならやや不透明なパネル |

Chromium 以外では SVG フィルターを `backdrop-filter` に使っても屈折しないため、Chromium は UA で判定しています。`@supports` は `url()` を構文として受け付けてしまうため、判定に使えません。Safari の挙動は情報源によって記述が分かれています（2026-11 時点で確認できた範囲）。
参考: [Mozilla Connect: Support SVG filters in backdrop-filter](https://connect.mozilla.org/t5/ideas/support-svg-filters-in-backdrop-filter-for-advanced-glass/idi-p/98453)、[DEV: Liquid Glass on the web](https://dev.to/devyatov/liquid-glass-on-the-web-6-ways-to-build-it-with-css-and-svg-3m07)、[MDN: backdrop-filter](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)

### 検証した範囲

- **自動テストで確認**: Chromium（Playwright・ヘッドレス）での `native` / `mirror` / `fallback` の 3 方式。`mirror` は `LiquidGlassConfig = { native: false }` で Chromium 上に Safari/Firefox の条件を再現して確認しています。
- **未確認**: 実機の Safari・Firefox・iOS・Android。WebGL1 と標準 API だけで書いていますが、実機での表示確認が必要です。

## 使い方

```html
<link rel="stylesheet" href="dist/liquidglass.css">

<!-- mirror 方式で屈折させたい背景を指定（Chromium では無くても屈折します） -->
<body data-lg-backdrop="#bg">
  <canvas id="bg"></canvas>

  <div class="lg lg-card">ガラスのカード</div>
  <button class="lg lg-btn lg-btn--primary">ボタン</button>

  <script src="dist/liquidglass.js"></script>
</body>
```

読み込むと `DOMContentLoaded` で `.lg` を自動検出します。後から追加された要素も `MutationObserver` で拾います。

### パラメーター

data 属性・CSS 変数・JS の 3 通りで指定できます（後のものが優先）。CSS 変数は単位なしの数値です。

| オプション | data 属性 | CSS 変数 | 既定値 | 内容 |
|---|---|---|---|---|
| `thickness` | `data-lg-thickness` | `--lg-thickness` | 24 | ガラスの厚み（px）。大きいほど強く曲がる |
| `bezel` | `data-lg-bezel` | `--lg-bezel` | auto | 曲面部分の幅（px）。auto は角丸半径から決定 |
| `ior` | `data-lg-ior` | `--lg-ior` | 1.5 | 屈折率。1.0 で屈折なし |
| `profile` | `data-lg-profile` | `--lg-profile` | squircle | 断面形状: squircle / circle / parabolic |
| `blur` | `data-lg-blur` | `--lg-blur` | 2 | 背景のぼかし（px、標準偏差） |
| `saturation` | `data-lg-saturation` | `--lg-saturation` | 1.5 | 彩度 |
| `brightness` | `data-lg-brightness` | `--lg-brightness` | 1.05 | 明るさ |
| `aberration` | `data-lg-aberration` | `--lg-aberration` | 0.08 | 色収差（R/B のずれの比率） |
| `specular` | `data-lg-specular` | `--lg-specular` | 0.7 | 縁のハイライトの強さ |
| `lightAngle` | `data-lg-light-angle` | `--lg-light-angle` | -55 | 光源の向き（度、-90 = 上から） |
| `mode` | —（※） | `--lg-mode` | auto | auto / native / mirror / fallback |
| `mirror` | `data-lg-mirror` | `--lg-mirror` | full | mirror 方式で全面を描くか（full）、縁だけ描いて中央は DOM を透かすか（rim） |
| `backdrop` | `data-lg-backdrop` | — | 祖先の `data-lg-backdrop` | mirror 方式の背景（セレクターか要素） |

※ `data-lg-mode` 属性は、実際に使われている描画方式を表す出力です。方式を指定するときは CSS 変数か JS を使ってください。

見た目のトークン: `--lg-tint`（色味）、`--lg-radius`、`--lg-shadow`、`--lg-accent`、`--lg-fg` など。ライト/ダークは `prefers-color-scheme` と `data-theme="light|dark"` の両方に対応しています。

### コンポーネント

| クラス | 内容 |
|---|---|
| `.lg` | ガラス面（基本） |
| `.lg--clear` / `.lg--frosted` / `.lg--accent` | 透明 / すりガラス強め / アクセント色 |
| `.lg-btn`（`--primary` / `--icon`） | ボタン。押すとバネの動きで膨らむ |
| `.lg-card` / `.lg-panel` / `.lg-chip` / `.lg-nav` | カード / パネル / チップ / ナビゲーション |
| `.lg-segmented` | セグメント切り替え。移動中のつまみは膨らみ、透明なガラスになる |
| `.lg-switch` | スイッチ（ネイティブの checkbox を使用）。押している間ノブがレンズになる |
| `.lg-slider` | スライダー（ネイティブの range を使用） |
| `.lg-field` | テキスト入力 |
| `[data-lg-draggable]` | ドラッグ可能。速度に応じて伸び縮みする。矢印キーでも移動できる |

マークアップ例は [`demo/index.html`](demo/index.html) を参照してください。

### JavaScript API

```js
LiquidGlass.attach(el, { thickness: 40 });   // 手動で適用
LiquidGlass.update(el, { ior: 1.8 });        // パラメーター変更
LiquidGlass.detach(el);                      // 解除
LiquidGlass.refresh();                       // CSS 変数を変えた後に再計算
LiquidGlass.invalidateBackdrop(canvas);      // mirror 方式の背景を描き直したときに呼ぶ
LiquidGlass.getMode(el);                     // 'native' | 'mirror' | 'fallback'
LiquidGlass.draggable(el, { bounds: '.area' });
LiquidGlass.capabilities;                    // { native, backdropFilter, webgl, ... }

el.addEventListener('lg:ready', e => console.log(e.detail.mode));
```

読み込み前の設定: `window.LiquidGlassConfig = { selector: '.lg', forceMode: null, native: undefined, maxPixelRatio: 2 }`。
自動初期化を止める場合は `<script src="liquidglass.js" data-lg-manual>` とし、`LiquidGlass.init()` を呼びます。

Node.js からは DOM を使わない純関数（`computeLensMap`、`computeSpecularMap`、`buildProfileTable`）だけを使えます。

## 制約

- **祖先要素の `opacity` < 1、`filter`、`mask`、`clip-path`、`backdrop-filter`** は、子の `backdrop-filter` が参照できる背景を区切ります（仕様上の Backdrop Root）。ガラスの祖先にはこれらを付けないでください。
- **mirror 方式で屈折するのは指定した背景だけ**です。ガラスの下にある DOM（テキストなど）は屈折せず、`full` では隠れます。DOM の上に重なる要素には `--lg-mirror: rim` を使ってください。
- mirror 方式の背景画像は同一オリジンか CORS 許可が必要です（WebGL の制約）。
- 回転（`rotate`）した要素の屈折は正しく計算されません。拡大縮小には対応しています。
- 角丸は 4 隅が同じ半径である前提です。
- 変位マップは要素の大きさごとに作ります。CSS アニメーションで大きさを毎フレーム変えると再計算が続くため、動かすときは `transform` / `scale` / `translate` を使ってください。
- **性能**: ヘッドレス Chromium（GPU なしのソフトウェア描画）でしか測っていません。この環境では mirror 方式で「WebGL → 2D canvas」のコピーが重く、実機の GPU 環境とは傾向が違います。ガラスの数が多いページや背景を毎フレーム描き直すページでは、実機で確認してください。

## アクセシビリティ

- `prefers-reduced-transparency: reduce` で不透明に近いパネル、`prefers-reduced-motion: reduce` でバネの動きを止めます。
- `forced-colors`（Windows のハイコントラスト）では効果を外し、枠線を表示します。
- スイッチとスライダーはネイティブの `input` を使い、キーボード操作とスクリーンリーダーに対応しています。

## 開発

```sh
npm test            # 光学計算の単体テスト（node:test）
npm run test:e2e    # Playwright（Chromium）で 3 方式・2 画面幅・操作を確認
npm run serve       # http://localhost:8080/demo/ で確認
```

デモは `file://` でも開けますが、Google Fonts を読むためオンライン環境を推奨します。

## ライセンス

未設定です。公開する場合は `LICENSE` を追加してください。
