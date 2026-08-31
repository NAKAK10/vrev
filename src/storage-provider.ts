export type StorageJson = null | boolean | number | string | StorageJson[] | { [key: string]: StorageJson };

export interface StoredValueV1 {
  version: string;
  value: StorageJson;
}

/**
 * Backend-neutral optimistic-concurrency contract for workspace data.
 * Firestore updateTime, SQL row versions, and local digests all map to `version`.
 */
export interface WorkspaceStorageProviderV1 {
  readonly apiVersion: 1;
  list(prefix: string): Promise<string[]>;
  read(key: string): Promise<StoredValueV1 | null>;
  compareAndSwap(key: string, expectedVersion: string | null, value: StorageJson): Promise<{ version: string }>;
  delete(key: string, expectedVersion: string): Promise<void>;
}

export class StorageConflictError extends Error {
  constructor(message = "storage version conflict") {
    super(message);
    this.name = "StorageConflictError";
  }
}

export function isCanonicalStorageKey(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

export function assertWorkspaceStorageProviderV1(value: unknown): asserts value is WorkspaceStorageProviderV1 {
  if (typeof value !== "object" || value === null) throw new Error("storage provider must be an object");
  const provider = value as Partial<WorkspaceStorageProviderV1>;
  if (provider.apiVersion !== 1) throw new Error("storage provider apiVersion must be 1");
  for (const method of ["list", "read", "compareAndSwap", "delete"] as const) {
    if (typeof provider[method] !== "function") throw new Error(`storage provider must implement ${method}()`);
  }
}
