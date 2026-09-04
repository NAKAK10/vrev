# Storage provider architecture

## Boundary

The `review` package owns review schema validation, migration, annotation/status invariants, source-hash checks, and storage conflict handling; `annotation-workflow` owns job orchestration. The Firestore package owns only backend I/O, credentials, connection lifecycle, and mapping an opaque backend revision to the common contract.

Runtime-only state (`job-state.json`, server lease, locks) remains local and is not part of remote storage. A running `ReviewStore`/`ReviewCapabilityV1` can switch which backend is authoritative (enabling or disabling a `storage_provider` plugin) without a server restart — see migration plan step 5 below — but that switch never copies data itself; bulk import/export between backends always goes through the explicit `storage-transfer` request, never an implicit side effect of enabling a plugin.

## API v1

```ts
interface WorkspaceStorageProviderV1 {
  readonly apiVersion: 1;
  list(prefix: string): Promise<string[]>;
  read(key: string): Promise<{ version: string; value: StorageJson } | null>;
  compareAndSwap(
    key: string,
    expectedVersion: string | null,
    value: StorageJson,
  ): Promise<{ version: string }>;
  delete(key: string, expectedVersion: string): Promise<void>;
}
```

Keys are canonical relative POSIX paths such as `reviews/<review-id>/active`. `version` is opaque to core. A stale expected version must raise `StorageConflictError`; it must never silently overwrite newer data.

## Backend mapping

| Backend | Value | Version / CAS |
|---|---|---|
| Local files | canonical JSON | SHA-256 or monotonic sidecar revision under file lock |
| Firestore | document field/map | document `updateTime` precondition |
| MySQL | JSON column or normalized rows | transaction plus numeric `row_version`; `UPDATE ... WHERE row_version = ?` |
| PostgreSQL | `jsonb` or normalized rows | transaction plus numeric version or `xmin` wrapper |

Provider-specific table names, collection names, SQL, credentials, pooling, retries, and migrations must remain inside each plugin. Core receives only JSON values, canonical keys, opaque versions, and normalized conflict errors.

## Migration plan

1. **Done.** Publish and validate the V1 provider contract. The `firestore` plugin implements it with one Firestore document per storage key, using each document's `updateTime` as the opaque version.
2. **Done.** Local provider implementing V1: `src/local-storage-provider.ts` (`createLocalWorkspaceStorageProvider`). Reference implementation other backends are copied into place against when transferring workspace data (`src/storage-transfer.ts`).
3. **Done.** `ReviewStore` persistence lives behind an asynchronous repository, `ReviewDocumentStorage` (`plugins/review/server/review-store.ts`), injected via `ReviewDomainDependencies.createStorage(target, paths)`. Core (`plugins/review/server/review-store.ts`) owns schema validation, migration, and mutation logic; the injected storage implementation owns only I/O and CAS retries.
4. Future third-party MySQL and PostgreSQL integrations can use the same conformance suite; they are not part of the six first-party feature packages.
5. **Done.** Selecting an authoritative provider per workspace: `src/workspace-storage.ts` (`createWorkspaceReviewDocumentStorage`, wired as `reviewDomainDependencies.createStorage` in `src/review-capability.ts`). A workspace with zero enabled `storage_provider` plugins uses local files (`src/review-storage-local.ts`); with exactly one enabled and fully configured `storage_provider` plugin, that plugin's provider becomes authoritative; with two or more enabled simultaneously, every review read/write fails closed with an explicit error instead of guessing. The backend is re-resolved (cached per workspace, keyed by the plugin settings revision) on every access, so enabling/disabling a storage plugin takes effect on the next call without a server restart. A provider that fails to load never falls back to local storage — the error is surfaced as-is instead, so data cannot silently split across backends.

Switching a workspace's authoritative backend does **not** copy data automatically. Existing review data stays wherever it was written; to move it to (or back from) a plugin's backend, a user runs the explicit `POST /api/settings/plugins/:id/storage-transfer` request (`direction: "local-to-plugin" | "plugin-to-local"`, optional `dry_run`) from the plugin settings screen ("データの上書き"), backed by `src/storage-transfer.ts`.

## Required conformance cases

- create-only write and stale-create conflict
- successful compare-and-swap and stale-version conflict
- delete with matching and stale versions
- deterministic prefix listing
- JSON round-trip without backend-specific types
- concurrent writers cannot lose an update
- malformed or oversized backend data is rejected before it reaches review mutation logic
- credentials never enter `.vrev` (outside the dedicated, gitignored `.vrev/credentials/<plugin-id>.json` store), plugin registry, review JSON, `.vrev/plugin-settings.json`, or command arguments. Covered by `test/plugin-credentials.test.ts` (store read/write/delete/presence, file/directory mode, symlink rejection, gitignore entry, HTTP credential routes never returning a value, the plain settings `PUT` rejecting a credential key, `loadPluginStorageProvider` delivering the credential only through a function-export's `PluginRuntimeContextV1`, and `plugin run` delivering it through `PluginCommandContext` rather than argv) and `plugins/firestore/test.mjs` (JWT/token material never appearing in Firestore request URLs, gcloud argv, or thrown errors).

## Sanctioned credential storage

A plugin that needs a secret value (a service account key, a web app config, an API token a user must paste in) declares it as a manifest `configuration` field with `type: "secret"` and `source: "credential"` (schema v3+). Core stores the value in `.vrev/credentials/<plugin-id>.json` (directory mode `0700`, file mode `0600`, `.vrev/.gitignore` entry `credentials/`), never in `.vrev/plugin-settings.json`, the plugin registry, or review JSON. The settings UI and `GET /api/settings/plugins` only ever see presence, `updated_at`, and an 8-hex-character SHA-256 fingerprint — never the value. A provider reads its declared credentials only through the `PluginRuntimeContextV1` passed to a function-export storage provider factory (`loadPluginStorageProvider`) or a command's `PluginCommandContext.credentials` (`plugin run`); see [`plugins.md`](plugins.md).
