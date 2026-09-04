# Plugin Host Architecture v4

Status: Accepted
Scope: Vrevを最小Core hostと独立npm packagesへ分割するarchitecture
Implementation status: npm package API v1への移行中（legacy `.vrev/plugins`はone-beta互換）

## 1. Decision summary

Vrev Coreはreview productそのものではなく、pluginを安全に導入・起動・描画・接続するhostとする。

- `review` default pluginがReviewStore、review schema、annotation validation、status transition、archive/history dataを所有する。
- first-party feature packageは`ai`、`firestore`、`review`、`annotation-workflow`、`page-map`、`github-issue`の6つだけとする。
- `annotation-workflow` default pluginが右sidebar（AI一括修正・注釈・履歴）のUI compositionとjob orchestrationを所有する。
- `@vrev/ai`がCLI選択、外部AIコマンドの登録・検証・実行、`ai/v1`、`ai.integration-registry/v1`を所有する。AIを使うfeature packageは必要modeだけを指定し、利用者へAIを選ばせない。
- `firestore`がremote storage、`page-map`が静的画面遷移解析、`github-issue`がannotation workflowとは別の選択tool、modal、sidebar、Issue作成providerを所有する。
- Core browserはmanifestで明示されたtrusted browser moduleを除きplugin JavaScriptを実行しない。plugin UIは宣言的documentとして読み込み、Core rendererがallowlist componentだけを描画する。
- validation、business rule、mutation、permission判定はserver pluginが最終責任を持つ。
- UI→Server actionとServer→UI eventの双方向通信をCore `PluginBridge`が仲介する。
- UI contributionとServer contributionは独立して検証・loadできる。

## 2. Goals

1. `src/`をreview機能の置き場所ではなく、plugin host/SDKだけにする。
2. `review-store.ts`、`job-manager.ts`、AI command test等をdomain owner pluginへ移す。
3. plugin固有のUIとserver logicを同じplugin package内で管理できるようにする。
4. plugin UIによる任意script、任意HTML、任意DOM操作、任意fetchを禁止する。
5. server-side validatorを唯一のauthoritative validationとする。
6. pluginを無効化した場合、対応するUI contributionとserver actionを同時に利用不能にする。
7. 現在のreview JSON、CLI、HTTP route、default installを段階的に互換維持する。
8. plugin間の実装importを禁止し、versioned capabilityで接続する。

## 3. Non-goals for v4.0

- Node server pluginのOS-level sandbox化
- 任意third-party pluginの自動起動
- browserでのplugin JavaScript/Web Components実行
- 任意HTML、SVG、remote image、remote fontの描画
- JavaScript式や汎用formula languageを持つlow-code platform
- WebSocket必須化
- review data schemaの同時刷新
- Firestore/MySQL/PostgreSQLを即座にauthoritative storeへ切り替えること
- active pluginのhot reload
- 複数review application pluginの同時primary surface合成

## 4. Repository target layout

```text
src/
  cli.ts
  host/
    bootstrap.ts
    http-server.ts
    router.ts
    lifecycle.ts
    plugin-bridge.ts
    process-supervisor.ts
    target-service.ts
    ui-document.ts
  plugin/
    manifest.ts
    registry.ts
    runtime.ts
    settings.ts
  renderer/
    index.html
    renderer.js
    renderer.css
  sdk/
    bridge-v1.ts
    server-v1.ts
    storage-v1.ts

plugins/
  review/
    server/
      index.ts
      review-store.ts
      review-repository.ts
      validators.ts
      migrations.ts
    ui/
      review.ui.json
    test/

  ai/
    server/
      index.ts
      cli-adapters.ts
      external-command-registry.ts
      capability-test.ts
    ui/
      settings.ui.json
    test/

  firestore/
  annotation-workflow/
    server/
      index.ts
      job-manager.ts
      job-store.ts
    ui/
      sidebar.ui.json
    test/
  page-map/

  github-issue/
    server/
      index.ts
      draft-task.ts
      issue-provider.ts
    ui/
      issue.ui.json
    test/
```

物理pathは移行中に変更してよいが、最終的にCoreからdomain implementationを除去する。

## 5. Core responsibilities

Core MUST own:

- CLI top-level dispatch
- workspace/project/target resolution
- loopback-only binding、port selection、server lease
- static target serving、localhost reverse proxy、public target security
- plugin install/remove/list/default bootstrap
- manifest exact-key validation、safe path、symlink/traversal protection
- plugin enablement/configuration persistence
- UI document validationとnormalization
- declarative rendererと共通component CSS
- PluginBridge routing、request size、rate limit、origin/session protection
- server plugin lifecycle
- generic process supervisor
  - `shell: false`
  - timeout
  - stdout limit
  - cancellation
  - process-tree termination
- generic storage provider contract
- generic plugin management UI
- typed error mapping、structured logging、secret redaction

Core MUST NOT know:

- annotation status namesやtransition table
- `review.json` / `resolved.json`のdomain semantics
- annotation/history labels
- AI coordinator prompt
- AI method名と選択policy
- GitHub Issue draft readiness
- external AI command template
- plugin IDごとのsettings panel実装

Coreはbundled catalogとしてdefault plugin IDを知ってよいが、そのdomain behaviorを条件分岐してはならない。

## 6. Plugin ownership

### 6.1 `review`

Server ownership:

- Review schema v1 migration / schema v2 persistence
- `review.json`、`resolved.json`、`context.json`
- annotation、thread、event、revision
- anchor sanitation
- source hash policy
- human/system principalごとのstatus transition
- archive pagination
- review aggregateとrepository boundary

UI ownership:

- target stageを含むmain review surface composition
- mode/viewport toolbar
- annotation dialog composition
- generic target-stage primitiveへのbinding

`review` UIはannotation list/history sidebarを直接所有しない。sidebar slotは`annotation-workflow` contributionをmountする。

### 6.2 `annotation-workflow`

Server ownership:

- annotation-created/reopened policy
- job queue、batch、checkpoint、recovery
- coordinator prompt
- durable completion reconciliation
- review capability経由のannotation/message/status mutation
- `ai/v1` capabilityの利用（`workspace-write` mode）

UI ownership:

- 右sidebar全体
  - AI一括修正
  - 注釈list/filter
  - history/archive
- workflow settings
- auto-run preference

Explicit policy: `annotation-workflow`を無効化すると右sidebar contribution全体をunmountし、review stageは全幅になる。review dataは削除せず、`review` serverとCLI/headless capabilityは残る。

### 6.3 `ai`

Server ownership:

- 利用するCLIの検出とworkspace単位の選択
- CLI adapter
- 外部AIコマンドのdefinition persistence、capability test、verified state、実行
- API/SDK/remote integration registry
- `ai/v1`によるmode別method解決、timeout、cancel、output policy

UI ownership:

- CLI選択
- 外部AIコマンド登録・再テスト・削除settings panel

Critical invariant: feature packageと通常のbrowser actionはraw executable/templateやAI選択値を受け取らない。用途に必要なmodeを`ai/v1`へ指定し、AI packageがworkspace設定からmethodを解決する。commandの検証失敗時はverified stateを失効させる。

### 6.4 `firestore` / `page-map`

`firestore`は`storage_provider`としてbackend I/Oとopaque version mappingを所有する。`page-map`は静的HTMLの遷移解析とstage contributionを所有する。

### 6.5 `github-issue`

Server ownership:

- Issue draft task codec
- draft validation
- provider invocation
- single-flight/idempotency

UI ownership:

- Issue request action
- draft edit/confirm dialog
- created Issue link/status

`review`は互換期間中`issue_*` fieldsを保存できるが、Issue-specific behaviorはcapability adapter経由とする。

## 7. Dependency DAG

```text
Core host / SDK
├── ai（CLI選択・外部AIコマンド・ai/v1）
├── firestore（StorageProvider capability）
├── review（StorageProviderを利用しReview capabilityを提供）
├── annotation-workflow（Review capability + ai/v1 workspace-write）
├── page-map（target service）
└── github-issue（Review capability + ai/v1 text-only + IssueProvider）
```

Rules:

- pluginは別pluginのimplementationをimportしてはならない。
- Core SDK typeとhost capabilityだけをimportする。
- dependencyはmanifestでcapability ID/API versionとして宣言する。
- required capabilityはpackage列挙順に依存せずmulti-passで解決し、収束後も不足するserver contributionだけをstartしない。
- optional capability不足はdependent UI/actionだけを非表示またはdisabledにする。

## 8. Manifest schema v4

```json
{
  "schema_version": 4,
  "id": "review",
  "version": "1.0.1",
  "display": {
    "title": "標準レビュー",
    "summary": "Vrevの標準レビュー機能を提供します。",
    "readme": "./README.md"
  },
  "configuration": [],
  "server": {
    "api_version": 1,
    "bridge_api_version": 1,
    "module": "./dist/server/index.js",
    "contract": "./server/bridge.contract.json",
    "export": "default"
  },
  "ui": {
    "renderer_api_version": 1,
    "bridge_api_version": 1,
    "contributions": [
      {
        "id": "main",
        "slot": "review.main",
        "document": "./ui/review.ui.json",
        "order": 100
      }
    ]
  },
  "requires": [
    { "capability": "host.target", "api_version": 1, "optional": false },
    { "capability": "host.storage", "api_version": 1, "optional": false }
  ],
  "provides": [
    { "capability": "review", "api_version": 1 }
  ]
}
```

Schema v4 retains v3 `commands`, `storage_provider`, `issue_provider`, `annotation_flow_provider`, `display`, and `configuration` during compatibility.

### 8.1 Server contribution

```ts
interface PluginServerManifestV1 {
  api_version: 1;
  bridge_api_version: 1;
  module: string;
  contract: string;
  export?: string;
}
```

- canonical `./` POSIX relative pathのみ
- plugin root外、symlink component、non-fileを拒否
- install/list/UI load時にserver moduleをimportしない
- Node server pluginはtrusted local codeでありsandboxではない

### 8.2 UI contribution

```ts
interface PluginUiManifestV1 {
  renderer_api_version: 1;
  bridge_api_version: 1;
  contributions: PluginUiContributionV1[];
}

interface PluginUiContributionV1 {
  id: string;
  slot:
    | "review.main"
    | "review.sidebar"
    | "review.header"
    | "review.stage"
    | "settings.detail"
    | string; // 他pluginのextension point id（例: annotation-workflow.annotation.actions）
  document: string;
  order: number;
}
```

- JSON documentのみ
- JavaScript/HTML/CSS module pathを持たない
- Coreがparse/validateしてbrowserへnormalized documentを返す
- browserはplugin directoryをstatic rootとして参照しない
- server/uiの片方だけを持つpluginも許可
- UIがaction/queryを宣言する場合、対応server contribution、またはallowlist済みCore host contract operationが必要
- `(plugin_id, contribution_id)`は一意、`order`同値時はplugin ID/contribution IDでdeterministic sortする
- `review.main`はcardinality 1。複数enabled contributionが競合した場合はsurfaceを起動せずmanagement diagnosticを表示する
- その他のslotはcardinality many。各contribution failureは同じslotの他contributionを停止しない
- `review.sidebar`が空ならsplit-panelはsidebarを生成せずmainを全幅にする
- `review.annotation.actions`/`review.overlays`はCore slotではなく、annotation-workflow/reviewが`ui.extension_points`でhostするplugin-owned extension pointへ移行した（[plugin-ui-bridge.md](plugin-ui-bridge.md)）
- slotへ渡すcontext schemaと使用可能capabilityはslotごとに固定し、plugin間local state共有には使わない

## 9. Independent lifecycle

UI state machine:

```text
UNDISCOVERED -> VALIDATING -> READY -> UNLOADED
                         \-> FAILED
```

Server state machine:

```text
UNDISCOVERED -> LOADING -> STARTING -> READY -> STOPPING -> STOPPED
                    \-> FAILED    \-> FAILED
```

Required behavior:

- UI document loadはserver moduleをimportしない。
- Server loadはUI documentを必要としない。
- disabled pluginはserver moduleをevaluateせず、UI contributionも公開しない。
- invalid UIでもvalid server contributionのheadless query/actionは必ず利用可能にする。
- invalid serverでもindependently validなstatic UIは描画し、server action controlsだけをdisabledにしてdiagnosticを示す。
- deliberate plugin disableはUI/server両方を停止する。
- invalid required serverはそのplugin actionを`PLUGIN_UNAVAILABLE`にする。
- default `review` server startup failureはserve自体をfail closedにする。

## 10. Server runtime API

```ts
interface PluginServerProviderV1 {
  apiVersion: 1;
  create(context: PluginServerContextV1): PluginServerInstanceV1 | Promise<PluginServerInstanceV1>;
}

interface PluginServerInstanceV1 {
  start(): void | Promise<void>;
  query(request: PluginQueryRequestV1): Promise<PluginBridgeResultV1>;
  command(request: PluginCommandRequestV1): Promise<PluginBridgeResultV1>;
  subscribe?(
    request: PluginSubscriptionRequestV1,
    emit: (event: PluginInvalidationEventV1) => void,
  ): void | (() => void) | Promise<void | (() => void)>;
  stop(reason: "shutdown" | "failure" | "reload"): void | Promise<void>;
}
```

Context exposes immutable:

- plugin ID/version/root
- workspace/project/target descriptor
- effective non-secret configuration
- environment credential presence/handles（値はUIへ返さない）
- target service
- process supervisor
- storage/review/AI/provider capability registry
- structured logger
- shutdown AbortSignal

Pluginにraw `IncomingMessage`、`ServerResponse`、Core router、DOM objectを渡さない。

## 10.1 Static bridge contract

Manifest references a JSON bridge contract that Core can validate without importing the server module:

```ts
interface PluginBridgeContractV1 {
  schema_version: 1;
  queries: Array<{
    name: string;
    permission: string;
    input_schema: JsonSchemaSubsetV1;
    output_schema: JsonSchemaSubsetV1;
    resources: string[];
  }>;
  commands: Array<{
    name: string;
    permission: string;
    input_schema: JsonSchemaSubsetV1;
    output_schema: JsonSchemaSubsetV1;
    invalidates: string[];
  }>;
}
```

`server.contract`でplugin-root相対pathを宣言する。UI documentはこのcontractに存在するpublic operationだけを参照できる。Coreのstatic validationに加えserver pluginは全入力とbusiness ruleを再検証する。JSON SchemaはCore実装のbounded subset（object/array/scalar/enum、required、additionalProperties false、length/range）のみとする。

## 10.2 Versioned cross-plugin capabilities

```ts
interface ReviewCapabilityV1 {
  query(input: ReviewQueryV1, context: CapabilityCallContextV1): Promise<ReviewSnapshotV1>;
  command(input: ReviewCommandV1, context: CapabilityCallContextV1): Promise<ReviewCommandResultV1>;
  subscribe(
    input: ReviewSubscriptionV1,
    context: CapabilityCallContextV1,
    emit: (event: ReviewInvalidationV1) => void,
  ): () => void;
}

interface AiCapabilityV1 {
  invoke(input: {
    mode: "text-only" | "workspace-write";
    prompt: string;
    timeout_ms: number;
    output_limit: number;
  }, context: CapabilityCallContextV1): Promise<AiInvocationResultV1>;
}

interface IssueTaskRegistryV1 {
  register(provider: IssueTaskProviderV1): () => void;
  request(task: IssueTaskV1, context: CapabilityCallContextV1): Promise<IssueTaskResultV1>;
}
```

Coreはinstall・remove・enable/disable・configuration/credential変更後にgeneric package hostをreconcileし、停止時はdependencyの逆順でcapabilityを解除する。Core exposes scoped handles declared in`requires`。`host.storage` always resolves to the selected workspace storage provider（defaultはexisting local provider）。`@vrev/ai`はCoreのgeneric process supervisorを利用し、CLI選択と外部AIコマンドを内包した`ai/v1`を提供する。`annotation-workflow`と`github-issue`は`ai/v1`へ用途のmodeだけを指定し、AI methodを選択しない。`github-issue`はpersisted projectionのため`review`も要求する。Capability calls carry Core-assigned principal、workspace/target scope、AbortSignal、request/idempotency metadata and preserve typed error/revision semantics. Capability implementation imports across plugins are forbidden.

Cross-plugin invalidation uses capability subscription, not plugin-private SSE coupling. `annotation-workflow` subscribes to`ReviewCapabilityV1`; review invalidation triggers its own resource invalidation event to mounted sidebar clients. Core tears down the subscription when either plugin stops. Direct review UI/CLI mutations therefore refresh annotation/history sidebar state.

## 11. Principal model

Core assigns principal; request bodyからactorを受け取らない。

- `human-ui`
- `host-cli`
- `system`
- `coordinator`

Browserが`actor: "ai"`等を含めた場合はexact-key validationで拒否する。legacy HTTP/CLI adapterはprincipalへ変換して同一server commandを呼ぶ。

## 12. Data and compatibility

Migration MUST preserve:

```text
.vrev/reviews/<target-id>/
  review.json
  resolved.json
  context.json
  job-state.json
  transaction/lock/lease files
```

- schema versionとrevision/event orderを変更しない
- corrupt dataを空fileで上書きしない
- active/resolved transaction recoveryを維持
- review directory namingを維持
- v1-v3 manifestsを受理
- 既存root exportsは1 release lineだけdeprecated façadeとして維持
- legacy HTTP routesは1 deprecation periodだけbridge adapterとして維持

## 13. Security invariants

- plugin browser JavaScriptはmanifestで明示したtrusted local `browser_module`に限定する（remote script・未宣言assetは禁止）
- raw HTML禁止
- `eval`、inline handler、arbitrary fetch、arbitrary DOM mutation禁止
- UI document exact-key validation
- server-side authoritative validation
- no raw command text in browser job request
- external URLはhttp/https、credentialなし、明示gestureのみ
- secret valuesをpayload/error/logへ含めない
- plugin server outputもschema validationする
- disabled pluginはmodule evaluateしない
- reviewed target scriptからprocess-launch actionへ直接到達できないsession capability/origin protectionを追加する
- Node plugin serverはuser権限のtrusted codeであることをUIに明記する

## 13.1 Bundled plugin trust and bootstrap

- Fresh workspaceには`ai`、`firestore`、`review`、`annotation-workflow`、`page-map`、`github-issue`の6 packageをroot package内のoffline bundleからinstallする。default enablementは各package manifestに従う。
- Bundled manifest/module/UI documentはrelease時に記録したdigestと一致する場合だけ自動startする。
- 同じbundled source由来でregistry/installed manifestが一致してprovenanceを確認できるtrusted copyだけは、新しいschemaまたはSemVerへatomic upgradeする。その他の既存same-ID pluginは上書きしない。bundled digestと不一致なら自動startせず、explicit enable/reviewを要求する。
- trusted `review`が利用不能な場合はreview serveをfail closedにし、dataを変更せずmanagement diagnosticを返す。
- optional bundled plugin failureはreview host全体を停止しない。

## 14. Acceptance scenarios

| Scenario | Expected result |
|---|---|
| Fresh workspace | 6つのfirst-party feature package（`ai`, `firestore`, `review`, `annotation-workflow`, `page-map`, `github-issue`）がoffline installされる |
| UI-only load | server module import markerが作られない |
| Server-only invocation | UI document unavailableでもheadless query/commandが動作する |
| Disabled plugin | UI contributionなし、server module未評価、actionはPLUGIN_UNAVAILABLE |
| Annotation workflow disabled | 右sidebarが消えstage全幅、review dataは保持 |
| Review disabled | review surfaceなし、Core plugin managementのみ利用可能 |
| Stale source hash | serverが422/409で拒否しrevision不変 |
| Actor spoofing | browser actor fieldを拒否 |
| Raw external AI command in feature request | browser requestを拒否 |
| AI invocation | AI packageがworkspace設定からverified methodを解決 |
| Invalid UI document | Core diagnostic surface、script実行なし |
| Existing review data | path/schema/revisionを変えず開ける |
| Direct review CLI/UI mutation | ReviewCapability subscription経由でworkflow sidebar resourceがinvalidateされる |
| Opposite policy plugin | server-only pluginはUIなしで正常動作 |
| Missing optional provider | dependent actionだけ非表示、他機能は継続 |

## 15. Decision gates and post-v4 questions

Pre-implementation gate:

1. Review aggregateをstorage provider上でsingle canonical keyにするか、versioned transaction manifestにするか。Review extractionはlocal repositoryで開始できるが、authoritative remote writeを有効化する前にADRが必要。

Resolved for v4:

- Compatibility route/root exportは1 minor/beta release line維持する。
- `annotation-workflow`がannotation/history sidebarを所有する。
- `safe-markdown`は`settings.detail`だけで許可する。

Post-v4 questions（implementation blockerではない）:

- Third-party Node server pluginをseparate processへ隔離するか。
- 将来workflow sidebar ownershipをpolicy extension化するか。
