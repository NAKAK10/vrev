import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkspaceStorageProviderV1,
  isCanonicalStorageKey,
  StorageConflictError,
  type StorageJson,
  type WorkspaceStorageProviderV1,
} from "../src/storage-provider.js";

class MemoryStorage implements WorkspaceStorageProviderV1 {
  readonly apiVersion = 1 as const;
  private readonly values = new Map<string, { version: number; value: StorageJson }>();

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async read(key: string): Promise<{ version: string; value: StorageJson } | null> {
    const found = this.values.get(key);
    return found ? { version: String(found.version), value: structuredClone(found.value) } : null;
  }

  async compareAndSwap(key: string, expectedVersion: string | null, value: StorageJson): Promise<{ version: string }> {
    const current = this.values.get(key);
    if ((current ? String(current.version) : null) !== expectedVersion) throw new StorageConflictError();
    const version = (current?.version ?? 0) + 1;
    this.values.set(key, { version, value: structuredClone(value) });
    return { version: String(version) };
  }

  async delete(key: string, expectedVersion: string): Promise<void> {
    const current = this.values.get(key);
    if (!current || String(current.version) !== expectedVersion) throw new StorageConflictError();
    this.values.delete(key);
  }
}

test("storage provider v1 maps backend revisions to compare-and-swap semantics", async () => {
  const provider = new MemoryStorage();
  assertWorkspaceStorageProviderV1(provider);
  assert.deepEqual(await provider.compareAndSwap("reviews/example", null, { revision: 1 }), { version: "1" });
  assert.deepEqual(await provider.read("reviews/example"), { version: "1", value: { revision: 1 } });
  await assert.rejects(provider.compareAndSwap("reviews/example", null, { revision: 2 }), StorageConflictError);
  assert.deepEqual(await provider.compareAndSwap("reviews/example", "1", { revision: 2 }), { version: "2" });
  assert.deepEqual(await provider.list("reviews/"), ["reviews/example"]);
  await provider.delete("reviews/example", "2");
  assert.equal(await provider.read("reviews/example"), null);
});

test("storage keys are backend-neutral canonical relative paths", () => {
  assert.equal(isCanonicalStorageKey("reviews/example"), true);
  for (const value of ["", "/reviews/example", "../review", "reviews/../secret", "reviews\\example"]) {
    assert.equal(isCanonicalStorageKey(value), false);
  }
  assert.throws(() => assertWorkspaceStorageProviderV1({ apiVersion: 1, read() {} }), /list/);
});
