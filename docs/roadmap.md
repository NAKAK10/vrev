# Roadmap

## Plugin Host v4 beta — Phases 0–10 implemented

- [x] Phase 0: freeze the green baseline and compatibility fixtures
- [x] Phase 1: ship schema-v4 manifests, bridge/server/UI contracts, capability registry, and process supervisor while continuing to accept manifest schemas v1–v3
- [x] Phase 2: add contract-checked plugin lifecycle, query/command dispatch, subscriptions, disabled-plugin isolation, and exact capability-version enforcement
- [x] Phase 3: move custom commands to a server-owned verified runner registry; job execution requests accept only opaque `runner_id` values (the restricted settings contribution may submit a template only to the dedicated registration operation)
- [x] Phase 4: move review persistence, migration, validation, and status policy to the bundled `review` plugin
- [x] Phase 5: move jobs, coordinator policy, adapters, and recovery to `annotation-workflow`, using capabilities and the Core process supervisor
- [x] Phase 6: move Issue draft parsing, validation, creation, and single-flight behavior to `github-issue`
- [x] Phase 7: implement the bounded JSON UI document loader and Core-owned declarative renderer; trusted local browser modules are now an explicit opt-in for behavior that cannot be expressed declaratively
- [x] Phase 8: make the declarative plugin surface the default and compose bundled review/workflow/custom-command/Issue contributions
- [x] Phase 9: reduce old Core domain modules to delegating compatibility façades and add source-boundary tests that reject domain logic in those façades and implementation imports across plugin boundaries
- [x] Phase 10: complete desktop/tablet/mobile browser acceptance, verify the declarative default and legacy rollback routes, and close package/release hygiene for `1.1.4`
- [x] Move declarative review/settings chrome to a shared Core-owned semantic token stylesheet so every plugin surface receives consistent CSS
- [ ] Add a versioned theme-provider contract that can override only validated semantic tokens, never arbitrary plugin CSS or selectors

The beta compatibility line intentionally retains rollback and deprecation surfaces: `/legacy`, `/settings/legacy`, and `VISUAL_REVIEW_LEGACY_UI=1`; legacy HTTP/CLI adapters; root `ReviewStore`, `JobStore`, and `JobManager` exports; and manifest/provider schemas v1–v3. These routes and exports delegate to the plugin-owned implementations and must not regain validation or business logic. They remain for this one-beta rollback line; do not remove them in beta.7.

Focused host, extraction, renderer, server, job, manifest, and plugin tests enforce lifecycle isolation, exact contracts, opaque runner IDs, façade delegation, declarative JSON documents plus explicitly declared local browser modules, and the implemented import boundaries. Browser acceptance covers the default declarative review/settings surfaces at desktop, tablet, and mobile sizes and the legacy route/flag rollback. Automated framework-fixture E2E remains a future localhost-mode enhancement, not an unverified v4 release claim. The authoritative remote-storage atomicity model remains a post-v4 decision gate.

### Phase 10 release acceptance (`1.1.4`)

- [x] root `package.json` and `package-lock.json` versions match
- [x] schema v4 is documented as the default; schema v1–v3 and legacy routes remain compatibility inputs
- [x] fresh workspaces bootstrap `review`, `annotation-workflow`, `custom-command`, and `github-issue` from bundled copies
- [x] only provenance-verified bundled copies receive safe atomic automatic upgrades
- [x] declarative `/` and `/settings/plugins` browser acceptance passes at desktop/tablet/mobile sizes
- [x] `/legacy`, `/settings/legacy`, and `VISUAL_REVIEW_LEGACY_UI=1` rollback paths remain available
- [x] `npm test`
- [x] `npm pack --dry-run` (inspection only; no tarball artifact retained)
- [x] `git diff --check`

Publication of the root and standalone plugin packages is non-atomic. The root package bundles compatible default plugin copies, so a plugin registry publish failure does not block fresh-workspace startup. If a standalone publish fails after the root succeeds, keep the root release, rerun the workflow after correcting the failed package, and rely on its version-existence checks to skip packages already published.

## Localhost application mode

- [x] loopback URL target through a same-origin reverse proxy
- [x] optional `--start "npm run dev"` child-process lifecycle
- [x] bind AI coordinator working directory to `--project-root`
- [x] reject non-loopback URLs and URL credentials
- [x] preserve route URL in each annotation
- [x] Vue/Nuxt, React/Next, Angular, Svelte, and WordPress source hints
- [ ] WebSocket proxy for framework HMR clients that require an upgrade channel
- [ ] source-map line/column mapping where framework tooling exposes it safely
- [ ] browser E2E against representative Vue, React, and WordPress fixtures

## Compatibility guardrails

- [x] schema 1 migration fixture for anchor, revision, and event compatibility
- [x] external project support through `--project-root`
- [ ] status transition fixture across released versions
- [ ] CLI-version drift checks for OpenCode, Claude, and Codex adapters
- [ ] Windows process cancellation and `taskkill` verification

## Security

- [x] pretest secret-safety scanner
- [x] ignore environment files, private keys, and review data
- [x] prohibit machine-specific home paths in the tool repository
- [ ] evaluate GitHub secret scanning and push protection before making the repository public

## Invariants

- One batch starts one coordinator process.
- Read-only subagents may investigate in parallel; only the coordinator edits files.
- AI may set `open -> addressed`; only a human may set `addressed -> resolved`.
- Target files, review storage, and AI edits must remain inside the selected project root.
- Live targets must use plain HTTP on an explicit loopback hostname.
