import { existsSync, lstatSync, unlinkSync } from "node:fs";

import { atomicWriteJson, readJson, withFileLockAsync } from "./file-utils.js";
import type { ResolvedTarget } from "./paths.js";

// Structurally mirrors plugins/review/server/review-store.ts's ReviewDocumentKind/
// ReviewDocumentPaths/ReviewDocumentStorage. Duplicated (not imported) so Core does not
// depend on a plugin implementation module; the review plugin owns those definitions.
type ReviewDocumentKind = "active" | "resolved" | "transaction" | "legacy" | "context";
interface ReviewDocumentPaths {
  active: string;
  resolved: string;
  legacy: string;
  transaction: string;
  context: string;
}
interface ReviewDocumentStorage {
  read(kind: ReviewDocumentKind): Promise<unknown | null>;
  write(kind: ReviewDocumentKind, value: unknown): Promise<void>;
  remove(kind: ReviewDocumentKind): Promise<void>;
  withLock<T>(action: () => Promise<T>): Promise<T>;
}

function pathFor(paths: ReviewDocumentPaths, kind: ReviewDocumentKind): string {
  return paths[kind];
}

/** Local file system implementation of {@link ReviewDocumentStorage}. Preserves the review plugin's on-disk protocol (transaction file, split active/resolved files, legacy migration). */
export function createLocalReviewDocumentStorage(_target: ResolvedTarget, paths: ReviewDocumentPaths): ReviewDocumentStorage {
  for (const candidate of [paths.legacy, paths.transaction]) {
    // Another worker can remove the transaction between existence and stat checks.
    // A single lstat also rejects dangling symlinks without following their target.
    if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("review storage files must not be symbolic links");
  }

  return Object.freeze({
    async read(kind: ReviewDocumentKind): Promise<unknown | null> {
      const filePath = pathFor(paths, kind);
      if (!existsSync(filePath)) return null;
      return readJson(filePath);
    },
    async write(kind: ReviewDocumentKind, value: unknown): Promise<void> {
      atomicWriteJson(pathFor(paths, kind), value);
    },
    async remove(kind: ReviewDocumentKind): Promise<void> {
      try {
        unlinkSync(pathFor(paths, kind));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    withLock<T>(action: () => Promise<T>): Promise<T> {
      return withFileLockAsync(paths.active, action);
    },
  });
}
