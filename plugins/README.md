# Visual Review plugins

このdirectoryには、Visual Reviewプラグインの実装例をプラグインごとに一段ネストして収録しています。beta.7の既定はschema v4 Plugin HostとCore-owned declarative rendererで、first-party pluginはserver contract、capability、検証済みJSON UI contributionを分担します。browserでplugin JavaScriptや任意HTMLは実行しません。

```text
plugins/
├── annotation-workflow/
├── custom-command/
├── firebase-storage/
├── github-issue/
└── review/
```

## 新しいプラグインのbaseを作る

scaffold commandで、manifest、ESM command、package、README、testを含む最小構成を`plugins/<id>/`へ生成できます。

```sh
visual-review plugin create my-plugin
cd plugins/my-plugin
npm test
cd ../..
visual-review plugin install ./plugins/my-plugin
visual-review plugin run my-plugin hello world
```

作成とworkspaceへのinstallを一度に行う場合:

```sh
visual-review plugin create my-plugin --install
```

生成後は`visual-review.plugin.json`へcommandやproviderを追加し、`index.js`を実装します。scaffoldはcommand/provider向けのschema v3互換baseです。server capabilityや宣言的UIを提供する場合はschema v4へ更新し、`server`/`ui`/`requires`/`provides`を宣言してください。既存directoryを上書きせず、不正なplugin IDやsymlinkされた`plugins/` directoryは拒否します。

## 第三者が公開したプラグインをinstallする

Visual Reviewは、ローカルdirectoryだけでなく、`npm pack`で取得できる公開package specをinstallできます。対象workspaceのGit rootで実行してください。

### npm registryから

公開npm packageはversionを固定してinstallすることを推奨します。

```sh
visual-review plugin install visual-review-plugin-example@1.2.3
visual-review plugin install @community/visual-review-plugin-example@1.2.3
```

GitHub Packagesなどscopeごとにregistryが異なる場合は、通常のnpm設定を使用します。tokenをinstall URLへ埋め込まないでください。

```ini
# ~/.npmrc または対象workspaceの .npmrc
@community:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
export NODE_AUTH_TOKEN='YOUR_READ_PACKAGES_TOKEN'
visual-review plugin install @community/visual-review-plugin-example@1.2.3
```

### GitHub repositoryから

pluginがrepository rootにある場合は、npmが解決できるGitHub specを使用できます。tagまたはcommit SHAを固定してください。

```sh
visual-review plugin install github:owner/visual-review-plugin-example#v1.2.3
visual-review plugin install git+https://github.com/owner/visual-review-plugin-example.git#COMMIT_SHA
```

pluginが公開repositoryの`plugins/example/`のようなサブdirectoryにある場合は、repositoryをcloneして、その一段下のplugin directoryを指定します。

```sh
git clone https://github.com/owner/visual-review-plugins.git
visual-review plugin install ./visual-review-plugins/plugins/example
```

install元の直下には`visual-review.plugin.json`が必要です。repository全体や親の`plugins/` directoryをまとめてinstallすることはできません。

## 確認・実行・削除

```sh
visual-review plugin list
visual-review plugin run <plugin-id> <command> [args...]
visual-review plugin remove <plugin-id>
```

手動導入した同じplugin IDは自動で上書きされません。更新するときは既存pluginを削除してから、新しいversionをinstallします。例外はCLI packageから自動導入されたfirst-party bundled copyだけです。registry manifestとinstall先manifestが一致してprovenanceを確認でき、同梱schemaまたはSemVerが新しい場合に限りatomic upgradeします。local/third-partyのsame-IDや改変済みcopyは上書きも自動実行もしません。

```sh
visual-review plugin remove example
visual-review plugin install @community/visual-review-plugin-example@1.3.0
```

## 第三者プラグインの安全性

plugin install時はmanifestとfileを検証・copyするだけで、plugin moduleは実行しません。ただし、`plugin run`を実行したときや、storage/Issue providerが利用されたときは、そのpluginのJavaScriptがVisual Reviewと同じユーザー権限で動作します。

install前に次を確認してください。

- 公開元、license、source code、release tagまたはcommit SHA
- `visual-review.plugin.json`で宣言されているmoduleと権限相当の処理
- network送信先、file操作範囲、利用する環境変数
- packageが依存物をbundle済み、またはNode.js標準APIだけで自己完結していること

credential付きURLやcredential queryを含むsourceは拒否されます。API keyやtokenはplugin設定・command引数へ保存せず、環境変数または各サービスの標準認証機構を使用してください。

manifestとPlugin APIの仕様は[`../docs/plugins.md`](../docs/plugins.md)を参照してください。
