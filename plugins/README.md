# Vrev plugins

このdirectoryには、Vrevのfirst-party feature packageをプラグインごとに一段ネストして収録しています。対象は **AI、Firestore、review、annotation-workflow、page-map、github-issueの6つ**です。beta.7の既定はschema v4 Plugin HostとCore-owned declarative rendererで、各packageはserver contract、capability、検証済みJSON UI contributionを分担します。browserで任意HTMLは実行しません。

```text
plugins/
├── ai/
├── firestore/
├── review/
├── annotation-workflow/
├── page-map/
└── github-issue/
```

`ai` packageがCLI選択と外部AIコマンドの登録・検証・実行を所有します。annotation-workflow、github-issueなどのfeature packageは`ai/v1`だけを利用し、独自のAI選択UIを持ちません。

## 新しいプラグインのbaseを作る

scaffold commandで、manifest、ESM command、package、README、testを含む最小構成を`plugins/<id>/`へ生成できます。

```sh
vrev plugin create my-plugin
cd plugins/my-plugin
npm test
cd ../..
vrev plugin install ./plugins/my-plugin
vrev plugin run my-plugin hello world
```

作成とworkspaceへのinstallを一度に行う場合:

```sh
vrev plugin create my-plugin --install
```

生成後は`vrev.plugin.json`へcommandやproviderを追加し、`index.js`を実装します。scaffoldはcommand/provider向けのschema v3互換baseです。server capabilityや宣言的UIを提供する場合はschema v4へ更新し、`server`/`ui`/`requires`/`provides`を宣言してください。既存directoryを上書きせず、不正なplugin IDやsymlinkされた`plugins/` directoryは拒否します。

## 第三者が公開したプラグインをinstallする

Vrev対応packageを対象workspaceの直接依存として追加する方法が標準です。Coreは`package.json`の`vrev.apiVersion`とmanifest pathを検証して検出し、package codeはこの段階で評価しません。

### npm registryから

公開npm packageはversionを固定してinstallすることを推奨します。

```sh
npm install --save-dev vrev-plugin-example@1.2.3
npm install --save-dev @community/vrev-plugin-example@1.2.3
```

package本体はpackage managerが`node_modules`で管理し、`.vrev`へcopyしません。検出対象は`dependencies`、`devDependencies`、`optionalDependencies`の直接依存だけで、推移依存や`node_modules`全体は走査しません。

従来の`vrev plugin install <npm-spec>`はone-beta compatibilityとして残ります。

GitHub Packagesなどscopeごとにregistryが異なる場合は、通常のnpm設定を使用します。tokenをinstall URLへ埋め込まないでください。

```ini
# ~/.npmrc または対象workspaceの .npmrc
@community:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
export NODE_AUTH_TOKEN='YOUR_READ_PACKAGES_TOKEN'
vrev plugin install @community/vrev-plugin-example@1.2.3
```

### GitHub repositoryから

pluginがrepository rootにある場合は、npmが解決できるGitHub specを使用できます。tagまたはcommit SHAを固定してください。

```sh
vrev plugin install github:owner/vrev-plugin-example#v1.2.3
vrev plugin install git+https://github.com/owner/vrev-plugin-example.git#COMMIT_SHA
```

pluginが公開repositoryの`plugins/example/`のようなサブdirectoryにある場合は、repositoryをcloneして、その一段下のplugin directoryを指定します。

```sh
git clone https://github.com/owner/vrev-plugins.git
vrev plugin install ./vrev-plugins/plugins/example
```

install元の直下には`vrev.plugin.json`が必要です。repository全体や親の`plugins/` directoryをまとめてinstallすることはできません。

## 設定画面からinstallする

CLIを開かず、ブラウザの`/settings/plugins`からもnpm spec・GitHub link・localパスでpluginをinstall・removeできます。「プラグインを追加」欄へsourceを入力して「インストール」を押すだけです。npm specはexact versionを、GitHub specはtag/commit SHAを`#`で固定してください（未固定のGitHub specはCLIと同様に拒否します）。install時にplugin codeは実行されず、追加直後は無効状態で始まるため、内容を確認してから有効化してください。各プラグイン行の「削除」からremoveできますが、同梱pluginには表示されません（無効化のみ可能です）。

installに成功したプラグインのsource種別と解決情報（npmのversion、GitHubのref、local treeのdigest）は、`plugin list`の出力および設定画面の各行に`npm · 1.2.3 · sha256 …`のような形式で表示されます。

## 確認・実行・削除

```sh
vrev plugin list
vrev plugin run <plugin-id> <command> [args...]
vrev plugin remove <plugin-id>
```

手動導入した同じplugin IDは自動で上書きされません。更新するときは既存pluginを削除してから、新しいversionをinstallします。例外はCLI packageから自動導入されたfirst-party bundled copyだけです。registry manifestとinstall先manifestが一致してprovenanceを確認でき、同梱schemaまたはSemVerが新しい場合に限りatomic upgradeします。local/third-partyのsame-IDや改変済みcopyは上書きも自動実行もしません。

```sh
vrev plugin remove example
vrev plugin install @community/vrev-plugin-example@1.3.0
```

## 第三者プラグインの安全性

plugin install時はmanifestとfileを検証・copyするだけで、plugin moduleは実行しません。ただし、`plugin run`を実行したときや、storage/Issue providerが利用されたときは、そのpluginのJavaScriptがVrevと同じユーザー権限で動作します。

install前に次を確認してください。

- 公開元、license、source code、release tagまたはcommit SHA
- `vrev.plugin.json`で宣言されているmoduleと権限相当の処理
- network送信先、file操作範囲、利用する環境変数
- packageが依存物をbundle済み、またはNode.js標準APIだけで自己完結していること

credential付きURLやcredential queryを含むsourceは拒否されます。API keyやtokenはplugin設定・command引数へ保存せず、環境変数または各サービスの標準認証機構を使用してください。

manifestとPlugin APIの仕様は[`../docs/plugins.md`](../docs/plugins.md)を参照してください。
