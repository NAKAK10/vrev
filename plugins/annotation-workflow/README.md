# Visual Review annotation-workflow plugin

注釈の保存・再オープン後にAI自動実行を予約する既定ポリシーです。`visual-review serve`がworkspaceへ自動導入します。

このpluginはイベント種別、debounce時間、設定UIの宣言（最大並列範囲・自動実行toggle）に加え、job queue、checkpoint/recovery、coordinator promptを所有します。注釈の読み書きは`ReviewCapabilityV1`、AI実行は`ai/v1`を利用します。CLIの選択、外部AIコマンドの登録・解決、process実行はすべて`@visual-review/ai`が所有します。このpluginは用途として`workspace-write` modeを要求するだけで、利用者にAIを選ばせず、CLIやcommand templateを扱いません。pluginを無効化するとjob APIは利用できなくなりますが、review APIと保存済みreview dataは維持されます。Coreは安全な既定controlだけを描画し、任意HTMLは受け取りません。

```json
{
  "events": ["annotation-created", "annotation-reopened"],
  "debounceMs": 300,
  "settings": {
    "maxParallel": { "label": "最大並列数", "min": 1, "max": 10, "defaultValue": 2 },
    "autoRun": { "label": "注釈を保存したら自動でAI修正を開始" }
  }
}
```
