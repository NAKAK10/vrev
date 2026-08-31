# Plugin foundation

Visual Review のpluginはworkspace単位でinstallする。repository内では、次のようにpluginごとに一段のdirectoryを設けられる。

```text
plugins/
  example/
    visual-review.plugin.json
    dist/index.js
```

`visual-review.plugin.json`がplugin rootを示す。install元directoryはこのfileを直下に持つ必要があり、親の`plugins/`をまとめてinstallするものではない。

## Manifest schema

schema v4が新規pluginの既定contractである。v3のdisplay/configurationに加え、versioned server contract、Core renderer用の宣言的UI contribution、capability dependencyを宣言する。schema v1はcommands・legacy provider、schema v2はversion付きprovider、schema v3はdisplay/configurationを提供し、beta.7のone-beta compatibility lineでは引き続き受理する。

```json
{
  "schema_version": 4,
  "id": "example-review-tool",
  "version": "1.0.0",
  "display": {
    "title": "Example review tool",
    "summary": "レビュー操作を安全に拡張します。",
    "readme": "./README.md"
  },
  "configuration": [],
  "server": {
    "api_version": 1,
    "bridge_api_version": 1,
    "module": "./server/index.js",
    "contract": "./server.contract.json"
  },
  "ui": {
    "renderer_api_version": 1,
    "bridge_api_version": 1,
    "contributions": [
      { "id": "annotation-action", "slot": "review.annotation.actions", "document": "./ui/action.ui.json", "order": 100 }
    ]
  },
  "requires": [
    { "capability": "review", "api_version": 1, "optional": false }
  ],
  "provides": [
    { "capability": "example-review-tool", "api_version": 1 }
  ]
}
```

- `id`は小文字英数字で始まり、小文字英数字・`.`・`_`・`-`だけを使う（最大64文字）。workspace内で一意であり、install directory名になる。
- `version`はpluginが公開するSemVer文字列である。
- `commands`、`storage_provider`、`issue_provider`、`annotation_flow_provider`は任意。command名は小文字英数字と`-`を使う。
- schema v2–v4の`storage_provider`と`annotation_flow_provider`は`api_version: 1`が必須。schema v1–v3の既存manifest/provider APIはone-beta互換のため引き続き受理する。
- schema v3/v4の`display`はtitle、短いsummary、安全なREADME相対pathを宣言する。`configuration`はCoreが描画するstring/integer/boolean/selectだけを使い、任意HTMLは指定できない。
- schema v4の`server`はAPI/bridge version、module、JSON contractを宣言する。`ui`はrenderer/bridge version、allowlist slotへのJSON document、任意の`browser_module`を宣言できる。`browser_module`は導入済みplugin内のcanonical local ES moduleだけをCore route経由で実行し、remote script・任意HTML・plugin CSSは許可しない。trusted host codeとして扱うため、未信頼pluginは導入しない。
- schema v4の`requires`/`provides`はcapability名とexact `api_version: 1`を宣言する。required capability不足は明示的にunavailableとなり、暗黙fallbackしない。
- credentialは`source: environment`で環境変数名だけを宣言する。値をUIや`.vreview/plugin-settings.json`へ保存しない。
- `module`はplugin rootからの`./`始まりのcanonical POSIX relative pathでなければならない。絶対path、`..`、backslashは受理しない。
- `export`を省略すると`default`をloadする。
- schemaにないfield、重複command、存在しないmoduleはinstall時に拒否する。

## Base scaffold

最小構成はCLIで生成できる。生成先はworkspace rootの`plugins/<id>/`で、schema v3互換manifest、`index.js`、`package.json`、README、Node testを含む。command/providerだけならそのまま利用できる。server capabilityまたは宣言的UIを追加する場合はmanifestをschema v4へ更新し、server contract/UI documentを追加する。

```sh
visual-review plugin create --help
visual-review plugin create my-plugin --title "My Plugin" --summary "概要"
# または生成直後にworkspaceへinstall
visual-review plugin create my-plugin --install
```

既存directoryは上書きしない。生成された`hello` commandをtest・実行してから、必要なcommand/providerへ置き換えられる。

```sh
cd plugins/my-plugin && npm test
visual-review plugin run my-plugin hello world
```

## Installation and registry

`visual-review serve`は、公式`review` 1.1.0、`github-issue` 1.1.0、`custom-command` 1.1.0、`annotation-workflow` 1.1.0がworkspaceに存在しない場合、CLI package内へ同梱したコピーから自動installする。networkやnpm認証には依存せず、`.vreview/plugins/`がGit管理外の新環境でも初回起動時に復元できる。同じbundled sourceから導入され、registry manifestとinstall先manifestが一致してprovenanceを確認できるtrusted copyだけは、同梱版のschemaまたはSemVerが新しい場合にserver/UIをまとめてatomic upgradeする。local sourceや第三者によるsame-ID plugin、manifestが改変されたcopyは上書きしない。その他の更新は引き続き明示操作とする。

```sh
visual-review plugin install ./plugins/example
visual-review plugin install @scope/public-plugin@1.2.0
visual-review plugin list
visual-review plugin run example-storage sync --dry-run
visual-review plugin remove example-storage
```

current directoryから最寄りのGit rootをworkspaceとする（Git管理外ではcurrent directory）。実体は`.vreview/plugins/<plugin-id>/`、registry/lockは`.vreview/plugins.json`へ保存する。同じIDの再installは暗黙に上書きせず失敗するため、更新時はremoveしてからinstallする。

local directoryはsymlinkと通常file/directory以外を拒否してcopyする。npm specは一時directoryで`shell: false`の`npm pack <spec> --json --ignore-scripts`を実行し、archive entryを検査してから展開する。absolute path、traversal、link、特殊entry、不正manifestを拒否する。認証情報を含むURLやcredential query、control文字を含むsourceも拒否し、install実体・registry・plugin設定・custom command設定は`.vreview/.gitignore`へ追加する。install中にplugin moduleをimportせず、manifestをdataとしてだけ検証する。registry更新には既存のfile lockとatomic JSON writeを使う。

npm sourceではinstall scriptやdependency installを実行しない。公開pluginはNode標準APIだけで自己完結させるか、runtime dependencyを成果物へbundleしてpackageへ含める必要がある。同梱plugin packageはrelease workflowから個別にGitHub Packagesへpublishされる。

## Declarative UI and plugin management

1.1.0ではCore-owned declarative rendererが`/`と`/settings/plugins`の既定surfaceである。公式`review` pluginが既定のreview main contributionを提供し、workflow/custom-command/Issue pluginのdocumentをslotへ合成する。Coreはdocumentとbridge actionを検証してallowlist componentだけを描画する。manifestで明示された`browser_module`がある場合はcontribution rootへmountし、rerender・disable・navigation時にcleanupする。rollback用の旧rendererは`/legacy`、`/settings/legacy`、`VISUAL_REVIEW_LEGACY_UI=1`でこのone-beta lineに限り保持する。

`.vreview/settings.json`の`ui.plugin_management`がexactly `true`のworkspaceだけ、レビュー画面左上と`/settings/plugins`を公開する。UIからこのvisibility自体は変更できない。管理画面はinstall済みpluginをtitle・summary・即時保存toggle・「詳細」だけのcompact listで表示する。詳細buttonは共通modalを開き、version/capability、必要情報、plugin固有設定、外部AIコマンド登録、READMEを集約する。READMEはraw HTMLを実行せず、安全なMarkdown subsetをDOM nodeとして整形する。有効/無効toggleは設定保存buttonを要求せずworkspaceへ即時保存し、結果をtoastで通知する。`annotation-workflow`を無効化するとレビュー画面のAI一括修正領域とworkflow固有設定を非表示にし、新規job登録をserver側でも拒否する。`custom-command`を無効化すると登録データを残したまま設定UIとrunner候補から除外し、選択中のcustom runnerはClaude（利用不能なら先頭のbuilt-in）へfallbackする。workspace設定値はGit管理外の`.vreview/plugin-settings.json`へatomic保存し、disabled状態はpluginのinstall状態と分離して再起動後も維持する。

## Runtime API

package rootから次をimportできる。

```ts
import {
  loadPluginCommand,
  loadPluginIssueProvider,
  loadPluginStorageProvider,
  type PluginCommandContext,
  type PluginCommandHandler,
  type PluginIssueProvider,
  type PluginStorageProvider,
  type VisualReviewPluginManifest,
} from "@nakak10/visual-review";
```

```ts
const { handler } = await loadPluginCommand("example-storage", "sync", workspaceRoot);
await handler({ workspaceRoot, pluginDirectory, args: ["--dry-run"] });

const { provider } = await loadPluginStorageProvider("example-storage", workspaceRoot);
const { provider: issues } = await loadPluginIssueProvider("github-issue", workspaceRoot);
await issues.createIssue(workspaceRoot, { title: "Title", body: "Body" });
```

command exportは`PluginCommandHandler`、すなわち`(context: PluginCommandContext) => void | Promise<void>`である。CLIの`plugin run <plugin-id> <command> [args...]`はworkspace root、install先directory、残りのargvをcontextとしてhandlerへ渡す。schema v1のstorage providerはlegacy互換としてobject/factoryを受理する。schema v2以降のstorage providerは`WorkspaceStorageProviderV1`（`list`、`read`、`compareAndSwap`、`delete`）を実装し、Firestoreの`updateTime`、MySQL/PostgreSQLのrow version、local digestを共通のopaque `version`へ写像する。詳細は[`storage-providers.md`](storage-providers.md)を参照する。Issue providerは`createIssue(projectRoot, draft)` methodを持つobjectをexportする。

v4ではreview保存・validation・status遷移を`review`、job enqueue/recovery/coordinator policyを`annotation-workflow`、verified runner registryを`custom-command`、Issue draft/作成を`github-issue`が所有する。`custom-command`は`runner-registry/v1`を提供し、`annotation-workflow`はこれをoptional dependencyとして受け付ける。外部AIコマンドは登録要求時に隔離directoryでcapability testを先に実行し、成功したrunnerだけをatomicに保存して設定候補へ合成する。テスト失敗時はrunnerを登録しない。enqueue時はopaque runner IDを同じcapabilityで実行specへ解決するため、plugin間でcommand templateを共有しない。Coreはplugin lifecycle、capability routing、target security、declarative renderer、bridge transport、process supervisorを所有し、domain validationをcompatibility adapterへ複製しない。

loaderはregistryとinstalled manifestの一致、moduleがplugin directory内の通常fileであること、exportの存在とcommand exportがfunctionであることを確認する。ESMの`import()`を使うため、source treeと`dist/src`の双方で動作する。通常のmodule評価（任意codeの実行）はcommand/providerを明示利用した時だけ起き、install/list/removeでは実行しない。自動起動するfirst-party serverはinstalled manifestとmodule digestがCLI package内のbundled copyへ完全一致するtrusted copyだけを評価する。workspaceが同じIDを差し替えた場合は無断実行せず、該当機能をfail closedにする。
