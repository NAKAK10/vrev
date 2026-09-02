# Declarative Plugin UI and PluginBridge v1

Status: Implemented for v4 beta  
Implementation status: Phase 7–8 complete; legacy renderer remains available for one beta line via `VISUAL_REVIEW_LEGACY_UI=1` or `/legacy`.

## 1. Principles

1. Browserはplugin JavaScriptを実行しない。
2. Plugin UIはJSON documentでcomponent tree、binding、action mappingだけを宣言する。
3. Core rendererだけがDOMを生成しevent listenerを持つ。
4. Browser validationはUX補助であり、server validationがauthoritativeである。
5. UI→ServerとServer→UIはCore PluginBridgeを通す。
6. Bridge protocolはHTTP/SSE/WebSocketに依存しない。
7. Server eventは大きなstateを直接pushせず、revisionとresource invalidationを基本とする。

## 2. UI document

```json
{
  "schema_version": 1,
  "local_state": [
    {
      "key": "viewport",
      "type": "enum",
      "values": ["desktop", "tablet", "mobile"],
      "default": "desktop",
      "persist": true
    }
  ],
  "resources": [
    {
      "id": "session",
      "query": "session.get",
      "input": {},
      "refresh": "event"
    }
  ],
  "root": {
    "type": "app-shell",
    "children": []
  }
}
```

## 2.1 Base shell, layout slots, and layout settings

レビュー画面のshell（app-shell、header、左の描画領域、右のcontent column、toast region）はCore rendererが所有する。pluginはshell全体を宣言せず、manifest `ui.contributions` のslotへ部品だけを提供する。

| Slot | 意味 | 多重度 |
|---|---|---|
| `review.header` | headerの右側へ追加表示する（toolbar等） | 複数可。Coreのlayout settingsで並び替え |
| `review.stage` | 左側の描画領域を占有する表示 | 複数宣言可。同時に表示されるのは1つで、2つ以上ある場合はCoreが切り替えmenuを描画領域に重ねて表示する |
| `review.sidebar` | 右側のcontent columnへ追加表示する | 複数可。Coreのlayout settingsで並び替え |
| `settings.detail` | 従来どおり | |
| `review.main` | 廃止。manifestはparseできるが描画されず、surfaceが`UNAVAILABLE` diagnosticを返す | |

各contributionは任意の`title`（1–80文字）を持てる。titleは設定画面の並び替えlistと描画切り替えmenuの表示名に使い、未指定時はplugin `display.title`を使う。contribution keyは`<plugin_id>/<contribution_id>`である。

### Layout settings

Coreは`.vreview/layout-settings.json`（Git管理外）に次を保存し、sha256 revisionによるCASで更新する。

```json
{
  "schema_version": 1,
  "header": { "order": ["review/review-header"] },
  "sidebar": { "order": ["annotation-workflow/review-sidebar"] },
  "stage": { "active": "review/review-stage", "switcher_position": "bottom-right" }
}
```

- `order`に列挙されたkeyは列挙順に先頭へ並び、残りはmanifest `order`、plugin ID、contribution IDの順に続く。未導入pluginのkeyは無視する。
- `stage.active`が現在のstage contributionに無い場合は先頭のstage contributionを表示する。
- `switcher_position`は`top-left | top-right | bottom-left | bottom-right`で、既定は`bottom-right`。描画領域が競合した場合の切り替えmenuの表示位置である。

Surface response（`GET /api/plugin-host/v1/surfaces/review`）の`layout`は`revision`、`header_items`、`sidebar_items`、`stage_views`、`active_stage`、`stage_switcher_position`を返し、`contributions`はslotごとの表示順で並んでいる。設定用endpointは`GET/PUT /api/settings/layout`（PUTは`{ revision, header?, sidebar?, stage? }`、conflictは409）であり、`/settings`ページがこれを編集する。`/settings/plugins`（install済みplugin）へは`/settings`から遷移する。

## 2.2 Plugin-hosted extension points（plugin間UI連携）

Core slot以外に、pluginは自分のdocument内へ他pluginの部品を受け入れる**extension point**を宣言できる。GitHub Issue pluginがreview pluginのコメント入力dialog（キャンセルの右側）へ「GitHub Issueを依頼」buttonを追加するのがこの仕組みの最初の利用例である。

### 宣言（host側 manifest）

```json
"ui": {
  "renderer_api_version": 1,
  "bridge_api_version": 1,
  "extension_points": [
    {
      "id": "review.comment-dialog.actions",
      "title": "コメント入力ダイアログの操作",
      "description": "対象を選択してコメントを入力しているとき、キャンセルの右側に追加される操作",
      "context_schema": {
        "type": "object",
        "properties": {
          "anchor": { "type": "object", "properties": {}, "additionalProperties": true }
        },
        "required": ["anchor"],
        "additionalProperties": true
      },
      "form_fields": ["comment"],
      "events": {
        "completed": { "type": "object", "properties": { "annotation_id": { "type": "string", "maxLength": 128 } }, "additionalProperties": false }
      },
      "max_contributions": 4
    }
  ],
  "contributions": []
}
```

- `id`は`<宣言plugin id>.`で始まり（`^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$`、96文字以内）、Core slot名と重複できない。
- `context_schema`はhostが`slot` nodeの`context`で渡す値の型である。bridge contractと同じbounded JSON Schema subsetを使い、extension pointだけは`"additionalProperties": true`でopaque objectを表現できる。
- `form_fields`はcontributorが`{ "form": name }` bindingで読める、hostのform field名である。
- `events`はcontributorが`slot.emit`で送れるevent名とpayload schemaである。
- `max_contributions`を超えた分は`UNAVAILABLE` diagnosticになる。

### host document

hostは自分のextension pointだけを`slot` nodeで配置できる。`slot` nodeの`on`でcontributorからのeventを受け取る。

```json
{ "type": "row", "props": { "variant": { "literal": "dialog-actions" } }, "children": [
  { "type": "button", "props": { "label": { "literal": "キャンセル" } }, "on": { "click": [{ "type": "dialog.close", "dialog": "comment-dialog" }] } },
  { "type": "slot", "props": { "name": { "literal": "review.comment-dialog.actions" }, "context": { "slot_context": "/review/selection" } },
    "on": { "completed": [{ "type": "dialog.close", "dialog": "comment-dialog" }, { "type": "resource.refresh", "resource": "session" }] } },
  { "type": "button", "props": { "label": { "literal": "注釈を保存" }, "type": { "literal": "submit" }, "variant": { "literal": "primary" } } }
] }
```

### contributor側

manifest `ui.contributions[].slot`にextension point idを指定する。documentからはhost contextを`{ "slot_context": "/path" }`、host formを`{ "form": name }`で読み、完了時は`slot.emit`でhostへ通知する。

```json
{ "type": "command.execute", "command": "issue.request",
  "input": { "anchor": { "slot_context": "/anchor" }, "comment": { "form": "comment" } },
  "on_success": [
    { "type": "slot.emit", "event": "completed", "payload": { "annotation_id": { "result": "/annotation_id" } } },
    { "type": "toast.show", "variant": "success", "message": { "literal": "GitHub Issueの作成依頼を注釈として保存しました。" } }
  ] }
```

### Coreの検証

- manifest: extension point idの形式・prefix、schema subset、event名（`^[a-z][a-z0-9-]{0,31}$`）、上限（extension point 16、events 8、form_fields 16）。
- surface load: contributionの`slot`がCore slotでも有効なpluginのextension pointでもなければ`UNAVAILABLE`。plugin documentの`slot` nodeが自pluginのextension pointを指していなければ`INVALID_DOCUMENT`。
- renderer: `context`値を`context_schema`で検証し、不一致ならslotを描画しない。`slot.emit`は宣言済みeventだけをhostの`on`へ配送し、payloadはevent schemaで検証する。

### 同梱pluginのextension point

| Extension point | Host | 用途 |
|---|---|---|
| `review.comment-dialog.actions` | review | コメント入力dialogの操作（キャンセルの右側） |
| `review.overlays` | review | レビュー対象上のoverlay |
| `annotation-workflow.annotation.actions` | annotation-workflow | 注釈cardの操作（旧`review.annotation.actions`） |

### 注釈cardの状態ラベル

annotation-workflowは注釈の`status`（未対応・AI対応中・失敗・AI対応済み・解決済み）だけを知り、Issueなどの外部taskの概念を持たない。外部taskを所有するplugin（同梱では`github-issue`）は`issue-task` capability（`WorkflowTaskCapabilityV1`）の任意method `label(annotation)`で`{ text, tone }`を返し、annotation-workflowは`annotations.list`の`status_label`/`status_tone`としてcardのbadgeへ反映する。`tone`は`pending`/`active`/`ready`/`done`/`failed`のいずれかで、`text`は32文字以内。`null`または不正な値なら既定labelへfallbackする。github-issueは「Issueラフ作成中」「AI Issueラフ作成中」「Issueラフ作成失敗」「Issueラフ確認待ち」「Issue作成済み」を返し、pluginを無効化するとcardは既定labelに戻る。Issue固有のfield（`issue_state`、`issue_url`）はextension point contextの`additionalProperties: true`経由でcontributorだけが読む。

同じcapabilityの任意method `filters()`は注釈一覧の絞り込みchipに追加する分類（`{ id, label }`、idは`^[a-z][a-z0-9-]{0,31}$`でworkflow statusと衝突不可、最大16件）を返し、`filter(annotation)`はその注釈が属する分類idを返す。分類が返された注釈はstatus chipではなくその分類chipで絞り込まれる。`annotations.list`は既定5 status + task分類を`filters`として返し、sidebarのchipは`hidden`（未checkのid集合）で絞り込む。github-issueはbadgeと同じ5つのcategoryをchipとして返す。badgeとchipを単一のcategory表から導出することで、表示labelと絞り込みchipが常に1対1で一致する。

### 型

plugin開発者は`@nakak10/visual-review`から`VisualReviewPluginManifest`、`PluginUiExtensionPointV1`、`PluginUiContributionV1`、`PluginUiDocumentV1`、`PluginUiSurfaceExtensionPointV1`、`PluginServerProviderV1`、`PluginBridgeContractV1`をimportできる。`visual-review plugin create`はschema v4のmanifest、server provider、UI contribution、`types.d.ts`を生成する。

## 3. Limits

| Item | Limit |
|---|---:|
| UI document | 512 KiB |
| Tree depth | 32 |
| Nodes | 2,000 |
| Resources | 64 |
| Local-state declarations | 128 |
| Instructions per event | 16 |
| Identifier | 64 chars |
| Action request | 32 KiB |
| Event payload | 64 KiB |
| Snapshot | 256 KiB |
| Concurrent actions | 4/plugin |
| Sustained actions | 5/sec, burst 20 |
| Replay ring | 256 events or 1 MiB |

Limit violationはinstall/UI load/requestを明示的に拒否し、truncateしない。

## 4. Component allowlist

Initial renderer components:

### Layout

- `app-shell`
- `header`
- `toolbar`
- `split-panel`
- `slot`
- `section`
- `stack`
- `row`
- `panel`
- `spacer`

### Display

- `text`
- `heading`
- `badge`
- `count`
- `status`
- `time`
- `list`
- `empty-state`
- `code`
- `safe-markdown`（v1は`settings.detail` slotに限定）

### Input

- `button`
- `link`
- `input`
- `textarea`
- `select`
- `switch`
- `form`

### Overlay/effect surface

- `dialog`
- `confirmation-dialog`
- `toast-region`

### Host primitives

- `target-stage`
- `annotation-mark-layer`
- `viewport-selector`
- `selection-mode-selector`
- `load-more`

Plugins cannot register new primitive implementation in v1.

## 5. Node schema

```ts
interface UiNodeV1 {
  id?: string;
  type: RendererComponentV1;
  props?: Record<string, UiValueV1>;
  when?: UiPredicateV1;
  repeat?: {
    source: UiBindingV1;
    key: UiBindingV1;
  };
  on?: Record<string, UiInstructionV1[]>;
  children?: UiNodeV1[];
}
```

Every component has an exact-key schema. Unknown property、duplicate ID、unsupported eventを拒否する。

## 6. Bindings

Allowed tagged sources:

```json
{ "literal": "注釈" }
{ "resource": "session", "path": "/review/annotations" }
{ "local": "/filters/statuses" }
{ "event": "/selection" }
{ "item": "/id" }
{ "form": "comment" }
```

PathはJSON Pointer subsetとする。

Forbidden:

- JavaScript expression
- template expression
- function call
- arbitrary regex
- prototype property
- computed property
- `eval`
- raw CSS selector query
- DOM reference

Business-derived stateはserver query resultとして返し、UI expressionで再実装しない。

## 7. Local state

Allowed use:

- dialog open/close
- selected list item
- viewport/mode
- filters
- reply/comment draft
- runner selection
- max parallel
- auto-run preference

Rules:

- plugin IDでnamespace化する。同じpluginのroot contribution（`review.header`と`review.stage`など）は1つのlocal state namespaceを共有し、declarationは各documentの和集合として扱う。repeat instanceは従来どおりinstanceごとに独立する
- schema versionを持つ
- scalar/enum/bounded setに加え、declarationで`max_keys`/`max_value_length`を持つbounded keyed-text mapを許可する
- repeat scopeはstable item keyに紐づけ、resource refresh/filter/paginationでもdirty value・selection・focusを保持する
- size上限必須
- credentials禁止
- server mutationのauthorityには使わない
- draft lifetime（dialog close/plugin unmount/navigation）、persist可否、success時resetをdeclarationで明示する
- resource refreshはdirty form valueを上書きせず、server value conflictをform stateとして表示する

Existing browser keysはrenderer-managed namespaceへ一度だけmigrateする。schema version不一致またはinvalid migrationはsafe defaultへ戻しserver stateには影響しない。

## 8. Instructions

Allowed:

- `local.set`
- `local.toggle`
- `dialog.open`
- `dialog.close`
- `resource.refresh`
- `command.execute`
- `target.focus`
- `target.reload`
- `navigate.internal`
- `navigate.external`
- `toast.show`

`navigate.external`はuser gesture、http/https、credentialなし、confirmation policyを必須とする。

Each instruction is a tagged exact-schema object. Example:

```json
{
  "type": "command.execute",
  "command": "annotation.reply",
  "input": {
    "annotation_id": { "item": "/id" },
    "comment": { "form": "reply" }
  },
  "expected_revision": { "resource": "session", "path": "/revision" },
  "pending": { "disable": "submit", "deduplicate": true },
  "on_success": [
    { "type": "local.set", "path": "/drafts/current", "value": { "literal": "" } },
    { "type": "resource.refresh", "resource": "session" }
  ],
  "on_error": [
    { "type": "form.apply-field-errors" },
    { "type": "toast.show", "variant": "error", "message": { "error": "/message" } }
  ],
  "on_settled": []
}
```

Query/command name、input/output schema、permission、resourceはserver moduleとは別のstatic bridge contractに宣言する。Instruction sequencingはarray order、failure時は明示したbranchだけを実行する。Command/result/error/event scopeはJSON-safe read-only bindingとしてbranch中だけ利用できる。Form controlsはexplicit two-way local/form bindingを持ち、resource stateは`idle | loading | ready | stale | error`、command stateは`idle | pending | succeeded | failed`をCoreが提供する。

Forbidden:

- arbitrary fetch
- arbitrary DOM mutation
- command line execution
- clipboard/file API
- script load
- HTML injection
- arbitrary redirect

## 8.1 Predicates, resources, and collection controls

`UiPredicateV1`はboolean literal、equality/inequality、enum membership、and/or/not、resource/local state existenceだけを許可する。arbitrary expressionやregexは許可しない。

Resource inputはliteral/local/item/slot-context bindingを参照でき、dependency変更時のpolicyを`manual | immediate | debounce`で宣言する。Filter/count/business-derived summaryは原則server queryが返す。

Additional semantic controls:

- `checkbox`
- `checkbox-group`
- `fieldset`
- `legend`
- `disclosure`
- `live-status`

Multi-selectはbounded setとして扱い、empty selection/default/reset policyをdeclarationに必須とする。

## 8.2 Target stage and shared review selection

Plugin間local stateは共有しない（同一plugin内のroot contribution間では共有する）。Core surface context`review.selection`がstage/sidebar間のbounded interactionを仲介する。

Typed intents/events:

- `selection.set { annotation_id, page_path }`
- `selection.clear {}`
- `target.focus.started/completed/failed`
- `target.selection.preview/commit/cancel`
- `target.anchor.unresolved`
- `target.context.revealed/restored`

`target-stage` exact contract:

- props: target descriptor、target kind、trust mode、viewport mode、selection mode、enabled
- events: load/error、hover、DOM selection、HTML-region selection、image-region selection、preview/commit/cancel、anchor failure
- event payload: JSON-safe anchor only; DOM node/window/event object禁止
- Core responsibility: iframe pointer capture、coordinate transform、scroll/resize observation、overlay redraw、transient context reveal/restore
- review plugin responsibility: anchor interpretation/sanitation、stale policy、persistence
- annotation-workflow responsibility: card/filter intentとselection.set

`annotation-mark-layer` receives bounded marks、selected ID、resolved/stale policy and automatically recomputes on stage load/scroll/resize/viewport change. `target.focus` has typed completion/failure and never implies a mutation.

## 9. Styling

v1 plugin UIはCore design tokenとsemantic variantだけを使用する。

```json
{
  "type": "button",
  "props": {
    "variant": { "literal": "primary" },
    "size": { "literal": "medium" }
  }
}
```

Plugin CSS fileはv1では許可しない。これによりglobal selector、`@import`、remote URL、font、overlay spoofingを回避する。

将来restricted CSSを導入する場合は、plugin root scope、property allowlist、`url()`/`@import`禁止、size limitを別versionで定義する。

Responsive policy is Core-owned. Semantic layout props include `collapse: "stack"`、`primary_order`、`empty_slot: "expand"`、toolbar overflow、dialog `mobile_presentation: "fullscreen"`。Reviewed target modes are desktop=available width、tablet=768px、mobile=390px; image target disables unsupported viewport switching. Core always enforces safe areas、visible focus、reduced motion and overlay recomputation.

## 9.1 Accessibility contract

Every component schema defines semantic role and accessible-name source; arbitrary role/ARIA overrideは禁止。

- Dialog requires title association, optional description, `initial_focus`, `return_focus`, dismiss policy, focus trap, Escape/cancel behavior.
- Form supports field/description/error association and Core-owned IME-safe Ctrl/Cmd+Enter submit.
- Async operation exposes `aria-busy` equivalent and `live-status`; duplicate announcements are suppressed.
- Disclosure/switch/selection expose pressed/expanded/current/checked semantics through component state, not raw ARIA strings.
- Target selection has keyboard alternatives, cancel action, visible focus, and screen-reader status.
- Renderer preserves focus by stable node/item key across refresh.

Acceptance includes keyboard-only、screen reader semantics、IME composition、focus return、focus-visible、reduced-motion tests.

## 10. Safe Markdown

`safe-markdown`はCore rendererの実装だけを使う。

Allowed:

- headings
- paragraphs
- ordered/unordered lists
- blockquotes
- horizontal rule
- fenced/inline code
- emphasis/strong
- credentialなしhttp/https links

Forbidden:

- raw HTML
- image
- SVG
- HTML comment
- arbitrary attribute/style/id
- `javascript:` / `data:` / `file:`
- relative external URL

DOMは`createElement`、`createTextNode`、`textContent`だけで構築する。

## 11. Transport-neutral bridge

```ts
interface PluginBridgeTransportV1 {
  sendAction(frame: ActionFrameV1): Promise<ActionResultV1>;
  query(frame: QueryFrameV1): Promise<QueryResultV1>;
  subscribe(listener: (event: BridgeEventV1) => void): () => void;
  close(): void;
}
```

Initial transport:

- UI→Server query/command: HTTP POST
- Server→UI event: SSE

Future WebSocket/long-poll/test transportは同interfaceを実装する。

## 12. Endpoints

```text
GET  /api/plugin-host/v1/surfaces/review
POST /api/plugin-host/v1/plugins/:id/queries/:name
POST /api/plugin-host/v1/plugins/:id/commands/:name
GET  /api/plugin-host/v1/plugins/:id/events?after=<seq>
```

Route pathのplugin IDがauthorityであり、bodyのplugin IDだけを信頼しない。

## 13. Command request

```json
{
  "protocol": "plugin-bridge/1",
  "request_id": "uuid",
  "idempotency_key": "uuid",
  "input": {},
  "expected_revision": "opaque-or-null",
  "client_seq": 44
}
```

Rules:

- commandは`request_id`と`idempotency_key`必須
- plugin serverがexact input schemaを検証
- Coreはcommandを自動retryしない
- idempotency key scopeは`host instance + workspace + target + principal + plugin + command`
- 同key・同payload hashはpending中single-flightし、完了後はretention内のcached resultを返す
- 同key・異なるpayloadは409 `CONFLICT`
- default retentionは24時間または10,000 records/plugin。local operation journalでrestartを跨ぐ
- external side effectはpluginがdurable operation stateを持つ場合だけexactly-once replayを主張できる。状態不明は`operation.indeterminate`として自動retryしない
- principal/workspace/target/permissionはCoreが付与
- browser bodyにactor、absolute path、credentialを許可しない

## 14. Query response

```json
{
  "ok": true,
  "plugin": { "id": "review", "version": "1.0.1" },
  "bridge_api_version": 1,
  "revision": "review:12",
  "data": {}
}
```

Plugin outputもCoreがschema、size、JSON-safe valueを検証する。

## 15. Command response

```json
{
  "ok": true,
  "revision": "review:13",
  "data": {},
  "effects": [
    {
      "type": "resource.invalidate",
      "resources": ["session", "archive"]
    }
  ]
}
```

Allowed server effects:

- `resource.invalidate`
- `operation.completed`
- validated target reload request

Toast/dialog/navigationは原則UI documentのcommand completion mappingで行う。Server effectで許可する場合もCore allowlistを通す。

## 16. Error envelope

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "comment must be nonblank",
    "retryable": false,
    "fields": {
      "/comment": "required"
    },
    "request_id": "uuid"
  },
  "revision": "review:12"
}
```

Stable codes:

- `BAD_REQUEST`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `VALIDATION_FAILED`
- `PAYLOAD_TOO_LARGE`
- `RATE_LIMITED`
- `PLUGIN_PROTOCOL_ERROR`
- `PLUGIN_UNAVAILABLE`
- `TIMEOUT`
- `RESYNC_REQUIRED`

Stack trace、absolute path、command line、environment、cookieをbrowserへ返さない。

## 17. HTTP mapping

| Error | HTTP |
|---|---:|
| BAD_REQUEST | 400 |
| FORBIDDEN | 403 |
| NOT_FOUND | 404 |
| CONFLICT | 409 |
| PAYLOAD_TOO_LARGE | 413 |
| VALIDATION_FAILED | 422 |
| RATE_LIMITED | 429 |
| PLUGIN_PROTOCOL_ERROR | 502 |
| PLUGIN_UNAVAILABLE | 503 |
| TIMEOUT | 504 |
| unexpected | 500 |

## 18. SSE events

```json
{
  "protocol": "plugin-bridge/1",
  "event_id": "host-instance:123",
  "seq": 123,
  "plugin_id": "review",
  "type": "resources.invalidated",
  "revision": "review:13",
  "resources": ["session", "archive"]
}
```

Rules:

- `seq`はstream ordering、`revision`はresource version
- duplicate `seq <= lastApplied`をdiscard
- gapは`RESYNC_REQUIRED`
- replay cursorは`<host-instance-id>:<seq>`。sequenceはhost instance内でmonotonic
- `Last-Event-ID`でreconnectし、host-instance不一致またはring範囲外なら`RESYNC_REQUIRED`
- query/command successful responseで得たrevisionより古いeventはresource version比較で無視できる
- replay不能ならfull snapshotをquery
- SSE replay ringはCoreがpluginごとに所有し、unsubscribe/disconnect時にplugin subscriptionを解放する
- EventSourceはcookieの`SameSite=Strict` host sessionを使い、URLへcapability tokenを含めない。Origin/Host/session bindingを検証する
- 15–30秒heartbeat
- event overflow時はsilent dropせずconnectionをcloseしresync
- disconnect中もserver actionは継続

## 19. Validation flow

1. Coreがroute、origin、session capability、plugin enabled stateを検証。
2. Coreがbridge envelope、size、rateを検証。
3. Coreがprincipal/contextを付与。
4. Plugin serverがinput exact schemaとbusiness ruleを検証。
5. Plugin serverがrepository lock/CAS内でmutation。
6. Write成功後だけrevision更新。
7. Command response返却。
8. Resource invalidation event発行。
9. Rendererがqueryで最新snapshot取得。

Browser `required`、`maxlength`、disabled controlはUX補助でありsecurity invariantではない。

## 19.1 Settings ownership

| Setting | Authority/persistence | UI contribution |
|---|---|---|
| plugin enabled | Core `.vreview/plugin-settings.json` revision/CAS | Core plugin list toggle |
| manifest configuration | Core `.vreview/plugin-settings.json`; secret value禁止 | selected plugin `settings.detail` |
| auto-run/max parallel/runner selection | annotation-workflow server（workspace non-secret settings） | annotation-workflow `settings.detail` |
| external runner definition/verified state | custom-command server registry | custom-command `settings.detail` |
| transient filter/viewport/drafts | Core renderer local-state namespace | owning contribution |
| credentials | environment変数（値をCoreへ渡さない）、またはCore管理のcredential store `.vreview/credentials/<plugin-id>.json`（directory mode `0700`、file mode `0600`、`.vreview/plugin-settings.json`や`.vreview/.gitignore`外へ漏らさない）; `PUT`/`DELETE /api/settings/plugins/:id/credentials/:key`で登録・削除 | selected plugin `settings.detail`内のcredential field UI（presence/updated_at/fingerprintのみ表示、値は表示・保存しない） |

Plugin detail surface receives typed host context（plugin metadata、enabled state、effective configuration、missing capability、README、revision）。Hash/deep-link initialization、modal close、opener focus restorationはCore管理。

Core publishes a reserved static `host.settings/1` bridge contract:

- `plugin-settings.get`
- `plugin-settings.update-enabled`
- `plugin-settings.update-configuration`

These operations own `.vreview/plugin-settings.json` revision/CAS and exact manifest-configuration validation. A `settings.detail` document may call them through the same renderer instruction path without a plugin server contribution; Core assigns the selected plugin ID from slot context and rejects a body-supplied override. Plugin-specific save/test/retest/delete（workflow settings、runner registry等）はeach plugin static bridge contractでpermission付きcommandとして宣言する。これによりCore persistence authorityを維持しつつCore ID-specific logicを作らない。

## 20. Permissions

Initial capability permissions:

- `review.read`
- `review.write`
- `jobs.read`
- `jobs.enqueue`
- `settings.read`
- `settings.write`
- `runner.resolve`
- `runner.manage`
- `issue.create`
- `external.open-url`

Generic `filesystem`、`shell`、`network:any` permissionは公開しない。

Permissionはhost API access controlでありNode plugin sandboxではない。

## 21. Threat model

Threats:

- malicious plugin UI document
- malicious/compromised Node plugin
- XSS via text/Markdown/link
- path traversal/symlink
- object bomb/prototype pollution
- stale mutation/replay
- event reorder/reconnect storm
- credential leakage
- reviewed target scriptからlocalhost APIへの攻撃
- arbitrary process launch
- provider SSRF

Mitigations:

- plugin browser JSはmanifest-declared local ES moduleだけをtrusted runtimeとしてmountし、cleanup lifecycleを必須にする
- exact bounded schema
- safe DOM construction
- session capability + origin check + CSRF protection
- idempotency/revision
- route-level permission
- server-side runner ID registry
- path/digest validation
- stable redacted errors
- public target script blocking
- process supervisor

Residual risk: Node server pluginはuser権限で動くtrusted code。真の隔離にはseparate process/containerが必要でありv4.0範囲外。

## 22. Protocol acceptance tests

1. UI documentにscript/HTML/style/network fieldがあると拒否。
2. UI-only loadでserver moduleをimportしない。
3. Server-only queryでUI documentを読まない。
4. Browser actor spoofを拒否。
5. Stale expected revisionで409。
6. 同じidempotency keyを1回だけ実行。
7. Event duplicateを二重適用しない。
8. Event gapでsnapshot resync。
9. Unsafe Markdown/linkをtextとして描画。
10. Disabled pluginはschema/action/eventを公開しない。
11. Raw executable/custom templateをjob actionで拒否。
12. Unverified runner IDを拒否。
13. SSE overflowをsilent dropしない。
14. Plugin errorにstack/absolute path/secretを含めない。
