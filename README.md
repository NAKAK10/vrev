# visual-review

HTML・画像・ローカルWebアプリへ注釈を付け、coding agentによる修正やGitHub Issue作成につなげるローカルVisual Reviewツールです。

## 主な機能

- DOMノード・矩形範囲への注釈
- PC／タブレット／スマートフォン表示の切り替え
- 注釈スレッド、状態、履歴、フィルター管理
- OpenCode／Claude／Codex／GitHub Copilot／Pi／カスタムCLIによるAI修正
- AIによるIssueラフ生成と`gh`経由のGitHub Issue作成
- static HTML、localhostアプリ、HTTPSのstagingサイトに対応

## 必要環境

- Node.js 20以上
- GitHub Issueを作成する場合は、認証済みのGitHub CLI（`gh`）と`github-issue`プラグイン
- AI修正を使う場合は、対応するcoding agent CLI

## インストール

このprivate GitHub Packageへのアクセス権と、`read:packages`を持つGitHub tokenが必要です。

```ini
# ~/.npmrc またはプロジェクトの .npmrc
@nakak10:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```bash
export NODE_AUTH_TOKEN=YOUR_GITHUB_TOKEN
npm install --global @nakak10/visual-review@beta
```

sourceから利用する場合:

```bash
git clone https://github.com/NAKAK10/visual-review.git
cd visual-review
npm ci
npm run build
npm link
```

## 起動

対象リポジトリで実行します。

```bash
visual-review serve --target .code/htmls/example/index.html
```

画像:

```bash
visual-review serve --target assets/example.png
```

起動済みのlocalhostアプリ:

```bash
visual-review serve --target http://127.0.0.1:5173
```

開発サーバーも起動する場合:

```bash
visual-review serve \
  --target http://127.0.0.1:5173 \
  --start "npm run dev"
```

HTTPSのstagingサイト:

```bash
visual-review serve --target https://staging.example.com/products
```

既定ポートは`18765`です。使用中の場合は次の空きポートを自動選択します。`--no-open`でブラウザの自動起動を無効化できます。

## JavaScriptを含むHTML

static HTMLでは対象JavaScriptを既定で無効化します。信頼できる対象でのみ有効化してください。

```bash
visual-review serve \
  --target .code/htmls/example/index.html \
  --allow-scripts
```

## 操作

- `V`: 閲覧
- `N`: DOMノード選択
- `R`: 矩形範囲指定
- `⌘+Enter` / `Ctrl+Enter`: 注釈・返信・Issueの送信
- AI設定: CLI、並列数、自動実行、カスタムコマンドを設定
- `GitHub Issueにする`: AIが編集可能なIssueラフを作成し、確認後にGitHubへ追加

カスタムコマンドには依頼文を渡す`{prompt}`を1回だけ記述します。commandはshellを介さず実行され、登録前にtool利用能力を検証します。

```text
agent-command --prompt {prompt}
```

API keyやtokenはcommandへ記載せず、各CLIの認証設定または環境変数を利用してください。

## プラグイン

プラグインは対象workspaceへinstallし、`.vreview/plugins/<plugin-id>/`で一段ずつ管理します。ローカルdirectoryと公開npm package specを利用できます。新規pluginのbaseも生成できます。

```bash
visual-review plugin create my-plugin --install
visual-review plugin run my-plugin hello world

# 同梱plugin

visual-review plugin install ./plugins/custom-command
visual-review plugin install ./plugins/firebase-storage
visual-review plugin install ./plugins/github-issue
visual-review plugin list
```

プラグインcommandは次の形式で実行します。

```bash
visual-review plugin run <plugin-id> <command> [args...]
```

このrepositoryには作成例とデバッグ用実装として次を収録しています。

- [`plugins/custom-command/`](plugins/custom-command/README.md): shellを介さないカスタムagent command管理・実行
- [`plugins/firebase-storage/`](plugins/firebase-storage/README.md): Firestore RESTを使うレビューJSONのpush/pull
- [`plugins/github-issue/`](plugins/github-issue/README.md): `gh`を使うGitHub Issue provider

GitHub Issue作成は`github-issue`プラグインを明示的にinstallしたworkspaceでのみ有効です。base作成方法、第三者のnpm/GitHub pluginの導入、安全性は[`plugins/README.md`](plugins/README.md)、manifestとPlugin APIの詳細は[`docs/plugins.md`](docs/plugins.md)を参照してください。

## データ保存

レビュー情報は対象Gitリポジトリの`.vreview/`へ保存します。

```text
.vreview/
├── settings.json
└── reviews/<target-id>/
    ├── review.json
    ├── resolved.json
    ├── context.json
    └── job-state.json
```

`job-state.json`などのruntime情報はGit管理対象外です。

## 対応対象と安全性

- local fileは`.code/htmls/**/*.html`と`assets/`配下の画像に対応
- localhostは`localhost`、`127.0.0.1`、`::1`のみ許可
- public targetはHTTPSのみ許可し、cookie・authorizationを転送しない
- public targetではJavaScript、form、ローカルAI APIを無効化
- GitHub Issueは対象リポジトリ内で`gh issue create`を実行して作成

## 開発

```bash
npm ci
npm test
npm run build
```

## リリース

GitHub Releaseを公開すると、GitHub Actionsがtest/buildを実行し、GitHub Packagesへpublishします。release tagは`v` + `package.json`のversionに一致させます。

```bash
npm version 1.0.0-beta.5 --no-git-tag-version
npm test
npm pack --dry-run
```
