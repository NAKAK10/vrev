# Plugin foundation

Visual Review のpluginはworkspace単位でinstallする。repository内では、次のようにpluginごとに一段のdirectoryを設けられる。

```text
plugins/
  example/
    visual-review.plugin.json
    dist/index.js
```

`visual-review.plugin.json`がplugin rootを示す。install元directoryはこのfileを直下に持つ必要があり、親の`plugins/`をまとめてinstallするものではない。

## Manifest schema v1

```json
{
  "schema_version": 1,
  "id": "example-storage",
  "version": "1.0.0",
  "commands": [
    { "name": "sync", "module": "./dist/command.js", "export": "run" }
  ],
  "storage_provider": {
    "module": "./dist/storage.js",
    "export": "default"
  },
  "issue_provider": {
    "module": "./dist/issues.js",
    "export": "default"
  }
}
```

- `id`は小文字英数字で始まり、小文字英数字・`.`・`_`・`-`だけを使う（最大64文字）。workspace内で一意であり、install directory名になる。
- `version`はpluginが公開するSemVer文字列である。
- `commands`、`storage_provider`、`issue_provider`は任意。command名は小文字英数字と`-`を使う。
- `module`はplugin rootからの`./`始まりのcanonical POSIX relative pathでなければならない。絶対path、`..`、backslashは受理しない。
- `export`を省略すると`default`をloadする。
- schemaにないfield、重複command、存在しないmoduleはinstall時に拒否する。

## Base scaffold

最小構成はCLIで生成できる。生成先はworkspace rootの`plugins/<id>/`で、manifest、`index.js`、`package.json`、README、Node testを含む。

```sh
visual-review plugin create my-plugin
# または生成直後にworkspaceへinstall
visual-review plugin create my-plugin --install
```

既存directoryは上書きしない。生成された`hello` commandをtest・実行してから、必要なcommand/providerへ置き換えられる。

```sh
cd plugins/my-plugin && npm test
visual-review plugin run my-plugin hello world
```

## Installation and registry

```sh
visual-review plugin install ./plugins/example
visual-review plugin install @scope/public-plugin@1.2.0
visual-review plugin list
visual-review plugin run example-storage sync --dry-run
visual-review plugin remove example-storage
```

current directoryから最寄りのGit rootをworkspaceとする（Git管理外ではcurrent directory）。実体は`.vreview/plugins/<plugin-id>/`、registry/lockは`.vreview/plugins.json`へ保存する。同じIDの再installは暗黙に上書きせず失敗するため、更新時はremoveしてからinstallする。

local directoryはsymlinkと通常file/directory以外を拒否してcopyする。npm specは一時directoryで`shell: false`の`npm pack <spec> --json --ignore-scripts`を実行し、archive entryを検査してから展開する。absolute path、traversal、link、特殊entry、不正manifestを拒否する。認証情報を含むURLやcredential query、control文字を含むsourceも拒否し、install実体・registry・custom command設定は`.vreview/.gitignore`へ追加する。install中にplugin moduleをimportせず、manifestをdataとしてだけ検証する。registry更新には既存のfile lockとatomic JSON writeを使う。

npm sourceではinstall scriptやdependency installを実行しない。公開pluginはNode標準APIだけで自己完結させるか、runtime dependencyを成果物へbundleしてpackageへ含める必要がある。3つの同梱plugin packageはrelease workflowから個別にGitHub Packagesへpublishされる。

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

command exportは`PluginCommandHandler`、すなわち`(context: PluginCommandContext) => void | Promise<void>`である。CLIの`plugin run <plugin-id> <command> [args...]`はworkspace root、install先directory、残りのargvをcontextとしてhandlerへ渡す。storage providerは将来の個別provider契約を固定しない最小基盤としてobjectまたはfactory functionをexportでき、呼び出し側は`loadPluginStorageProvider<MyProvider>()`で具体型を指定する。Issue providerは`createIssue(projectRoot, draft)` methodを持つobjectをexportする。

loaderはregistryとinstalled manifestの一致、moduleがplugin directory内の通常fileであること、exportの存在とcommand exportがfunctionであることを確認する。ESMの`import()`を使うため、source treeと`dist/src`の双方で動作する。module評価（任意codeの実行）が起きるのは`loadPluginCommand`、`loadPluginStorageProvider`または`loadPluginIssueProvider`を明示的に呼んだ時だけであり、install/list/removeでは実行しない。
