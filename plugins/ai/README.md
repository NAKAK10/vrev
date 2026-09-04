# @visual-review/ai

Visual ReviewのAI連携を`ai/v1` capabilityとして提供する、6つのfirst-party feature packageの1つです。

このpackageが次を一括して所有します。

- Claude、Codex、OpenCode、GitHub Copilot、Piなど、利用するCLI候補の提示と選択
- 外部AIコマンドの登録、隔離directoryでのcapability test、再テスト、削除
- CLI・外部コマンド・API／SDK／remote連携の共通AI methodへの変換
- AI methodの列挙、mode判定、timeout、cancel、出力上限
- CLI選択と外部AIコマンドを管理する設定UI

外部AIコマンドはshellを介さず実行し、`{prompt}`を正確に1回含むtemplateだけを受け付けます。capability testに成功したcommandだけをverified methodとして保存・公開します。raw executable、argv、environment、templateはfeature packageや通常のbrowser actionへ渡しません。

`ai/v1`の利用側は、用途に必要なmode、prompt、timeout、出力上限を指定して`invoke()`します。どのAI methodを使うかはAI packageのworkspace設定が解決するため、annotation-workflowやgithub-issueなどのfeature packageは利用者へAIの選択を求めず、特定CLIや外部コマンドにも依存しません。

processを起動しない連携は`AiIntegrationProviderV1`として`ai.integration-registry/v1`へ登録できます。registryはprovider-local IDを`<provider-id>:<method-id>`へnamespace化します。providerは対応modeと`api` / `sdk` / `remote`などの種別を宣言し、AbortSignal付きのinvocationを返します。

`text-only` modeはtool、MCP、project設定、workspace変更を無効化できる方法だけを公開します。通常のAI修正は`workspace-write` modeを利用します。

このpackageのbridgeは汎用prompt実行APIをbrowserへ公開しません。AI呼び出しは、注釈ワークフローやGitHub Issueなど、用途と権限を定義したserver packageからだけ行います。

```sh
npm install --save-dev @visual-review/ai
```
