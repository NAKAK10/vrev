# プラグイン開発ガイド

新規 integration は **schema v4** のみを使ってください（v1〜v3 は one-beta 互換維持のみ）。
manifest と Plugin API の厳密な仕様は [プラグイン基盤](./plugins.md)、UI bridge は [UI ブリッジ](./plugin-ui-bridge.md) を参照してください。

## base plugin（scaffold）でできること

`vrev plugin create` が生成する最小構成は、生成直後からそのまま動作します。生成器の実装は `src/plugin-scaffold.ts` です。

```bash
vrev plugin create my-plugin --title "My Plugin" --summary "レビュー処理を拡張します"
cd plugins/my-plugin && npm test
vrev plugin run my-plugin hello world
```

生成物一覧:

| ファイル | 役割 | 生成直後の動作 |
|---|---|---|
| `vrev.plugin.json` | schema v4 manifest | `display` + `server` + `ui.contributions` + `commands.hello` を宣言 |
| `index.js` | ESM command | `hello` が `Hello from <id>: <args>` を出力 |
| `server/index.js` + `server.contract.json` | server provider 雛形 | `query`/`command` は `NOT_FOUND` を返す。ここに実装を足す |
| `ui/annotation-action.ui.json` | 宣言的 UI | `review.sidebar` に「注釈アクション」ボタンを追加。click で成功 toast |
| `types.d.ts` | SDK 型 re-export | `@vrev/plugin-sdk` の補完が効く |
| `package.json` | `vrev.apiVersion: 1` 宣言 | Core が直接依存として検出（検出時に code は評価しない） |
| `README.md` | 設定画面に表示される README | `configuration` テンプレートと `ui.extension_points` 例付き |
| `test.js` | `node --test` | `hello` export の存在確認 |

既存 directory は上書きしません。`plugins/` が symlink の場合は拒否されます。

## 画面

### レビュー画面 sidebar の「注釈アクション」ボタン

scaffold の UI contribution（`review.sidebar` slot）が描画するボタンです。クリックすると成功 toast が表示され、`ui/annotation-action.ui.json` を書き換えることで実際の操作に置き換えられます。

![base plugin の sidebar ボタン](/images/scaffold-sidebar.png)

ボタンをクリックすると成功 toast が表示されます:

![注釈アクションボタンの toast](/images/scaffold-toast.png)

### 設定画面 `/settings/plugins` の一覧と詳細

生成時に渡した `--title` / `--summary` が一覧に表示され、同梱の `README.md` が「詳細」modal に描画されます。有効/無効 toggle は即時保存されます。

![プラグイン管理画面](/images/settings-plugins.png)

> スクショは `vrev serve --target .code/htmls/example/index.html` 起動中の画面を chrome-devtools で撮影したものです。

## 開発手順

### Step 1. scaffold 生成

```bash
vrev plugin create --help
vrev plugin create my-plugin --title "My Plugin" --summary "概要"
# 生成と同時に workspace へ install する場合
vrev plugin create my-plugin --install
```

### Step 2. 種別を決める

| やりたいこと | manifest 宣言 | 実装場所 |
|---|---|---|
| CLI command | `commands: [{ name, module, export }]` | `index.js` の `PluginCommandHandler` |
| server capability | `server: { module, contract }` + `requires` / `provides` | `server/index.js` + `server.contract.json` |
| 宣言的 UI | `ui: { contributions[] }` | `ui/*.ui.json`（allowlist component のみ） |
| 他 plugin に拡張させる | `ui.extension_points[]` | 自 UI document 内の `slot` node |
| storage / issue provider | `storage_provider` / `issue_provider` | `loadPlugin*Provider` 経由で利用 |

制約:

- `id` は小文字英数字開始、`[a-z0-9._-]`、最大 64 文字
- `module` は `./` 始まりの canonical POSIX relative path（`..`・絶対 path・`\` 禁止）
- `configuration` は `string` / `integer` / `boolean` / `select` のみ。secret は `source: environment` または `source: credential + type: secret` とし、値は保存しない
- credential は `context.configuration` / `credentials` 経由でのみ受け渡し、argv・log・subprocess 引数に混ぜない

### Step 3. server / UI を拡張する

- `query` / `command` を増やす → `server.contract.json` と `server/index.js` を同時更新
- 別の slot に出す → `ui.contributions[].slot` を変更（Core slot: `review.header` / `review.stage` / `review.sidebar` / `settings.detail`）
- 自前の `extension_points` を host する → scaffold `README.md` の JSON 例を `vrev.plugin.json` の `ui` へ移す

`ai` が AI method 実行を所有し、`annotation-workflow` / `github-issue` は `ai/v1` へ依頼するだけです。独自の AI 選択 UI は作らないでください。

### Step 4. install して動作確認

標準は対象 workspace の直接依存として追加する方法です（Core は `dependencies` / `devDependencies` / `optionalDependencies` の直接依存のみ検出）:

```bash
npm install --save-dev ./plugins/my-plugin   # 開発中
vrev plugin list
vrev plugin run my-plugin hello world
vrev serve --target .code/htmls/example/index.html
# /settings/plugins で有効化 → sidebar ボタンを確認
```

旧来方式も one-beta 互換で残っています:

```bash
vrev plugin install ./plugins/my-plugin
vrev plugin install @scope/public-plugin@1.2.3
vrev plugin install github:owner/repo#v1.2.3   # tag/SHA 固定必須、未固定は拒否
```

`/settings/plugins` からの install は常に無効状態で始まります。内容を確認してから有効化してください。

### Step 5. 公開する

```bash
npm test
npm run build
npm pack --dry-run
```

- npm は exact version 推奨。GitHub spec は tag / commit SHA を `#` で固定
- install 時に install script・dependency install は実行されません。Node 標準 API のみで自己完結させるか、成果物を bundle してください
- token を URL に埋め込まない。scope 別 registry は `.npmrc` + `NODE_AUTH_TOKEN` で設定します

### Step 6. 安全性チェック

plugin install 時は manifest と file を検証・copy するだけで module は実行しません。ただし `plugin run` や provider 利用時には、その plugin の JavaScript が Vrev と同じユーザー権限で動作します。install 前に次を確認してください:

- 公開元、license、source code、release tag または commit SHA
- `vrev.plugin.json` で宣言されている module と権限相当の処理
- network 送信先、file 操作範囲、利用する環境変数
- package が依存物を bundle 済み、または Node.js 標準 API だけで自己完結していること
