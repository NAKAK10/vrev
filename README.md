# visual-review

ローカルHTML・画像へDOMノード／範囲単位で注釈を付け、OpenCode・Claude・Codexへ修正を依頼するためのローカルVisual Reviewツールです。

## 主な機能

- HTMLのDOMノード選択と矩形範囲指定
- 画像の矩形範囲指定
- 注釈スレッドと `open` / `addressed` / `resolved` の状態管理
- 注釈カード選択時のモーダル・ドロワー・popover・details復元
- PC／タブレット（768px）／スマホ（390px）の表示切り替え
- OpenCode／Claude／CodexによるAI一括修正
- リポジトリ外から `--project-root` を指定できるCLI
- schema v2、atomic write、lock、server lease、永続ジョブキュー

## 必要環境

- Node.js 20以上
- AI一括修正を使う場合は、次のいずれかのCLI
  - `opencode`
  - `claude`
  - `codex`

## セットアップ

```bash
git clone https://github.com/NAKAK10/visual-review.git
cd visual-review
npm ci
npm run build
npm link
```

以後は `visual-review` コマンドを利用できます。

## 対象リポジトリの配置規則

対象リポジトリでは、レビュー対象を次の場所へ置きます。

```text
.code/htmls/**/*.html
assets/**/*.{png,jpg,jpeg,gif,webp,svg}
```

レビュー結果は対象リポジトリ内へ保存されます。

```text
.code/visual-reviews/<safe-stem>--<path-hash>/review.json
```

`review.json`はGit管理対象です。`job-state.json`、`.server-lease.json`、runtime lockはGit管理しません。

## 起動

```bash
visual-review serve \
  --project-root /absolute/path/to/project \
  --target .code/htmls/example/index.html
```

画像の場合:

```bash
visual-review serve \
  --project-root /absolute/path/to/project \
  --target assets/example.png
```

既定の開始ポートは `18765` です。使用中の場合は `18766`、`18767`…の順に空きポートを自動選択します。`--port`を指定した場合も、その番号を起点に自動インクリメントします。ブラウザを自動で開かない場合は `--no-open` を追加します。

### 動的HTML

既定では対象JavaScriptを無効化します。完全に信頼できるローカルprototypeでのみ有効化してください。

```bash
visual-review serve \
  --project-root /absolute/path/to/project \
  --target .code/htmls/example/index.html \
  --allow-scripts
```

対象JavaScriptとAI一括修正を併用する場合は、追加の明示許可が必要です。

```bash
visual-review serve \
  --project-root /absolute/path/to/project \
  --target .code/htmls/example/index.html \
  --allow-scripts \
  --allow-ai-jobs-with-scripts
```

未確認または第三者由来のHTMLでは、上記2つのflagを使用しないでください。

## 操作

- `V`: 閲覧
- `N`: DOMノード選択
- `R`: 矩形範囲指定
- `PC / タブレット / スマホ`: responsive表示切り替え

AIは修正後にメッセージを追加して `addressed` へ変更します。`resolved`へ変更できるのは人間だけです。

## 開発

```bash
npm ci
npm test
npm run build
```

## localhostアプリ

`--target`へloopback URLを渡すと、同一生成元のローカルreverse proxyを通してDOM注釈できます。HTTPの`localhost`、`127.0.0.1`、`::1`だけを許可し、外部URLやURL内credentialは拒否します。

起動済みの開発サーバーを確認する場合:

```bash
visual-review serve \
  --project-root /path/to/repository \
  --target http://127.0.0.1:5173 \
  --allow-ai-jobs-with-scripts
```

開発サーバーも同時に起動する場合:

```bash
visual-review serve \
  --project-root /path/to/repository \
  --target http://127.0.0.1:5173 \
  --start "npm run dev" \
  --allow-ai-jobs-with-scripts
```

`--start`のprocessはproject rootで起動し、Visual Review終了時に停止します。Docker Composeなど起動command自体が終了してserviceだけが残る構成では、`--stop "npm run down"`も指定してください。

### 対応framework

DOM selector、表示text、routeに加え、development runtimeから取得できる場合はcomponent名とsource file hintも注釈へ保存します。

- Vue / Nuxt
- React / Next.js
- Angular
- Svelte / SvelteKit
- WordPress / PHP theme
- framework情報を取得できない一般的なHTML/JavaScriptアプリ

source hintはframeworkのdevelopment runtimeに依存する補助情報です。AI coordinatorはrepository内で実在と内容を確認してから編集します。
