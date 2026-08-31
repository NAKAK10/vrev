# Storage provider architecture

## Boundary

Core owns review schema validation, migration, annotation/status invariants, source-hash checks, job orchestration, and conflict handling. A storage plugin owns only backend I/O, credentials, connection lifecycle, and mapping an opaque backend revision to the common contract.

Runtime-only state (`job-state.json`, server lease, locks) remains local and is not part of remote storage. Remote providers must never replace review files behind a running `ReviewStore`; imports must go through a future host transaction boundary or require the server to be stopped.

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

1. **Current release:** publish and validate the V1 provider contract. Existing schema-v1 Firebase snapshot provider remains a legacy synchronization plugin.
2. Add a local provider implementing V1 and a reusable conformance suite.
3. Move `ReviewStore` persistence behind an asynchronous repository that performs schema validation and mutations in core, using provider CAS for retries.
4. Convert Firestore to V1 without direct file replacement. Add MySQL and PostgreSQL plugins against the same conformance suite.
5. Only after all mutation paths use the repository, allow selecting an authoritative provider per workspace.

This order avoids pretending the current Firebase push/pull implementation is an interchangeable database backend. Until step 3, storage providers are explicit sync/export integrations rather than the authoritative live store.

## Required conformance cases

- create-only write and stale-create conflict
- successful compare-and-swap and stale-version conflict
- delete with matching and stale versions
- deterministic prefix listing
- JSON round-trip without backend-specific types
- concurrent writers cannot lose an update
- malformed or oversized backend data is rejected before it reaches review mutation logic
- credentials never enter `.vreview`, plugin registry, review JSON, or command arguments
