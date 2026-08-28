# Roadmap

## Next: localhost application mode

- [ ] `visual-review local --repo <path> --url <loopback-url>` command
- [ ] loopback URL only reverse proxy for same-origin DOM annotation
- [ ] optional `--start "npm run dev"` child process lifecycle
- [ ] route-aware review persistence
- [ ] bind AI coordinator working directory to `--repo`
- [ ] reject non-loopback URLs and prevent proxy access to private network targets
- [ ] browser E2E for navigation, DOM annotation, responsive switching, and AI batch fixes

## Compatibility guardrails

- [x] schema 1 migration fixture for anchor, revision, and event compatibility
- [ ] status transition fixture across released versions
- [ ] external project fixture for `--project-root` boundaries and review storage
- [ ] CLI-version drift checks for OpenCode, Claude, and Codex adapters
- [ ] Windows process cancellation and `taskkill` verification

## Invariants

- One batch starts one coordinator process.
- Read-only subagents may investigate in parallel; only the coordinator edits files.
- AI may set `open -> addressed`; only a human may set `addressed -> resolved`.
- Target paths and review storage must remain inside the selected project root.
