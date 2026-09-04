// Adapts a `WorkspaceStorageProviderV1` (see `src/storage-provider.ts`) into the review plugin's
// `ReviewDocumentStorage` contract (`plugins/review/server/review-store.ts`). Structurally mirrors
// `ReviewDocumentKind`/`ReviewDocumentPaths`/`ReviewDocumentStorage` there — duplicated (not
// imported), same rationale as `src/review-storage-local.ts`: Core must not depend on a plugin
// implementation module.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import type { ResolvedTarget } from "./paths.js";
import { isCanonicalStorageKey, type StorageJson, type WorkspaceStorageProviderV1 } from "./storage-provider.js";

type ReviewDocumentKind = "active" | "resolved" | "transaction" | "legacy" | "context";
interface ReviewDocumentPaths {
  active: string;
  resolved: string;
  legacy: string;
  transaction: string;
  context: string;
}
interface ReviewDocumentStorage {
  readonly cacheReads?: boolean;
  read(kind: ReviewDocumentKind): Promise<unknown | null>;
  write(kind: ReviewDocumentKind, value: unknown): Promise<void>;
  remove(kind: ReviewDocumentKind): Promise<void>;
  withLock<T>(action: () => Promise<T>): Promise<T>;
}

/** Document kinds a remote storage provider actually persists; `legacy` never exists remotely. */
const SYNCABLE_KINDS = ["active", "resolved", "transaction", "context"] as const;
type SyncableKind = (typeof SYNCABLE_KINDS)[number];

const MAX_RETRIES = 3;

function isStorageConflictError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "StorageConflictError";
}

/** Maps a review document's absolute path (under `<projectRoot>/.vrev/`) to a canonical storage key. */
function storageKeyFor(target: ResolvedTarget, paths: ReviewDocumentPaths, kind: SyncableKind): string {
  const vreviewRoot = path.join(target.projectRoot, ".vrev");
  const relative = path.relative(vreviewRoot, paths[kind]);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`review storage path is outside .vrev: ${kind}`);
  }
  const key = relative.split(path.sep).join("/");
  if (!isCanonicalStorageKey(key)) throw new Error(`review storage key is not canonical: ${key}`);
  return key;
}

/**
 * `WorkspaceStorageProviderV1`-backed implementation of `ReviewDocumentStorage`. There is no
 * distributed lock: `withLock` instead retries the whole action on a compare-and-swap conflict,
 * tracking the version last observed for each document within the current attempt.
 */
export function createPluginReviewDocumentStorage(
  target: ResolvedTarget,
  paths: ReviewDocumentPaths,
  provider: WorkspaceStorageProviderV1,
): ReviewDocumentStorage {
  const keys: Record<SyncableKind, string> = {
    active: storageKeyFor(target, paths, "active"),
    resolved: storageKeyFor(target, paths, "resolved"),
    transaction: storageKeyFor(target, paths, "transaction"),
    context: storageKeyFor(target, paths, "context"),
  };

  // Each concurrent withLock call needs an isolated version set. A shared mutable map lets an
  // unrelated read replace another mutation's expected version while it is awaiting Firestore.
  const attemptVersions = new AsyncLocalStorage<Map<SyncableKind, string | null>>();

  async function readKind(kind: SyncableKind): Promise<unknown | null> {
    const result = await provider.read(keys[kind]);
    attemptVersions.getStore()?.set(kind, result ? result.version : null);
    return result ? result.value : null;
  }

  /** Version observed this attempt, reading the document first when it has not been observed yet. */
  async function observedVersion(kind: SyncableKind): Promise<string | null> {
    const versions = attemptVersions.getStore();
    const observed = versions?.get(kind);
    if (observed !== undefined) return observed;
    const current = await provider.read(keys[kind]);
    const version = current ? current.version : null;
    versions?.set(kind, version);
    return version;
  }

  async function writeKind(kind: SyncableKind, value: unknown): Promise<void> {
    // A document written without being read this attempt (the transaction recovery path writes the
    // split files without loading them) still needs its current version, or the compare-and-swap
    // would assert the document does not exist and fail against an existing one.
    const expectedVersion = await observedVersion(kind);
    const written = await provider.compareAndSwap(keys[kind], expectedVersion, value as StorageJson);
    attemptVersions.getStore()?.set(kind, written.version);
  }

  async function removeKind(kind: SyncableKind): Promise<void> {
    const expectedVersion = await observedVersion(kind);
    if (expectedVersion === null) return; // nothing to delete
    await provider.delete(keys[kind], expectedVersion);
    attemptVersions.getStore()?.set(kind, null);
  }

  return Object.freeze({
    cacheReads: true,
    async read(kind: ReviewDocumentKind): Promise<unknown | null> {
      if (kind === "legacy") return null;
      return readKind(kind);
    },
    async write(kind: ReviewDocumentKind, value: unknown): Promise<void> {
      if (kind === "legacy") return;
      await writeKind(kind, value);
    },
    async remove(kind: ReviewDocumentKind): Promise<void> {
      if (kind === "legacy") return;
      await removeKind(kind);
    },
    async withLock<T>(action: () => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await attemptVersions.run(new Map(), action);
        } catch (error) {
          if (isStorageConflictError(error) && attempt < MAX_RETRIES) continue;
          throw error;
        }
      }
    },
  });
}
