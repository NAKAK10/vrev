# Plugin foundation

Vrevの拡張単位はnpm packageである。対応packageは`package.json`へversioned metadataを宣言し、manifestの位置をCoreへ知らせる。

```json
{
  "name": "@example/vrev-tool",
  "vrev": {
    "apiVersion": 1,
    "manifest": "./vrev.plugin.json"
  }
}
```

Coreが検出するのは対象workspaceの`dependencies`、`devDependencies`、`optionalDependencies`に列挙された**直接依存だけ**である。`node_modules`全体、推移依存、package名patternは走査せず、検出時にpackage codeをimportしない。manifestはpackage内の通常fileを指すcanonicalな`./` pathでなければならない。

従来のworkspace単位installも移行用compatibility layerとして維持する。repository内ではpluginごとに一段のdirectoryを設け、`.vrev/plugins/<id>`へ導入できる。同じIDをnpm packageとlegacy registryの両方が提供した場合はfail closedとする。`.vrev`へnpm package本体はcopyしない。

```text
plugins/
  example/
    vrev.plugin.json
    dist/index.js
```

`vrev.plugin.json`がplugin rootを示す。legacy install元directoryはこのfileを直下に持つ必要があり、親の`plugins/`をまとめてinstallするものではない。

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
      { "id": "annotation-action", "slot": "annotation-workflow.annotation.actions", "document": "./ui/action.ui.json", "order": 100 }
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
- schema v4の`server`はAPI/bridge version、module、JSON contractを宣言する。`ui`はrenderer/bridge version、Core slot（`review.header`/`review.stage`/`review.sidebar`/`settings.detail`）または他pluginのextension pointへのJSON document、任意の`browser_module`、自pluginが受け入れる`extension_points`を宣言できる（[plugin-ui-bridge.md §2.2](plugin-ui-bridge.md)）。`browser_module`は導入済みplugin内のcanonical local ES moduleだけをCore route経由で実行し、remote script・任意HTML・plugin CSSは許可しない。trusted host codeとして扱うため、未信頼pluginは導入しない。
- schema v4の`requires`/`provides`はcapability名とexact `api_version: 1`を宣言する。required capability不足は明示的にunavailableとなり、暗黙fallbackしない。
- credentialは`source: environment`で環境変数名だけを宣言するか（値をUIや`.vrev/plugin-settings.json`へ保存しない）、schema v3以降では`source: "credential"`（`type: "secret"`必須、両方セットで宣言する）でCore管理のcredential storeへ登録できる。credential fieldは`default`・`options`・`environment`を持てない。任意で`format: "text" | "json"`を指定でき（credential field以外では指定不可）、`json`はUIがmultiline textareaを表示しサーバがJSON objectとしてparseできる値だけを受理する。値は`.vrev/credentials/<plugin-id>.json`（directory mode `0700`、file mode `0600`、`.vrev/.gitignore`へ自動追記）へ保存され、UI・APIへ値そのものは返らない（登録有無・更新日時・値のsha256先頭8文字のfingerprintのみ）。設定画面は`PUT`/`DELETE` `/api/settings/plugins/:id/credentials/:key`でcredentialを登録・削除する（`key`はmanifestで宣言済みのcredential fieldでなければならない）。
- `module`はplugin rootからの`./`始まりのcanonical POSIX relative pathでなければならない。絶対path、`..`、backslashは受理しない。
- `export`を省略すると`default`をloadする。
- schemaにないfield、重複command、存在しないmoduleはinstall時に拒否する。

## Base scaffold

最小構成はCLIで生成できる。生成先はworkspace rootの`plugins/<id>/`で、schema v4 manifest（`requires`でreview capabilityを宣言）、server module（`server/index.js`）とbridge contract（`server.contract.json`）、`annotation-workflow.annotation.actions`へのUI contribution（`ui/annotation-action.ui.json`）、editor用の型re-export（`types.d.ts`）、`index.js`、`package.json`、README、Node testを含む。hello commandとUI contributionは生成直後からそのまま動作する。serverのquery/commandを増やす場合はcontractと`server/index.js`を、extension pointをhostする場合は`ui.extension_points`をそれぞれ書き換える。

```sh
vrev plugin create --help
vrev plugin create my-plugin --title "My Plugin" --summary "概要"
# または生成直後にworkspaceへinstall
vrev plugin create my-plugin --install
```

既存directoryは上書きしない。生成された`hello` commandをtest・実行してから、必要なcommand/providerへ置き換えられる。

```sh
cd plugins/my-plugin && npm test
vrev plugin run my-plugin hello world
```

## Installation and registry

first-party feature packageは次の6つだけで、public npm registryへ個別publishする。

- `@vrev/ai` — CLI選択、外部AIコマンド、共通AI実行
- `@vrev/storage-firestore` — Firestore storage provider
- `@vrev/review` — review domain
- `@vrev/annotation-workflow` — annotation job workflow
- `@vrev/page-map` — 静的画面遷移解析
- `@vrev/github-issue` — GitHub Issue draft/create

```sh
npm install --save-dev @vrev/ai@1.0.0-beta @vrev/storage-firestore@1.0.0-beta @vrev/review@1.0.0-beta @vrev/annotation-workflow@1.0.0-beta @vrev/page-map@1.0.0-beta @vrev/github-issue@1.0.0-beta
npm install --save-dev @scope/public-plugin@1.2.0
npx @vrev/cli plugin list
```

Core runtimeとplugin author向けSDKはhost infrastructureであり、この6つのfeature packageには数えない。

`vrev serve`は最寄りのGit rootをworkspaceとし、その`package.json`の直接依存をNodeのpackage resolutionで解決する。package managerが管理する実体は`node_modules`に留め、`.vrev`にはplugin設定、credential、review/runtime状態だけを保存する。package pluginの削除・version変更はnpm/pnpm/yarn側で行う。

one-beta移行期間は次のlegacy操作も維持する。

```sh
vrev plugin install ./plugins/example
vrev plugin install @scope/public-plugin@1.2.0
vrev plugin list
vrev plugin run example-storage sync --dry-run
vrev plugin remove example-storage
```

legacy installの実体は`.vrev/plugins/<plugin-id>/`、registry/lockは`.vrev/plugins.json`へ保存する。同じIDの再installは暗黙に上書きせず失敗する。global Coreだけで起動する既存workspace向けには標準packageのbundled copyを自動導入する。同じbundled source由来でmanifest一致を確認できるtrusted copyだけはatomic upgradeし、local/third-partyのsame-IDや改変済みcopyは上書きしない。

local directoryはsymlinkと通常file/directory以外を拒否してcopyする。npm specは一時directoryで`shell: false`の`npm pack <spec> --json --ignore-scripts`を実行し、archive entryを検査してから展開する。absolute path、traversal、link、特殊entry、不正manifestを拒否する。認証情報を含むURLやcredential query、control文字を含むsourceも拒否し、install実体・registry・plugin設定・AI packageの外部command設定は`.vrev/.gitignore`へ追加する。install中にplugin moduleをimportせず、manifestをdataとしてだけ検証する。registry更新には既存のfile lockとatomic JSON writeを使う。

legacy npm source installではinstall scriptやdependency installを実行しない。公開pluginはNode標準APIだけで自己完結させるか、runtime dependencyを成果物へbundleしてpackageへ含める必要がある。標準packageはrelease workflowから個別にpublic npm registryへpublishされる。

### Source kind分類

`installPlugin`へ渡すsourceは、実行前に`local`／`npm`／`git`のいずれかへ分類する（`src/plugin-source.ts`の`parsePluginSource`）。分類はfilesystemの存在確認だけで行い、networkへは一切アクセスしない。

- `local`: `./`・`../`・`/`・`~/`・Windows drive・`file:`（続く部分が`./`等の相対markerで始まる場合だけ）で始まるsource、または`path.resolve(cwd, source)`がdisk上に存在するsource。前者の形式で存在しないpathは`npm`へfallbackせずただちに拒否する。
- `git`: `git+`・`git://`・`ssh://`・`github:`・`gitlab:`・`bitbucket:`・`gist:`で始まるsource、host名がgithub.com/gitlab.com/bitbucket.orgのhttp(s) URL、またはnpmのGitHub shorthand（`owner/repo`、`/`は1つだけ、`.`や`..`の segmentは不可）。**`#<ref>`によるtag/commit SHAの固定を必須とし、未固定のgit sourceは拒否する。**
- `npm`: 上記いずれにも該当しないsource。`name@range`として解釈し、exact SemVerでないrangeは拒否せずwarningを返す（未固定npm specは許可するが警告する）。

いずれの分類でも、credentialを含むURL（userinfo、`token`/`secret`/`password`/`api-key`等のquery parameter）は拒否する。`npm`/`git` sourceは共通して`npm pack <spec> --json --ignore-scripts`で取得・展開する。

### `resolved`フィールド

installに成功したentryへは`resolved`（`{ kind, ref?, integrity?, digest, resolved_at }`）を記録する。`digest`はtarball bytes（npm/git）またはlocal treeの決定的digest（`treeDigest`: sorted `relative-posix-path\0<file sha256>\n`のsha256）。`integrity`は`npm pack --json`が返す値（npm/git限定）。`ref`はnpmのexact version、gitのcommit SHA（抽出した`package.json`の`gitHead`優先、無ければ指定`#ref`）。`resolved`は既存registryとの互換のため任意fieldであり、旧いregistry JSONは`resolved`なしのまま読み込める。

### 設定画面からのinstall/remove

`ui.plugin_management`が非表示でない workspace では、`POST /api/settings/plugins`（body: `{ "source": "..." }`）と`DELETE /api/settings/plugins/:id`をHTTP経由でも提供する。installはCLIと同じ検証・展開経路を通り、plugin codeを実行しない。既定で有効になるpluginでも、このrouteからのinstallは常に無効状態で記録する（bundled first-partyのCLI bootstrapは対象外）。bundled plugin（sourceがCLI packageの`bundled-plugins`配下を指すもの）はこのrouteから削除できない。

## Declarative UI and plugin management

1.1.9ではCore-owned declarative rendererが`/`と`/settings/plugins`の既定surfaceである。レビュー画面のshell（header・左の描画領域・右のcontent column）はCoreが所有し、pluginは`review.header`（header右側への追加）、`review.stage`（左側の描画。2つ以上あればCoreが切り替えmenuを提供）、`review.sidebar`（右側への追加）の各slotへ部品だけを提供する。公式`review` pluginはheader用のレビュー操作toolbarとstage用の対象表示を提供し、AI、workflow、page-map、Issue pluginのdocumentをslotへ合成する。headerとsidebarの表示順、表示するstage、切り替えmenuの位置（四隅、既定は右下）は`/settings`で編集し、Git管理外の`.vrev/layout-settings.json`へ保存する。Coreはdocumentとbridge actionを検証してallowlist componentだけを描画する。manifestで明示された`browser_module`がある場合はcontribution rootへmountし、rerender・disable・navigation時にcleanupする。rollback用の旧rendererは`/legacy`、`/settings/legacy`、`VREV_LEGACY_UI=1`でこのone-beta lineに限り保持する。

レビュー画面headerの「設定」は`/settings`（対象JavaScriptとレイアウト設定）へ遷移し、そこからinstall済みplugin一覧`/settings/plugins`へ移動できる。local targetのJavaScriptは既定で有効であり、この画面で無効化した値を`.vrev/settings.json`の`ui.allow_scripts`へ保存する。public targetでは常に無効で変更できない。`/settings/plugins`は既定で公開する。`.vrev/settings.json`の`ui.plugin_management`がexactly `false`のworkspaceだけ非表示にする。UIからこのvisibility自体は変更できない。管理画面はinstall済みpluginをtitle・summary・即時保存toggle・「詳細」だけのcompact listで表示する。詳細buttonは共通modalを開き、version/capability、必要情報、plugin固有設定、READMEを集約する。CLI選択と外部AIコマンド登録はAI packageの詳細だけに表示する。READMEはraw HTMLを実行せず、安全なMarkdown subsetをDOM nodeとして整形する。有効/無効toggleは設定保存buttonを要求せずworkspaceへ即時保存し、結果をtoastで通知する。`annotation-workflow`で「注釈を保存したら自動でAI修正を開始」が有効な場合、メイン画面の「AIにまとめて修正依頼」buttonは重複操作になるため非表示にする。`annotation-workflow`を無効化するとレビュー画面のAI一括修正領域とworkflow固有設定を非表示にし、新規job登録をserver側でも拒否する。AI packageを無効化すると登録データを残したままAI設定と実行を利用不能にする。workspace設定値はGit管理外の`.vrev/plugin-settings.json`へatomic保存し、disabled状態はpluginのinstall状態と分離して再起動後も維持する。

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
} from "@vrev/cli";
import type { VrevPluginManifestV1 } from "@vrev/plugin-sdk";
```

```ts
const { handler } = await loadPluginCommand("example-storage", "sync", workspaceRoot);
await handler({ workspaceRoot, pluginDirectory, args: ["--dry-run"] });

const { provider } = await loadPluginStorageProvider("example-storage", workspaceRoot);
const { provider: issues } = await loadPluginIssueProvider("github-issue", workspaceRoot);
await issues.createIssue(workspaceRoot, { title: "Title", body: "Body" });
```

command exportは`PluginCommandHandler`、すなわち`(context: PluginCommandContext) => void | Promise<void>`である。CLIの`plugin run <plugin-id> <command> [args...]`はworkspace root、install先directory、残りのargv、effective workspace configuration、宣言済みcredentialをcontext（`configuration`、`credentials`）としてhandlerへ渡す。credentialはcontext経由でのみ渡り、argv・log・commandへ渡すsubprocess引数には決して含めない。schema v1のstorage providerはlegacy互換としてobject/factoryを受理する。schema v2以降のstorage providerは`WorkspaceStorageProviderV1`（`list`、`read`、`compareAndSwap`、`delete`）を実装し、Firestoreの`updateTime`、MySQL/PostgreSQLのrow version、local digestを共通のopaque `version`へ写像する。詳細は[`storage-providers.md`](storage-providers.md)を参照する。Issue providerは`createIssue(projectRoot, draft)` methodを持つobjectをexportする。

`storage_provider.export`がfunctionをexportする場合、loaderはこれを`PluginRuntimeContextV1`（`workspaceRoot`、`pluginDirectory`、effective `configuration`、宣言済み`credentials`、`env`）付きで一度だけ呼び出し（戻り値がPromiseならawaitする）、戻り値をproviderとして使う。object exportは従来どおりそのままproviderとして使われる。これによりcredentialを要するproviderがCore設定を経由してtokenやkeyを受け取れる（`firestore`の`createWorkspaceStorageProviderFromContext`が例）。

`storage_provider`を宣言したpluginがenabledかつrequired configurationを満たしている（`effective.enabled && effective.missing.length === 0`）間、そのpluginがreviewデータの読み書き先として**authoritative**になる（`src/workspace-storage.ts`）。無効化すると、同じworkspaceで次にアクセスした瞬間からローカルfile systemへ戻る（server再起動は不要）。2つ以上のstorage providerが同時にenabledな状態は**fail closed**（明確なerrorで拒否）で、どちらか一方を無効化するまで読み書きできない。切り替え時にデータは自動コピーされない。既存データを新しいbackendへ明示的に移す場合は`POST /api/settings/plugins/:id/storage-transfer`（`direction: "local-to-plugin" | "plugin-to-local"`、`dry_run: boolean`）を使う。詳細は[`storage-providers.md`](storage-providers.md)を参照する。

v4ではCLI選択・外部AIコマンド登録・AI method実行を`ai`、Firestore I/Oを`firestore`、review保存・validation・status遷移を`review`、job enqueue/recovery/coordinator policyを`annotation-workflow`、静的画面遷移解析を`page-map`、Issue draft/作成を`github-issue`が所有する。annotation-workflowとgithub-issueは用途に必要なmodeを`ai/v1`へ指定するだけで、AIを選ばせるUIや特定CLIへの依存を持たない。外部AIコマンドはAI packageが隔離directoryでcapability testを先に実行し、成功した方法だけをatomicに保存する。plugin間でcommand templateを共有せず、Coreはplugin lifecycle、capability routing、target security、declarative renderer、bridge transport、汎用process supervisorを所有する。

loaderはregistryとinstalled manifestの一致、moduleがplugin directory内の通常fileであること、exportの存在とcommand exportがfunctionであることを確認する。ESMの`import()`を使うため、source treeと`dist/src`の双方で動作する。通常のmodule評価（任意codeの実行）はcommand/providerを明示利用した時だけ起き、install/list/removeでは実行しない。自動起動するfirst-party serverはinstalled manifestとmodule digestがCLI package内のbundled copyへ完全一致するtrusted copyだけを評価する。workspaceが同じIDを差し替えた場合は無断実行せず、該当機能をfail closedにする。
