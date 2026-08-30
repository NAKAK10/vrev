# visual-review custom-command plugin

`visual-review.plugin.json` の `commands` から読み込まれる、自己完結したESMプラグインです。名前付きコマンドテンプレートをworkspaceの `.vreview/custom-commands.json` で管理します。

## Install

リポジトリルートで実行します。

```sh
# 公開package
visual-review plugin install @nakak10/visual-review-plugin-custom-command

# source checkout
visual-review plugin install ./plugins/custom-command
```

Node.js 20以上が必要です。このディレクトリだけを `npm pack` / `npm publish` でき、visual-review本体のsourceには依存しません。

## Usage

manifestが公開するcommand名は `custom-command` です。Visual Review CLIから次のように実行します。

```sh
visual-review plugin run custom-command custom-command add reviewer 'agent-cli --prompt {prompt}'
visual-review plugin run custom-command custom-command list
visual-review plugin run custom-command custom-command test reviewer
visual-review plugin run custom-command custom-command run reviewer 'この画面の指摘を修正してください'
visual-review plugin run custom-command custom-command remove reviewer
```

Runtime APIから直接呼ぶ場合の例です。

```js
import { loadPluginCommand } from "@nakak10/visual-review";

const workspaceRoot = process.cwd();
const { handler } = await loadPluginCommand("custom-command", "custom-command", workspaceRoot);
await handler({
  workspaceRoot,
  pluginDirectory: ".vreview/plugins/custom-command",
  args: ["add", "reviewer", "agent-cli --prompt {prompt}"],
});
await handler({
  workspaceRoot,
  pluginDirectory: ".vreview/plugins/custom-command",
  args: ["run", "reviewer", "この画面の指摘を修正してください"],
});
```

## Template rules and safety

- `{prompt}` はテンプレートに正確に1回必要です。実行ファイル名ではなく引数に置きます。
- テンプレートは引用符とbackslashを引数分割のためだけに解釈します。shellへは渡さず、常に `spawn(command, args, { shell: false })` で実行します。そのためpipe、redirect、`&&`、command substitutionはshell構文として動作しません。
- 実行は既定10分、出力1 MiBで停止します。`test` は45秒、64 KiBです。timeout、出力超過、SIGINT/SIGTERMではprocess treeを終了します。
- `test` は隔離した一時ディレクトリで、agentがtoolを使って指定ファイルを作れることを確認します。
- 設定更新はlockと同一ディレクトリ内のatomic renameを使い、symlinkの設定ファイルや `.vreview` ディレクトリを拒否します。

API key、token、password、secretはテンプレートや設定ファイルへ保存しないでください。credential用optionは登録時に拒否されます。実行processは親processの環境変数を継承するため、各CLIの認証設定または環境変数を利用します。

```sh
export AGENT_API_KEY='...'
# テンプレートにはkeyを書かない
visual-review plugin run custom-command custom-command add reviewer 'agent-cli --prompt {prompt}'
```

## Development

```sh
cd plugins/custom-command
npm test
npm pack --dry-run
```
