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

- plugin IDでnamespace化
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

Plugin間local stateは共有しない。Core surface context`review.selection`がstage/sidebar間のbounded interactionを仲介する。

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
| credentials | environment/credential handle only; workspaceへ保存しない | presence/status only |

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
