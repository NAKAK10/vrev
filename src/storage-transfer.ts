// Explicit, one-shot copy between two `WorkspaceStorageProviderV1` backends (see
// `src/storage-provider.ts`), driven from the settings UI. The source's content fully replaces
// the destination's: every source key is written (unless already identical) and every
// destination key absent from the source is deleted.
import { StorageConflictError, type StorageJson, type WorkspaceStorageProviderV1 } from "./storage-provider.js";

const MAX_KEYS = 5000;

export interface StorageTransferResult {
  direction: "local-to-plugin" | "plugin-to-local";
  dry_run: boolean;
  written: string[];
  deleted: string[];
  unchanged: number;
}

export interface StorageTransferOptions {
  source: WorkspaceStorageProviderV1;
  destination: WorkspaceStorageProviderV1;
  prefix: string;
  direction: "local-to-plugin" | "plugin-to-local";
  dryRun: boolean;
}

function sortedValue(value: StorageJson): StorageJson {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortedValue((value as Record<string, StorageJson>)[key] ?? null)]),
    ) as StorageJson;
  }
  return value;
}

function stableStringify(value: StorageJson): string {
  return JSON.stringify(sortedValue(value));
}

async function writeWithRetry(
  destination: WorkspaceStorageProviderV1,
  key: string,
  value: StorageJson,
  currentVersion: string | null,
): Promise<void> {
  try {
    await destination.compareAndSwap(key, currentVersion, value);
    return;
  } catch (error) {
    if (!(error instanceof StorageConflictError)) throw error;
  }
  // Retry exactly once against a freshly read version; a second conflict aborts the transfer.
  const retried = await destination.read(key);
  await destination.compareAndSwap(key, retried?.version ?? null, value);
}

async function deleteWithRetry(destination: WorkspaceStorageProviderV1, key: string, expectedVersion: string): Promise<void> {
  try {
    await destination.delete(key, expectedVersion);
    return;
  } catch (error) {
    if (!(error instanceof StorageConflictError)) throw error;
  }
  const retried = await destination.read(key);
  if (!retried) return; // already gone; the destination state we wanted is already reached
  await destination.delete(key, retried.version);
}

export async function transferWorkspaceStorage(options: StorageTransferOptions): Promise<StorageTransferResult> {
  const { source, destination, prefix, direction, dryRun } = options;
  const sourceKeys = await source.list(prefix);
  if (sourceKeys.length > MAX_KEYS) throw new Error(`storage transfer exceeds the ${MAX_KEYS}-key limit`);
  const destinationKeys = await destination.list(prefix);
  if (destinationKeys.length > MAX_KEYS) throw new Error(`storage transfer exceeds the ${MAX_KEYS}-key limit`);
  const destinationKeySet = new Set(destinationKeys);
  const sourceKeySet = new Set(sourceKeys);

  const written: string[] = [];
  const deleted: string[] = [];
  let unchanged = 0;

  for (const key of sourceKeys) {
    const sourceEntry = await source.read(key);
    if (!sourceEntry) continue; // deleted concurrently at the source; nothing left to copy
    const destinationEntry = destinationKeySet.has(key) ? await destination.read(key) : null;
    if (destinationEntry && stableStringify(destinationEntry.value) === stableStringify(sourceEntry.value)) {
      unchanged += 1;
      continue;
    }
    if (!dryRun) await writeWithRetry(destination, key, sourceEntry.value, destinationEntry?.version ?? null);
    written.push(key);
  }

  for (const key of destinationKeys) {
    if (sourceKeySet.has(key)) continue;
    if (!dryRun) {
      const destinationEntry = await destination.read(key);
      if (destinationEntry) await deleteWithRetry(destination, key, destinationEntry.version);
    }
    deleted.push(key);
  }

  return { direction, dry_run: dryRun, written, deleted, unchanged };
}
