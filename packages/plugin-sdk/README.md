# @visual-review/plugin-sdk

Visual Review package API v1、Plugin Host bridge、server lifecycle、versioned capability、`ai/v1`、AI integration provider、workspace storage providerのTypeScript contractを提供します。

runtime helperは定数だけで、Coreやfeature packageへ依存しません。

```ts
import {
  AI_CAPABILITY_ID,
  AI_INTEGRATION_REGISTRY_CAPABILITY_ID,
  type AiCapabilityV1,
  type AiIntegrationProviderV1,
  type PluginServerProviderV1,
  type RunnerProviderV1,
} from "@visual-review/plugin-sdk";
```

Visual Review対応npm packageは、自身の`package.json`へ次を宣言します。

```json
{
  "visualReview": {
    "apiVersion": 1,
    "manifest": "./visual-review.plugin.json"
  }
}
```

Coreは対象workspaceの`dependencies`、`devDependencies`、`optionalDependencies`にある直接依存だけを解決します。`node_modules`全体や推移依存は走査せず、検出時にpackage codeも評価しません。
