# Visual Review annotation-workflow plugin

注釈の保存・再オープン後にAI自動実行を予約する既定ポリシーです。`visual-review serve`がworkspaceへ自動導入します。

このpluginはイベント種別、debounce時間、設定UIの宣言（runner候補・最大並列範囲・自動実行toggle）に加え、job queue、checkpoint/recovery、coordinator prompt、built-in runner adapterを所有します。注釈の読み書きは`ReviewCapabilityV1`、外部runnerの列挙・解決はoptionalな`runner-registry/v1`連携ポイント、process実行はCoreの汎用ProcessSupervisorを利用します。`runner-registry`を提供する他pluginのrunnerはAI修正設定へ自動追加され、選択値はprovider内部IDではなく`custom:<opaque runner_id>`として保存されます。外部AIコマンド側が登録前capability testに成功したrunnerだけを公開するため、注釈ワークフローの候補には実行可能なrunnerだけが表示されます。pluginを無効化するとjob APIは利用できなくなりますが、review APIと保存済みreview dataは維持されます。Coreは安全な既定controlだけを描画し、任意HTMLは受け取りません。

```json
{
  "events": ["annotation-created", "annotation-reopened"],
  "debounceMs": 300,
  "settings": {
    "runner": { "label": "CLI", "options": ["..."] },
    "maxParallel": { "label": "最大並列数", "min": 1, "max": 10, "defaultValue": 2 },
    "autoRun": { "label": "注釈を保存したら自動でAI修正を開始" }
  }
}
```
