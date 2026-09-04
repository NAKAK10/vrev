# Plugin Host v4 Migration Plan

Status: Draft for review  
Implementation status: 未着手

## 1. Migration policy

- 常にrelease可能な状態を維持する。
- 1 phaseでcontract introductionとlarge behavior moveを同時に行わない。
- 既存review dataをcopy/moveしない。
- compatibility adapterはdomain validationを重複実装せず、new plugin serverへdelegateする。
- phaseごとにrollback可能なcommit boundaryを作る。
- Coreとpluginの二重writerを作らない。
- browser plugin JavaScriptは途中phaseでも導入しない。
- implementation開始前に`plugin-host-architecture.md`と`plugin-ui-bridge.md`を承認する。

## 2. Current-to-target inventory

| Current file/area | Target owner |
|---|---|
| `src/plugin-manifest.ts` | Core plugin SDK |
| `src/plugin-registry.ts` | Core plugin host |
| `src/plugin-runtime.ts` | Core plugin host |
| `src/plugin-settings.ts` | Core plugin host |
| `src/plugin-scaffold.ts` | Core developer tooling |
| `src/server-lease.ts` | Core lifecycle |
| `src/workspace-settings.ts` | Core workspace service |
| `src/storage-provider.ts` | Core SDK contract |
| `src/file-utils.ts` | Split: generic Core primitives / local storage implementation |
| `src/http-server.ts` | Split: Core transport/security + plugin bridge adapters |
| `src/review-store.ts` | `plugins/review/server` |
| Review portions of `src/types.ts` | `plugins/review` contract |
| `src/job-manager.ts` | `plugins/annotation-workflow/server` |
| `src/job-store.ts` | `plugins/annotation-workflow/server` |
| built-in AI command builders in `src/adapters.ts` | `plugins/ai/server` |
| generic spawn supervisor in `src/adapters.ts` | Core host |
| external AI command capability test | `plugins/ai/server/capability-test` |
| raw external AI command parser/executor | `plugins/ai/server` |
| `src/github-issue.ts` | `plugins/github-issue` + deprecated façade |
| `src/ui/index.html` | Core shell + declarative plugin documents |
| `src/ui/reviewer.js` | review declarative UI + target-stage Core primitive + Issue contribution |
| `src/ui/jobs.ts` | annotation-workflow declarative UI/server state |
| `src/ui/reviewer.css` | Core renderer component CSS |
| hardcoded workflow/AI settings UI | owning packageの`settings.detail` documents |
| generic plugin list/modal/README | Core plugin management UI |

## 3. Mandatory security fix before broad extraction

Raw external AI commands outside the AI package are not an acceptable v4 bridge boundary.

Before PluginBridge is exposed generally:

1. Browserのfeature requestから`custom_command`文字列とAI選択値を削除。
2. Feature packageは用途に必要なAI modeだけを`ai/v1`へ送信。
3. `ai` serverがCLI選択とverified external-command registryを所有。
4. capability test成功とAI method resolutionをAI package内で結合。
5. `annotation-workflow`と`github-issue`は`ai/v1`だけを利用。
6. Job stateへraw command templateを保存しない。
7. script-enabled targetからprocess-launch routeへ到達できないsession capability/origin protectionを追加。

このgateが完了するまでthird-party bridge actionを有効化しない。

## 4. Phase 0 — Baseline freeze

Deliverables:

- 現在のpackage/review fixture/HTTP response/CLI behavior snapshot
- clean checkoutで`npm ci`, `npm test`, `npm pack --dry-run`
- current package contents list
- rollback tag/commit
- `docs/gotchas.md`へOS/CLI/browser未検証事項を記録

Completion criteria:

- annotation、reply、resolve/reopen、archive、jobs、GitHub Issue、plugin settingsが現行版で再現可能
- corrupt review/job fileが上書きされない
- published/packed packageからserveできる

Rollback: 現在のbeta releaseへ戻す。

## 5. Phase 1 — SDK contracts only

Add without behavior move:

- manifest schema v4 parser
- `PluginServerProviderV1`
- `PluginUiDocumentV1`
- `PluginBridge` envelopes
- capability registry types
- principal types
- process supervisor interface
- review/AI/issue capability ports

Keep all current runtime paths.

Tests:

- v1–v3 compatibility
- v4 exact-key/path/version validation
- server/UI independent marker tests
- UI size/depth/node limit
- forbidden script/HTML/CSS fields
- capability version mismatch

Completion criteria:

- existing tests unchanged green
- installing/listing/UI validation does not import server code
- server load does not parse UI document

Rollback: v4 parser/SDK exportsをremove。data changeなし。

## 6. Phase 2 — Core router and lifecycle

Add:

- generic route registry
- plugin server lifecycle state machine
- immutable `PluginServerContext`
- typed host errors
- bridge router behind feature flag
- query/command dispatch
- SSE invalidation transport or polling-compatible event adapter
- route conflict/capability enforcement

Existing HTTP routes remain direct path initially.

Tests:

- start/stop once
- startup failure cleanup and lease release
- disabled module not evaluated
- route conflict
- body/rate limits
- event reconnect/resync
- no stack/secret/path leakage

Completion criteria:

- dummy v4 plugin query/command works
- current review behavior remains old path
- bridge can be disabled as rollback switch

Rollback: feature flag OFF。

## 7. Phase 3 — AI package boundary

Move CLI selection, built-in CLI adapters, command template parsing, capability testing, verified external-command persistence, and method resolution to `plugins/ai/server`.

Provide `ai/v1` so feature packages request a mode without selecting an implementation.

Compatibility:

- existing browser localStorage commands migrate once to the AI package only after explicit re-test
- display name remains `外部AIコマンド` within AI settings

Tests:

- raw command or AI selection in a feature request is rejected
- unknown/unverified external command is rejected
- verified external command can be selected by AI package settings
- failed re-test revokes verification
- command definition never reaches another feature package or unrelated browser state
- no shell execution
- script-enabled target cannot inject executable

Completion criteria:

- annotation-workflow and github-issue invoke only `ai/v1` with a required mode
- no raw command field in bridge/job state

Rollback: AI package can disable external commands while retaining built-in CLI methods。

## 8. Phase 4 — Extract Review domain server

First extract pure layers:

1. review aggregate/reducer
2. validators/migrations
3. async ReviewRepository interface
4. local repository preserving exact file behavior
5. `ReviewCapabilityV1`

Then move `ReviewStore` implementation to`plugins/review/server`.

Compatibility:

- existing file paths/schema/revisions unchanged
- current `ReviewStore` root export becomes deprecated façade
- legacy HTTP/CLI call plugin server command/query

Tests moved/preserved:

- schema fixture compatibility
- active/resolved split
- transaction recovery
- status transitions
- source hash
- symlink/path protection
- concurrent lock
- corruption fail closed

Storage decision gate:

- authoritative remote storageへ進む前にsingle aggregate CAS keyまたはtransaction manifest方式をADR決定
- active/resolvedを独立CASしない

Completion criteria:

- `src/http-server.ts`にannotation validation/status logicがない
- `src/review-store.ts`はfaçadeのみ、または削除準備済み
- existing review data byte/semantic compatibility

Rollback: legacy façadeをold implementationへ戻せるcommit boundary。

## 9. Phase 5 — Extract annotation workflow server

Move:

- JobManager
- JobStore
- coordinator prompt
- built-in adapters
- checkpoint/recovery/reconciliation

to `plugins/annotation-workflow/server`.

Dependencies:

- ReviewCapability
- `ai/v1` (`workspace-write` mode)

Remove:

- concrete ReviewStore import
- CLI self-reentry for annotation mutation
- raw external AI command details

Tests:

- batch/coordinator
- deferred checkpoint
- external source conflict
- cancellation/process tree
- restart recovery
- timeout/output completion precedence
- late completion
- provider disabled while queued/running

Completion criteria:

- Core has no review-specific job prompt/state policy
- workflow disabled blocks new jobs and unmounts sidebar
- running job shutdown remains bounded

Rollback: workflow plugin disableでreview/headless operationsは維持。

## 10. Phase 6 — Extract GitHub Issue extension

Move Issue-specific:

- draft task codec
- output parser
- validation
- provider invocation
- single-flight
- UI contribution

to `plugins/github-issue`.

Compatibility:

- legacy `issue_*` fields remain projection during deprecation
- `createGitHubIssue()` remains façade
- external side effectは自動retryしない

Tests:

- allowed annotation ID
- draft internal-reference rejection
- single-flight
- indeterminate outcome
- disabled provider isolation

Completion criteria:

- review/job CoreにGitHub-specific prompt/route/UIなし

Rollback: Issue capabilityだけdisable可能。

## 11. Phase 7 — Core declarative renderer

Implement:

- normalized UI document endpoint
- component allowlist
- binding/local state
- instruction allowlist
- resource query store
- command execution state
- safe Markdown
- target-stage primitive
- Core shell
- renderer browser tests

Do not yet replace current UI; run behind alternate route/feature flag.

Tests:

- no plugin JS request/evaluation
- no raw HTML sink
- component/property exact validation
- draft survival during refresh
- dialog/focus/accessibility
- SSE/poll invalidation
- malicious document rejection
- target safe/trusted/public modes

Completion criteria:

- fixture declarative app can query/mutate dummy server
- CSP can remove`unsafe-inline` from host/settings surfaces

Rollback: old UI route remains default。

## 12. Phase 8 — Translate UI by owner

Create documents:

- `review/ui/review.ui.json`
- `annotation-workflow/ui/sidebar.ui.json`
- `ai/ui/settings.ui.json`
- `github-issue/ui/issue.ui.json`

Composition:

- review surface exposes named`review.sidebar` slot
- annotation-workflow fills sidebar slot
- disabled annotation-workflow unmounts AI/annotation/history and stage becomes full width
- plugin management details modal loads each`settings.detail` contribution declaratively

Browser acceptance:

- DOM/region/image annotation
- viewport modes
- overlay/focus/transient context restore
- reply draft persistence
- resolve/reopen/archive
- explicit history pagination 24
- jobs/auto-run
- Issue draft flow
- plugin enable/disable mount lifecycle

Completion criteria:

- `/` uses Core renderer by default
- browser JavaScriptはmanifest-declared local ES moduleに限定し、remote/implicit scriptは実行しない
- duplicate session polling/window custom events removed

Rollback: release flag can select legacy UI for one beta line。

## 13. Phase 9 — Compatibility and cleanup

Maintain for one deprecation period:

- legacy HTTP routes as bridge adapters
- annotation CLI façade
- root ReviewStore/JobStore/JobManager exports
- existing manifest/provider APIs

Adapters MUST contain no duplicate validation/business logic.

Then remove:

- monolithic `src/ui/reviewer.js`
- `src/ui/jobs.ts`
- review-specific sections of `src/http-server.ts`
- concrete domain classes from`src/`
- ID-specific branches in plugin settings UI

Add architecture import-boundary test:

- Core cannot import plugin implementation
- plugin cannot import another plugin implementation
- no dependency cycle
- Core source cannot mention annotation statuses/default plugin route semantics except compatibility module

## 14. Phase 10 — Release gates

Completed for `1.1.9`:

- [x] every published plugin has standalone tests
- [x] manifest version matches package version
- [x] root package contains default plugin server/UI documents
- [x] default bootstrap includes exactly `ai`, `firestore`, `review`, `annotation-workflow`, `page-map`, `github-issue`
- [x] clean offline fresh workspace starts
- [x] existing review fixture opens unchanged
- [x] `npm test`
- [x] `npm pack --dry-run` without retaining a tarball artifact
- [x] declarative renderer browser acceptance at desktop/tablet/mobile sizes
- [x] `/legacy`, `/settings/legacy`, and `VREV_LEGACY_UI=1` rollback acceptance
- [x] `git diff --check`

Publication remains non-atomic. If root publish succeeds and one of the six feature package publishes fails, retain the root release because it bundles compatible default copies, fix the package failure, and rerun the workflow; version-existence checks skip packages already published. Never overwrite an existing version.

## 15. Global acceptance matrix

| Case | Expected |
|---|---|
| Fresh install | offline defaults installed once |
| Existing same ID | never overwritten |
| Disabled plugin | no server eval/no UI contribution |
| Server-only plugin | headless action works |
| UI-only static plugin | no action declaration, renders safely |
| Invalid UI | diagnostic surface; valid server remains headless and callable |
| Invalid server | independently valid static UI renders with actions disabled; host remains if optional |
| Review plugin failure | serve fail closed, data untouched |
| Annotation workflow failure | sidebar unavailable, review data/headless capability intact |
| External command failure | AI packageのbuilt-in CLI methodsは利用可能 |
| Issue provider failure | review/annotation/history intact |
| Opposite behavior | plugin without UI remains valid |
| Insufficient capability | explicit unavailable reason, no inferred fallback |

## 16. Documentation updates per phase

Every phase updates:

- `docs/decisions.md` — accepted ADR and superseded decisions
- `docs/gotchas.md` — discovered operational/security caveats
- `docs/roadmap.md` — current phase, blockers, next gate
- `docs/plugins.md` — public plugin author contract after stabilization
- README — only user-visible behavior already implemented

The v4 architecture and bridge documents now describe the implemented beta.7 baseline. Future proposals must be labeled separately and must not be presented as current supported behavior before implementation.
