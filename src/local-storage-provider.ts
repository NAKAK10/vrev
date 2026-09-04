// Local filesystem implementation of `WorkspaceStorageProviderV1` (see `src/storage-provider.ts`).
// Storage keys are canonical relative POSIX paths under `.vrev/reviews/`, e.g.
// `reviews/home/review.json`. This is the reference implementation other storage backends
// (Firestore, etc.) are copied into place against when transferring workspace data.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

import { atomicWriteJson, readJson, withFileLock } from "./file-utils.js";
import {
  isCanonicalStorageKey,
  StorageConflictError,
  type StorageJson,
  type StoredValueV1,
  type WorkspaceStorageProviderV1,
} from "./storage-provider.js";

const RUNTIME_FILE_NAMES = new Set([".transaction.json", "job-state.json", ".server-lease.json"]);
const SENSITIVE_SEGMENT = /^(?:secret|secrets|credential|credentials|token|tokens)(?:[._-].*)?$/i;

function sortedValue(value: StorageJson): StorageJson {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortedValue((value as Record<string, StorageJson>)[key] ?? null)]),
    ) as StorageJson;
  }
  return value;
}

function versionOf(value: StorageJson): string {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

/** Rejects non-canonical keys, keys outside `reviews/`, non-JSON files, and runtime/secret files. */
function assertSyncableKey(key: string): string[] {
  if (!isCanonicalStorageKey(key)) throw new Error(`storage key must be a canonical relative POSIX path: ${key}`);
  const segments = key.split("/");
  if (segments[0] !== "reviews") throw new Error(`storage key must be under reviews/: ${key}`);
  const basename = segments.at(-1)!;
  if (!basename.toLowerCase().endsWith(".json")) throw new Error(`only JSON files are supported: ${key}`);
  if (
    RUNTIME_FILE_NAMES.has(basename)
    || basename.toLowerCase().endsWith(".lock")
    || segments.some((segment) => SENSITIVE_SEGMENT.test(segment))
  ) {
    throw new Error(`runtime or sensitive file is excluded from storage: ${key}`);
  }
  return segments;
}

function assertNoSymlinks(vreviewRoot: string, segments: string[]): void {
  let current = vreviewRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`storage path must not contain symbolic links: ${segments.join("/")}`);
    }
  }
}

function readCurrentValue(filePath: string, key: string): StorageJson | undefined {
  if (!existsSync(filePath)) return undefined;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`storage path must be a regular file: ${key}`);
  return readJson(filePath) as StorageJson;
}

function list(vreviewRoot: string, prefix: string): string[] {
  const reviewsRoot = path.join(vreviewRoot, "reviews");
  if (!existsSync(reviewsRoot)) return [];
  if (lstatSync(reviewsRoot).isSymbolicLink()) throw new Error("reviews directory must not be a symbolic link");
  const keys: string[] = [];
  const visit = (directory: string, relativeSegments: string[]): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(`storage path must not contain symbolic links: ${[...relativeSegments, entry.name].join("/")}`);
      }
      if (entry.isDirectory()) {
        if (!SENSITIVE_SEGMENT.test(entry.name)) visit(path.join(directory, entry.name), [...relativeSegments, entry.name]);
      } else if (entry.isFile()) {
        const name = entry.name;
        const lower = name.toLowerCase();
        if (lower.endsWith(".json") && !RUNTIME_FILE_NAMES.has(name) && !lower.endsWith(".lock") && !SENSITIVE_SEGMENT.test(name)) {
          keys.push(["reviews", ...relativeSegments, name].join("/"));
        }
      }
    }
  };
  visit(reviewsRoot, []);
  return keys.filter((key) => key.startsWith(prefix)).sort();
}

export function createLocalWorkspaceStorageProvider(projectRoot: string): WorkspaceStorageProviderV1 {
  const root = path.resolve(projectRoot);
  const vreviewRoot = path.join(root, ".vrev");

  return {
    apiVersion: 1,

    async list(prefix: string): Promise<string[]> {
      return list(vreviewRoot, prefix);
    },

    async read(key: string): Promise<StoredValueV1 | null> {
      const segments = assertSyncableKey(key);
      assertNoSymlinks(vreviewRoot, segments);
      const filePath = path.join(vreviewRoot, ...segments);
      const value = readCurrentValue(filePath, key);
      return value === undefined ? null : { version: versionOf(value), value };
    },

    async compareAndSwap(key: string, expectedVersion: string | null, value: StorageJson): Promise<{ version: string }> {
      const segments = assertSyncableKey(key);
      const filePath = path.join(vreviewRoot, ...segments);
      return withFileLock(filePath, () => {
        assertNoSymlinks(vreviewRoot, segments);
        const current = readCurrentValue(filePath, key);
        const currentVersion = current === undefined ? null : versionOf(current);
        if (currentVersion !== expectedVersion) throw new StorageConflictError();
        atomicWriteJson(filePath, value);
        return { version: versionOf(value) };
      });
    },

    async delete(key: string, expectedVersion: string): Promise<void> {
      const segments = assertSyncableKey(key);
      const filePath = path.join(vreviewRoot, ...segments);
      withFileLock(filePath, () => {
        assertNoSymlinks(vreviewRoot, segments);
        const current = readCurrentValue(filePath, key);
        if (current === undefined || versionOf(current) !== expectedVersion) throw new StorageConflictError();
        unlinkSync(filePath);
      });
    },
  };
}
