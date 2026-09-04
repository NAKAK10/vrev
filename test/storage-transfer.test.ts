import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createVisualReviewServer, type VisualReviewServer } from "../src/index.js";
import { installPlugin } from "../src/plugin-registry.js";
import { pluginSettingsRevision, readPluginSettings, updatePluginSettings } from "../src/plugin-settings.js";
import { createLocalWorkspaceStorageProvider } from "../src/local-storage-provider.js";
import { StorageConflictError, type StorageJson, type WorkspaceStorageProviderV1 } from "../src/storage-provider.js";
import { transferWorkspaceStorage } from "../src/storage-transfer.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-storage-transfer-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

// ---------------------------------------------------------------------------------------------
// Local filesystem provider
// ---------------------------------------------------------------------------------------------

test("local provider round-trips JSON and lists keys deterministically", async () => {
  const root = workspace();
  const provider = createLocalWorkspaceStorageProvider(root);

  await provider.compareAndSwap("reviews/b/review.json", null, { title: "b", count: 2 });
  await provider.compareAndSwap("reviews/a/review.json", null, { title: "a", nested: { z: 1, a: 2 } });
  await provider.compareAndSwap("reviews/a/resolved.json", null, [1, 2, 3]);

  assert.deepEqual(await provider.list("reviews/"), [
    "reviews/a/resolved.json",
    "reviews/a/review.json",
    "reviews/b/review.json",
  ]);
  assert.deepEqual(await provider.list("reviews/a/"), ["reviews/a/resolved.json", "reviews/a/review.json"]);

  const read = await provider.read("reviews/a/review.json");
  assert.deepEqual(read?.value, { title: "a", nested: { z: 1, a: 2 } });
  assert.equal(typeof read?.version, "string");
});

test("local provider compareAndSwap and delete enforce optimistic concurrency", async () => {
  const root = workspace();
  const provider = createLocalWorkspaceStorageProvider(root);

  await assert.rejects(provider.compareAndSwap("reviews/x/review.json", "not-empty", { a: 1 }), StorageConflictError);
  const created = await provider.compareAndSwap("reviews/x/review.json", null, { a: 1 });
  await assert.rejects(provider.compareAndSwap("reviews/x/review.json", null, { a: 2 }), StorageConflictError);
  const updated = await provider.compareAndSwap("reviews/x/review.json", created.version, { a: 2 });
  assert.notEqual(created.version, updated.version);

  await assert.rejects(provider.delete("reviews/x/review.json", created.version), StorageConflictError);
  await provider.delete("reviews/x/review.json", updated.version);
  assert.equal(await provider.read("reviews/x/review.json"), null);
  await assert.rejects(provider.delete("reviews/x/review.json", updated.version), StorageConflictError);
});

test("local provider excludes runtime files and rejects non-canonical or non-reviews keys", async () => {
  const root = workspace();
  const provider = createLocalWorkspaceStorageProvider(root);

  for (const key of [
    "reviews/x/job-state.json",
    "reviews/x/.transaction.json",
    "reviews/x/.server-lease.json",
    "reviews/x/secret.json",
    "reviews/credentials/api.json",
    "reviews/x/token-value.json",
  ]) {
    await assert.rejects(provider.compareAndSwap(key, null, {}), /runtime or sensitive file is excluded/, key);
  }
  for (const key of ["", "/reviews/x/review.json", "../reviews/x/review.json", "reviews/x/review.json\\", "reviews/x/review"]) {
    await assert.rejects(provider.compareAndSwap(key, null, {}), Error, key);
  }
  await assert.rejects(provider.compareAndSwap("settings.json", null, {}), /must be under reviews\//);

  // Runtime/lock files that already exist on disk (written outside the provider) never surface via list().
  mkdirSync(path.join(root, ".vreview", "reviews", "y"), { recursive: true });
  writeFileSync(path.join(root, ".vreview", "reviews", "y", "job-state.json"), "{}");
  writeFileSync(path.join(root, ".vreview", "reviews", "y", "stray.lock"), "{}");
  await provider.compareAndSwap("reviews/y/review.json", null, { ok: true });
  assert.deepEqual(await provider.list("reviews/y/"), ["reviews/y/review.json"]);
});

// ---------------------------------------------------------------------------------------------
// transferWorkspaceStorage
// ---------------------------------------------------------------------------------------------

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

  snapshot(): Record<string, StorageJson> {
    return Object.fromEntries([...this.values.entries()].map(([key, { value }]) => [key, value]));
  }
}

test("transferWorkspaceStorage copies, updates, and deletes so the destination matches the source", async () => {
  const source = new MemoryStorage();
  const destination = new MemoryStorage();
  await source.compareAndSwap("reviews/a/review.json", null, { title: "a" });
  await source.compareAndSwap("reviews/b/review.json", null, { title: "b" });
  await destination.compareAndSwap("reviews/b/review.json", null, { title: "stale" });
  await destination.compareAndSwap("reviews/c/review.json", null, { title: "extra" });

  const result = await transferWorkspaceStorage({
    source,
    destination,
    prefix: "reviews/",
    direction: "local-to-plugin",
    dryRun: false,
  });

  assert.deepEqual(result.written.sort(), ["reviews/a/review.json", "reviews/b/review.json"]);
  assert.deepEqual(result.deleted, ["reviews/c/review.json"]);
  assert.equal(result.unchanged, 0);
  assert.deepEqual(destination.snapshot(), {
    "reviews/a/review.json": { title: "a" },
    "reviews/b/review.json": { title: "b" },
  });
});

test("transferWorkspaceStorage skips identical content and reports it as unchanged", async () => {
  const source = new MemoryStorage();
  const destination = new MemoryStorage();
  await source.compareAndSwap("reviews/a/review.json", null, { title: "a", nested: { z: 1, a: 2 } });
  // Same content, different key insertion order -> still content-equal after normalization.
  await destination.compareAndSwap("reviews/a/review.json", null, { nested: { a: 2, z: 1 }, title: "a" });

  const result = await transferWorkspaceStorage({
    source,
    destination,
    prefix: "reviews/",
    direction: "plugin-to-local",
    dryRun: false,
  });

  assert.deepEqual(result.written, []);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.unchanged, 1);
});

test("transferWorkspaceStorage dry_run reports the plan without writing or deleting", async () => {
  const source = new MemoryStorage();
  const destination = new MemoryStorage();
  await source.compareAndSwap("reviews/a/review.json", null, { title: "a" });
  await destination.compareAndSwap("reviews/c/review.json", null, { title: "extra" });

  const result = await transferWorkspaceStorage({
    source,
    destination,
    prefix: "reviews/",
    direction: "local-to-plugin",
    dryRun: true,
  });

  assert.deepEqual(result.written, ["reviews/a/review.json"]);
  assert.deepEqual(result.deleted, ["reviews/c/review.json"]);
  assert.deepEqual(destination.snapshot(), { "reviews/c/review.json": { title: "extra" } });
});

test("transferWorkspaceStorage retries once on a destination conflict and then aborts", async () => {
  const source = new MemoryStorage();
  await source.compareAndSwap("reviews/a/review.json", null, { title: "a" });

  class FlakyDestination extends MemoryStorage {
    conflicts = 0;
    override async compareAndSwap(key: string, expectedVersion: string | null, value: StorageJson): Promise<{ version: string }> {
      if (this.conflicts < 1) {
        this.conflicts += 1;
        throw new StorageConflictError();
      }
      return super.compareAndSwap(key, expectedVersion, value);
    }
  }
  const recovering = new FlakyDestination();
  const recovered = await transferWorkspaceStorage({ source, destination: recovering, prefix: "reviews/", direction: "local-to-plugin", dryRun: false });
  assert.deepEqual(recovered.written, ["reviews/a/review.json"]);
  assert.deepEqual(recovering.snapshot(), { "reviews/a/review.json": { title: "a" } });

  class AlwaysConflicting extends MemoryStorage {
    override async compareAndSwap(): Promise<{ version: string }> {
      throw new StorageConflictError();
    }
  }
  await assert.rejects(
    transferWorkspaceStorage({ source, destination: new AlwaysConflicting(), prefix: "reviews/", direction: "local-to-plugin", dryRun: false }),
    StorageConflictError,
  );
});

// ---------------------------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------------------------

function memoryStoragePlugin(root: string, id: string): string {
  const directory = path.join(root, "plugins", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 3,
    id,
    version: "1.0.0",
    display: { title: id, summary: "in-memory storage fixture for tests", readme: "./README.md" },
    configuration: [],
    storage_provider: { api_version: 1, module: "./index.mjs", export: "createProvider" },
  }));
  writeFileSync(path.join(directory, "README.md"), `# ${id}\n`);
  writeFileSync(path.join(directory, "index.mjs"), `
    const values = new Map();
    export function createProvider() {
      return {
        apiVersion: 1,
        async list(prefix) {
          return [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
        },
        async read(key) {
          const found = values.get(key);
          return found ? { version: String(found.version), value: structuredClone(found.value) } : null;
        },
        async compareAndSwap(key, expectedVersion, value) {
          const current = values.get(key);
          if ((current ? String(current.version) : null) !== expectedVersion) {
            const error = new Error("storage version conflict");
            error.name = "StorageConflictError";
            throw error;
          }
          const version = (current?.version ?? 0) + 1;
          values.set(key, { version, value: structuredClone(value) });
          return { version: String(version) };
        },
        async delete(key, expectedVersion) {
          const current = values.get(key);
          if (!current || String(current.version) !== expectedVersion) {
            const error = new Error("storage version conflict");
            error.name = "StorageConflictError";
            throw error;
          }
          values.delete(key);
        },
      };
    }
  `);
  return directory;
}

function noStoragePlugin(root: string, id: string): string {
  const directory = path.join(root, "plugins", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 1,
    id,
    version: "1.0.0",
    commands: [{ name: "noop", module: "./index.mjs", export: "noop" }],
  }));
  writeFileSync(path.join(directory, "index.mjs"), "export function noop() {}\n");
  return directory;
}

let httpRoot: string;
let server: VisualReviewServer;
let baseUrl: string;

before(async () => {
  httpRoot = workspace();
  mkdirSync(path.join(httpRoot, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(httpRoot, ".code/htmls/index.html"), "<h1>Fixture</h1>");
  await installPlugin(memoryStoragePlugin(httpRoot, "memory-storage"), httpRoot);
  await installPlugin(memoryStoragePlugin(httpRoot, "disabled-storage"), httpRoot);
  await installPlugin(noStoragePlugin(httpRoot, "no-storage"), httpRoot);

  server = createVisualReviewServer({ projectRoot: httpRoot, target: ".code/htmls/index.html" });
  await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await server.close();
});

test("storage transfer HTTP route: invalid body, unknown plugin, missing storage_provider, disabled plugin, and a successful transfer", async () => {
  // Seed local review data so the transfer has something to copy.
  const localProvider = createLocalWorkspaceStorageProvider(httpRoot);
  await localProvider.compareAndSwap("reviews/home/review.json", null, { title: "home" });

  const badBody = await fetch(`${baseUrl}/api/settings/plugins/memory-storage/storage-transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: "sideways", dry_run: false }),
  });
  assert.equal(badBody.status, 400);

  const unknownPlugin = await fetch(`${baseUrl}/api/settings/plugins/does-not-exist/storage-transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: "local-to-plugin", dry_run: false }),
  });
  assert.equal(unknownPlugin.status, 404);

  const noStorage = await fetch(`${baseUrl}/api/settings/plugins/no-storage/storage-transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: "local-to-plugin", dry_run: false }),
  });
  assert.equal(noStorage.status, 404);

  // Disable the second fixture plugin, then confirm the route reports 409.
  const beforeDisable = readPluginSettings(httpRoot);
  const disabledPlugin = { id: "disabled-storage", manifest: { schema_version: 3 as const, id: "disabled-storage", version: "1.0.0" } };
  updatePluginSettings(
    disabledPlugin.id,
    disabledPlugin.manifest,
    { revision: pluginSettingsRevision(beforeDisable), enabled: false, configuration: {} },
    httpRoot,
  );
  const disabledResponse = await fetch(`${baseUrl}/api/settings/plugins/disabled-storage/storage-transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: "local-to-plugin", dry_run: false }),
  });
  assert.equal(disabledResponse.status, 409);
  assert.match(await disabledResponse.text(), /plugin is disabled: disabled-storage/);

  const dryRun = await fetch(`${baseUrl}/api/settings/plugins/memory-storage/storage-transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: "local-to-plugin", dry_run: true }),
  });
  assert.equal(dryRun.status, 200);
  const dryRunPayload = await dryRun.json() as { written: string[]; written_total: number; deleted_total: number; unchanged: number; dry_run: boolean };
  assert.equal(dryRunPayload.dry_run, true);
  assert.ok(dryRunPayload.written.includes("reviews/home/review.json"));
  assert.equal(dryRunPayload.written_total, dryRunPayload.written.length);
  assert.equal(dryRunPayload.deleted_total, 0);

  const applied = await fetch(`${baseUrl}/api/settings/plugins/memory-storage/storage-transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: "local-to-plugin", dry_run: false }),
  });
  assert.equal(applied.status, 200);
  const appliedPayload = await applied.json() as { written: string[]; direction: string };
  assert.equal(appliedPayload.direction, "local-to-plugin");
  assert.ok(appliedPayload.written.includes("reviews/home/review.json"));

  // A second identical push has nothing left to copy for the key we seeded.
  const secondApply = await fetch(`${baseUrl}/api/settings/plugins/memory-storage/storage-transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ direction: "local-to-plugin", dry_run: false }),
  });
  const secondPayload = await secondApply.json() as { written: string[]; unchanged: number };
  assert.ok(!secondPayload.written.includes("reviews/home/review.json"));
  assert.ok(secondPayload.unchanged >= 1);
});
