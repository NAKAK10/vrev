# visual-review

ローカルHTML・画像へDOMノード／範囲単位で注釈を付け、各種coding agentへ修正を依頼するためのローカルVisual Reviewツールです。

## 主な機能

- HTMLのDOMノード選択と矩形範囲指定
- 画像の矩形範囲指定
- 注釈スレッドと `open` / `in_progress` / `addressed` / `resolved` の状態管理
- 注釈カード選択時のモーダル・ドロワー・popover・details復元
- PC／タブレット（768px）／スマホ（390px）の表示切り替え
- OpenCode／Claude／Codex／GitHub Copilot／Pi／カスタムコマンドによるAI一括修正
- リポジトリ外から `--project-root` を指定できるCLI
- schema v2、atomic write、lock、server lease、永続ジョブキュー

## 必要環境

- Node.js 20以上
- AI一括修正を使う場合は、次のいずれかのCLI
  - `opencode`
  - `claude`
  - `codex`
  - `copilot`
  - `pi`
  - または登録したカスタムコマンド

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

レビュー情報はrepository rootの`.vreview/`へ集約します。解決済みannotationは別JSONへ移動します。

```text
.vreview/
├── settings.json
├── .gitignore
└── reviews/<safe-stem>--<path-hash>/
    ├── review.json       # 未対応・AI対応中・AI対応済み
    ├── resolved.json     # 解決済み
    ├── context.json      # 初回AIによるproject/monorepo探索結果
    └── job-state.json    # Git管理対象外
```

`settings.json`がmonorepo内のprojectとreview参照をrepository相対pathで管理します。`review.json`、`resolved.json`、`context.json`、`settings.json`はGit管理対象です。runtime stateは`.vreview/.gitignore`で除外します。旧`.code/visual-reviews/.../review.json`は対象を最初に開いたとき自動移行します。

## 起動

```bash
cd /absolute/path/to/project
visual-review serve --target .code/htmls/example/index.html
```

画像の場合:

```bash
visual-review serve --target assets/example.png
```

`--project-root`省略時は実行directoryをprojectとして扱い、最寄りのGit rootをworkspace/storage rootとして自動検出します。monorepoのchild projectから実行した場合もrootの`.vreview/settings.json`へ集約し、child project pathを登録します。Git管理外では実行directory自身がrootです。明示的な`--project-root`は別directoryを対象にするときだけ使用します。

既定の開始ポートは `18765` です。使用中の場合は `18766`、`18767`…の順に空きポートを自動選択します。`--port`を指定した場合も、その番号を起点に自動インクリメントします。ブラウザを自動で開かない場合は `--no-open` を追加します。

### 動的HTML

既定では対象JavaScriptを無効化します。完全に信頼できるローカルprototypeでのみ有効化してください。

```bash
visual-review serve \
  --target .code/htmls/example/index.html \
  --allow-scripts
```

AI一括修正は既定で有効です。対象JavaScriptを動かしながらAI修正を無効にしたい場合だけ、`--no-ai-jobs-with-scripts`を指定します。未確認または第三者由来のHTMLでは`--allow-scripts`を使用しないでください。

## 操作

- `V`: 閲覧
- `N`: DOMノード選択
- `R`: 矩形範囲指定
- `PC / タブレット / スマホ`: responsive表示切り替え
- AI一括修正欄右上の`•••`: CLI、最大並列数（read-only調査agent 1〜10）、自動実行、カスタムコマンドをmodalで設定
- 注釈欄右上の`•••`: 状態と種類を複数選択できるbadge形式のfilter modal。初期状態は「未対応・AI対応中・AI対応済み」と全種類を選択
- `注釈を保存したら自動でAI修正を開始`: 有効にすると、注釈保存後に確認dialogなしでjobをqueueへ追加。設定はbrowserに保存され、手動の「AIにまとめて修正依頼」ボタンは非表示

注釈JSONにはviewportの幅・高さに加えて`viewport_mode`（`desktop` / `tablet` / `mobile`）も保存されます。AIは修正とbrowser検証を同じ表示modeで行います。

注釈statusは`open`（未対応）→`in_progress`（AI対応中）→`addressed`（AI対応済み）→`resolved`（解決済み）で管理します。job失敗・キャンセル時は`in_progress`から`open`へ戻ります。`resolved`へ変更できるのは人間だけです。

カスタムコマンドはbrowser localStorageへ登録し、shellを介さず実行ファイルと引数へ分割して起動します。`{prompt}`を書いた引数へ依頼文を挿入し、省略時は最後の引数に追加します。

```text
ollama launch claude --model deepseek-v4-flash:cloud -- -p {prompt}
```

API keyやtokenをコマンド欄へ記載しないでください。認証は各CLIの既存設定または環境変数を利用します。

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
cd /path/to/repository
visual-review serve --target http://127.0.0.1:5173
```

開発サーバーも同時に起動する場合:

```bash
cd /path/to/repository
visual-review serve \
  --target http://127.0.0.1:5173 \
  --start "npm run dev"
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

## hosting済みサイト

公開またはstaging環境のHTTPS URLも、ローカルの実装repositoryと紐付けてレビューできます。

```bash
cd /path/to/local/repository
visual-review serve --target https://staging.example.com/products
```

AIはhosting先そのものを書き換えるのではなく、自動検出したローカルworkspaceを修正します。公開サイトからローカルAPIやAI実行機能へ干渉されないよう、public targetはread-only static modeで取得し、対象サイトのJavaScript、form、cross-origin navigationを無効化します。SSR/WordPressなどHTMLを返すサイトに対応します。client-side renderingだけで内容を生成するSPAは、localhost targetを利用してください。

安全制約:

- public targetはHTTPSのみ。URL内credentialは禁止
- DNS解決先がloopback、private、link-local、予約addressの場合は拒否
- request cookie・authorizationとresponse cookieは転送しない
- redirectは同一origin内だけ許可
- `--allow-scripts`、`--start`、`--stop`はpublic targetでは使用不可
