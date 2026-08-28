# Roadmap

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
