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
- GitHub Issueを作成する場合は、認証済みのGitHub CLI（`gh`）。公式`github-issue`プラグインは初回起動時に自動導入されます
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

同一LAN上のprivate IPもHTTPで指定できます:

```bash
visual-review serve --target http://192.168.11.13:3000
```

HTTPSのstagingサイト:

```bash
visual-review serve --target https://staging.example.com/products
```

既定ポートは`18765`です。使用中の場合は次の空きポートを自動選択します。起動後は既定ブラウザを開き、ブラウザ起動コマンドの完了まで待って取りこぼしを防ぎます。`--no-open`でブラウザの自動起動を無効化できます。

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
- AI設定: CLI、並列数、自動実行、外部AIコマンドを設定
- `GitHub Issueにする`: AIが編集可能なIssueラフを作成し、確認後にGitHubへ追加

外部AIコマンドには依頼文を渡す`{prompt}`を1回だけ記述します。commandはshellを介さず実行され、登録前にtool利用能力を検証します。

```text
agent-command --prompt {prompt}
```

API keyやtokenはcommandへ記載せず、各CLIの認証設定または環境変数を利用してください。

## プラグイン

schema v4のPlugin Hostが現在の既定architectureです。Coreの宣言的rendererが、公式pluginの検証済みJSON UI documentを描画し、browserでplugin JavaScriptや任意HTMLを実行しません。`review`が注釈・履歴・永続化、`annotation-workflow`がAI job、`custom-command`が検証済みrunner、`github-issue`がIssue workflowを所有します。

プラグインは対象workspaceの`.vreview/plugins/<plugin-id>/`で一段ずつ管理します。`visual-review serve`は、未導入の公式`review`、`github-issue`、`custom-command`、`annotation-workflow`を本体packageから自動installします。同じbundled source由来でmanifestの一致を確認できるtrusted copyだけは、同梱schemaまたはSemVerが新しい場合にatomic upgradeします。local/third-partyの同一IDや改変済みcopyは自動で上書き・実行しません。

ローカルdirectoryと公開npm package specによる手動追加や、新規pluginのbase生成もできます。`plugin create`はprovider/command互換のschema v3 manifest、title/summary、README、設定項目テンプレート、example command、testを生成します。server capabilityや宣言的UIを提供するpluginは[`docs/plugins.md`](docs/plugins.md)のschema v4 contractへ更新してください。

```bash
visual-review plugin create --help
visual-review plugin create my-plugin \
  --title "My Plugin" \
  --summary "レビュー処理を拡張します" \
  --install
visual-review plugin run my-plugin hello world
visual-review plugin install ./plugins/firebase-storage
visual-review plugin list
```

プラグイン管理画面への「設定」メニューは左上に既定表示します。明示的に非表示へ切り替える場合だけworkspace設定へ`false`を指定します。UI内にこの表示切替はありません。

```json
// .vreview/settings.json
{
  "ui": { "plugin_management": false }
}
```

有効/無効、manifestで宣言した必要情報、README、外部AIコマンド登録は左上の設定画面へ集約されます。workspace値はGit管理外の`.vreview/plugin-settings.json`へ保存し、token/passwordは保存せず環境変数項目として存在だけを表示します。

`/settings/plugins`からもnpm specやGitHubリンクでpluginをinstall・removeできます。npm specはexactなversionを、GitHub specはtag/commit SHAを`#`で固定してください（未固定のGitHub specは拒否します）。install時にplugin codeは実行されず、追加直後は無効状態で始まるため、内容を確認してから有効化してください。認証情報を含むURLは拒否します。同梱pluginはUIから削除できず、無効化だけができます。

プラグインcommandは次の形式で実行します。

```bash
visual-review plugin run <plugin-id> <command> [args...]
```

このrepositoryには作成例とデバッグ用実装として次を収録しています。

- [`plugins/annotation-workflow/`](plugins/annotation-workflow/README.md): 注釈保存・再オープン後の自動実行ポリシー
- [`plugins/custom-command/`](plugins/custom-command/README.md): shellを介さないカスタムagent command管理・実行
- [`plugins/firebase-storage/`](plugins/firebase-storage/README.md): Firestore RESTを使うレビューJSONのpush/pull
- [`plugins/github-issue/`](plugins/github-issue/README.md): `gh`を使うGitHub Issue provider
- [`plugins/page-map/`](plugins/page-map/README.md): 静的HTMLの画面遷移マップ

GitHub Issue作成は自動導入された`github-issue`プラグインを使います。`gh`認証は自動化せず、対象repositoryに合う利用者で事前に認証してください。base作成方法、第三者のnpm/GitHub pluginの導入、安全性は[`plugins/README.md`](plugins/README.md)、manifestとPlugin APIの詳細は[`docs/plugins.md`](docs/plugins.md)を参照してください。

beta.7では宣言的rendererが`/`、`/settings`（レイアウト設定）、`/settings/plugins`（install済みplugin）の既定です。one-beta rollback用に`/legacy`、`/settings/legacy`、`VISUAL_REVIEW_LEGACY_UI=1`と既存HTTP/CLI・manifest schema v1–v3互換を保持しています。新規integrationはschema v4を使用してください。desktop/tablet/mobileのbrowser acceptanceとlegacy route切替をrelease gateで確認済みです。

### 画面遷移マップ

同梱`page-map`プラグインは、対象と同じ公開directory配下のHTMLを静的解析し、ページ間の遷移をグラフで俯瞰します。レビュー画面のstage切り替えmenuから「画面遷移マップ」を選ぶと表示されます。解析中は対象ページを一切開かず、ネットワークへもアクセスしません。

解析するのは公開directory配下の`.html` / `.htm`だけです。`.vue`・`.jsx`・`.tsx`・`.php`などのソースfileは読みません。

| 対象 | 対応状況 |
|---|---|
| 静的HTML（`.html` / `.htm`） | 対応 |
| ビルド後の静的HTML（framework製・複数file出力） | 対応（通常の静的HTMLとして解析） |
| SPA（1つの`index.html`＋クライアントside routing） | 非対応（HTML上に遷移先が現れないため） |
| localhostアプリを対象にした場合（`--target http://...`） | 非対応（空の結果と警告を返す） |
| Vue / React / Svelte / Angular のソースfile | 非対応（`.vue`・`.jsx`・`.tsx`を読まない） |
| vue-router / React Routerのroute定義、`<router-link to>` / `<Link to>` | 非対応 |
| Next.js / Nuxtのfile-based routing | 非対応 |
| WordPress（PHPテーマ） | 非対応（`.php`を読まない） |
| 動的に組み立てられる遷移先（変数・API応答・条件分岐） | 非対応（「解析できなかった遷移」として件数のみ表示） |

つまり現状は**出力済みの静的HTMLを対象にした機能**です。frameworkを使っていても、ビルド結果のHTMLがpage単位で公開directoryへ出力されていれば俯瞰できます。route定義やソースfileからの解析はPhase 2の予定です。

抽出する遷移の種類、上限、cacheなどの詳細は[`plugins/page-map/README.md`](plugins/page-map/README.md)を参照してください。

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
- localhostは`localhost`、`127.0.0.1`、`::1`をHTTPで許可
- private networkのIP literal（`10/8`、`100.64/10`、`172.16/12`、`192.168/16`、IPv6 ULA/link-local）をHTTPで許可
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
npm version 1.1.9 --no-git-tag-version
npm test
npm pack --dry-run
git diff --check
```
