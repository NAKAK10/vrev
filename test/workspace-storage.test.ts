import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createReviewCapability,
  fileSha256,
  installPlugin,
  listPlugins,
  loadWorkspaceStorageProviderV1,
  pluginSettingsRevision,
  readPluginSettings,
  StorageConflictError,
  updatePluginSettings,
  type ResolvedTarget,
  type StorageJson,
  type WorkspaceStorageProviderV1,
} from "../src/index.js";
import { createPluginReviewDocumentStorage } from "../src/review-storage-plugin.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-workspace-storage-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(root, ".code/htmls/index.html"), "<h1>Review</h1>");
  return root;
}

// ---------------------------------------------------------------------------------------------
// In-memory `WorkspaceStorageProviderV1` plugin fixtures
// ---------------------------------------------------------------------------------------------

function memoryStoragePlugin(root: string, id: string, options: { alwaysConflict?: boolean; failFactory?: boolean } = {}): string {
  const directory = path.join(root, "plugins", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "vrev.plugin.json"), JSON.stringify({
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
      ${options.failFactory ? 'throw new Error("boom: cannot connect to backend");' : ""}
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
          ${options.alwaysConflict ? `
          const error = new Error("storage version conflict");
          error.name = "StorageConflictError";
          throw error;
          ` : `
          const current = values.get(key);
          if ((current ? String(current.version) : null) !== expectedVersion) {
            const error = new Error("storage version conflict");
            error.name = "StorageConflictError";
            throw error;
          }
          const version = (current?.version ?? 0) + 1;
          values.set(key, { version, value: structuredClone(value) });
          return { version: String(version) };
          `}
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

function disablePlugin(id: string, root: string): void {
  const installed = listPlugins(root).find((plugin) => plugin.id === id);
  assert.ok(installed, `plugin not installed: ${id}`);
  const settings = readPluginSettings(root);
  updatePluginSettings(id, installed.manifest, { revision: pluginSettingsRevision(settings), enabled: false, configuration: {} }, root);
}

// ---------------------------------------------------------------------------------------------
// Backend selection through the review domain (createReviewCapability / ReviewStore)
// ---------------------------------------------------------------------------------------------

test("an enabled storage_provider plugin becomes the authoritative backend; disabling it switches back to local files without a restart", async () => {
  const root = workspace();
  await installPlugin(memoryStoragePlugin(root, "mem-storage"), root);

  const capability = createReviewCapability(".code/htmls/index.html", { projectRoot: root });
  const { store } = capability;

  const review = await store.createAnnotation({
    kind: "dom",
    page_path: store.entryPath,
    comment: "hello from the plugin backend",
    anchor: { selector: "h1" },
    source_hash: fileSha256(store.targetPath),
  });
  const annotationId = review.annotations[0]!.id;

  // Nothing was written to the local review documents: the plugin backend is authoritative.
  // (`registerWorkspaceReview` always writes an unrelated local `context.json` sidecar; that is
  // pre-existing behavior outside the `ReviewDocumentStorage` boundary this task changes.)
  assert.equal(existsSync(store.path), false);
  assert.equal(existsSync(store.resolvedPath), false);
  assert.equal(existsSync(store.transactionPath), false);

  // The data really is in the plugin's backend.
  const { provider } = await loadWorkspaceStorageProviderV1("mem-storage", root);
  let remoteKeys = await provider.list("reviews/");
  assert.ok(remoteKeys.some((key) => key.endsWith("/review.json")), remoteKeys.join(","));

  // Context is read from the same authoritative backend, never from the local compatibility
  // sidecar. A missing remote context is initialized there without importing local contents.
  const localContextPath = path.join(path.dirname(store.path), "context.json");
  writeFileSync(localContextPath, JSON.stringify({ schema_version: 1, discovery_status: "completed", primary_project: "LOCAL-ONLY", related_scopes: ["credential:do-not-copy"] }));
  assert.deepEqual(await store.loadContext(), { schema_version: 1, discovery_status: "pending", primary_project: ".", related_scopes: [] });
  remoteKeys = await provider.list("reviews/");
  assert.ok(remoteKeys.some((key) => key.endsWith("/context.json")), remoteKeys.join(","));

  // load / loadActive / setStatus round-trip through the plugin backend.
  const active = await store.loadActive();
  assert.equal(active.annotations.length, 1);
  const resolved = await store.setStatus(annotationId, { status: "resolved", actor: "human" });
  assert.equal(resolved.annotations[0]!.status, "resolved");
  assert.equal((await store.load()).annotations[0]!.status, "resolved");

  // Issue-request draft ready/complete transaction protocol also round-trips remotely.
  const issueReview = await store.createIssueRequest({
    kind: "dom",
    page_path: store.entryPath,
    comment: "please file an issue",
    anchor: { selector: "h1" },
    source_hash: fileSha256(store.targetPath),
  });
  const issueAnnotationId = issueReview.annotations.find(({ status }) => status !== "resolved")!.id;
  const ready = await store.setIssueDraftReady(issueAnnotationId, "Bug title", "Bug body");
  assert.equal(ready.annotations.find(({ id }) => id === issueAnnotationId)!.issue_state, "ready");
  const created = await store.completeIssueDraft(issueAnnotationId, "Bug title", "https://github.com/example/project/issues/1");
  assert.equal(created.annotations.find(({ id }) => id === issueAnnotationId)!.issue_state, "created");
  assert.equal(existsSync(store.path), false);

  // Disable the plugin: the very same store instance must fall back to local files, no restart.
  disablePlugin("mem-storage", root);
  const localActive = await store.loadActive();
  assert.equal(localActive.annotations.length, 0, "disabling mid-session starts a fresh local review rather than migrating remote data");
  assert.equal(existsSync(store.path), true);
});

test("two simultaneously enabled storage_provider plugins fail closed", async () => {
  const root = workspace();
  await installPlugin(memoryStoragePlugin(root, "storage-a"), root);
  await installPlugin(memoryStoragePlugin(root, "storage-b"), root);

  const { store } = createReviewCapability(".code/htmls/index.html", { projectRoot: root });
  await assert.rejects(store.load(), /multiple storage provider plugins are enabled/);
  assert.equal(existsSync(store.path), false);
});

test("a storage_provider plugin that fails to load does not fall back to local storage", async () => {
  const root = workspace();
  await installPlugin(memoryStoragePlugin(root, "broken-storage", { failFactory: true }), root);

  const { store } = createReviewCapability(".code/htmls/index.html", { projectRoot: root });
  await assert.rejects(store.load(), /disable this plugin to fall back to local storage/);
  assert.equal(existsSync(store.path), false);
});

// ---------------------------------------------------------------------------------------------
// createPluginReviewDocumentStorage: optimistic-lock retry behavior
// ---------------------------------------------------------------------------------------------

function fakeTarget(root: string): ResolvedTarget {
  return { projectRoot: root, absolutePath: path.join(root, ".code/htmls/index.html"), entryPath: ".code/htmls/index.html", kind: "html" };
}

function fakePaths(root: string) {
  const directory = path.join(root, ".vrev", "reviews", "x");
  return {
    active: path.join(directory, "review.json"),
    resolved: path.join(directory, "resolved.json"),
    legacy: path.join(root, ".code", "vrevs", "x", "review.json"),
    transaction: path.join(directory, ".transaction.json"),
    context: path.join(directory, "context.json"),
  };
}

class CountingMemoryProvider implements WorkspaceStorageProviderV1 {
  readonly apiVersion = 1 as const;
  compareAndSwapCalls = 0;
  private readonly values = new Map<string, { version: number; value: StorageJson }>();

  constructor(private failuresBeforeSuccess = Infinity) {}

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async read(key: string): Promise<{ version: string; value: StorageJson } | null> {
    const found = this.values.get(key);
    return found ? { version: String(found.version), value: structuredClone(found.value) } : null;
  }

  async compareAndSwap(key: string, expectedVersion: string | null, value: StorageJson): Promise<{ version: string }> {
    this.compareAndSwapCalls += 1;
    if (this.compareAndSwapCalls <= this.failuresBeforeSuccess) throw new StorageConflictError();
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

test("withLock retries the whole action on a compare-and-swap conflict and succeeds within the retry budget", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-storage-plugin-"));
  const provider = new CountingMemoryProvider(2); // fails the first 2 calls, then succeeds
  const storage = createPluginReviewDocumentStorage(fakeTarget(root), fakePaths(root), provider);

  let attempts = 0;
  await storage.withLock(async () => {
    attempts += 1;
    await storage.write("active", { attempt: attempts });
  });

  assert.equal(attempts, 3);
  assert.deepEqual(await storage.read("active"), { attempt: 3 });
});

test("concurrent withLock calls isolate observed versions and retry stale mutations", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-storage-plugin-"));
  const provider = new CountingMemoryProvider(0);
  const storage = createPluginReviewDocumentStorage(fakeTarget(root), fakePaths(root), provider);
  await storage.withLock(async () => { await storage.write("active", { revision: 1 }); });

  let releaseFirst!: () => void;
  const firstMayWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstHasRead!: () => void;
  const firstRead = new Promise<void>((resolve) => { firstHasRead = resolve; });
  let firstAttempts = 0;
  const first = storage.withLock(async () => {
    firstAttempts += 1;
    const current = await storage.read("active") as { revision: number };
    if (firstAttempts === 1) { firstHasRead(); await firstMayWrite; }
    await storage.write("active", { revision: current.revision + 1 });
  });
  await firstRead;
  await storage.withLock(async () => {
    const current = await storage.read("active") as { revision: number };
    await storage.write("active", { revision: current.revision + 1 });
  });
  releaseFirst();
  await first;

  assert.equal(firstAttempts, 2, "the stale action must retry rather than borrow another action's version");
  assert.deepEqual(await storage.read("active"), { revision: 3 });
});

test("withLock gives up and throws after exceeding the retry budget on a permanently conflicting backend", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-storage-plugin-"));
  const provider = new CountingMemoryProvider(); // always conflicts
  const storage = createPluginReviewDocumentStorage(fakeTarget(root), fakePaths(root), provider);

  let attempts = 0;
  await assert.rejects(
    storage.withLock(async () => {
      attempts += 1;
      await storage.write("active", { attempt: attempts });
    }),
    StorageConflictError,
  );
  assert.equal(attempts, 4, "1 initial attempt + up to 3 retries");
  assert.equal(provider.compareAndSwapCalls, 4);
});

test("a document written without being read this attempt keeps its existing version instead of asserting it is new", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-storage-plugin-"));
  const provider = new CountingMemoryProvider(0);
  const storage = createPluginReviewDocumentStorage(fakeTarget(root), fakePaths(root), provider);

  await storage.withLock(async () => { await storage.write("active", { revision: 1 }); });
  // The transaction recovery path writes the split documents without loading them first, so a
  // create-only precondition here would fail against the document written above.
  await storage.withLock(async () => { await storage.write("active", { revision: 2 }); });

  assert.deepEqual(await storage.read("active"), { revision: 2 });
});

test("removing a document that was not read this attempt deletes it with its current version", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-storage-plugin-"));
  const provider = new CountingMemoryProvider(0);
  const storage = createPluginReviewDocumentStorage(fakeTarget(root), fakePaths(root), provider);

  await storage.withLock(async () => { await storage.write("transaction", { pending: true }); });
  await storage.withLock(async () => { await storage.remove("transaction"); });

  assert.equal(await storage.read("transaction"), null);
});

test("createPluginReviewDocumentStorage treats the legacy document as a no-op", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-storage-plugin-"));
  const provider = new CountingMemoryProvider();
  const storage = createPluginReviewDocumentStorage(fakeTarget(root), fakePaths(root), provider);

  assert.equal(await storage.read("legacy"), null);
  await storage.write("legacy", { anything: true });
  await storage.remove("legacy");
  assert.equal(provider.compareAndSwapCalls, 0);
});
