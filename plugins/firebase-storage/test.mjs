import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applySnapshot,
  collectLocalSnapshot,
  compareSnapshots,
  createStorageProvider,
  createWorkspaceStorageProvider,
  pushCommand,
  readRemoteSnapshot,
  storageProvider,
  workspaceStorageProvider,
  validateSnapshot,
  writeRemoteSnapshot,
} from "./index.mjs";

const env = { FIREBASE_PROJECT_ID: "sample-project", FIREBASE_ACCESS_TOKEN: "test-token" };

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "vreview-firebase-"));
  mkdirSync(path.join(root, ".vreview", "reviews", "home"), { recursive: true });
  writeFileSync(path.join(root, ".vreview", "settings.json"), JSON.stringify({ schema_version: 1, projects: [] }));
  writeFileSync(path.join(root, ".vreview", "reviews", "home", "review.json"), JSON.stringify({ revision: 2, annotations: [] }));
  writeFileSync(path.join(root, ".vreview", "reviews", "home", "job-state.json"), JSON.stringify({ secretRuntime: true }));
  writeFileSync(path.join(root, ".vreview", "reviews", "home", "secrets.json"), JSON.stringify({ token: "must-not-leave" }));
  writeFileSync(path.join(root, ".vreview", "reviews", "home", "review.json.lock"), "lock");
  return root;
}

function response(value, status = 200) {
  return new Response(value === undefined ? undefined : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function firestoreMemory() {
  let document;
  let revision = 0;
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.headers.Authorization, "Bearer test-token");
      if (init.method === "GET") {
        return document ? response(document) : response({ error: { message: "missing" } }, 404);
      }
      assert.equal(init.method, "PATCH");
      const requestUrl = new URL(url);
      const expectedUpdateTime = requestUrl.searchParams.get("currentDocument.updateTime");
      if (expectedUpdateTime !== null && expectedUpdateTime !== document?.updateTime) {
        return response({ error: { message: "precondition failed" } }, 412);
      }
      if (requestUrl.searchParams.get("currentDocument.exists") === "false" && document) {
        return response({ error: { message: "document already exists" } }, 412);
      }
      revision += 1;
      document = { ...JSON.parse(init.body), updateTime: `2025-01-01T00:00:0${revision}Z` };
      return response(document);
    },
  };
}

test("manifest and package expose commands and the backend-neutral storage provider API", () => {
  const manifest = JSON.parse(readFileSync(new URL("./visual-review.plugin.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.commands.map(({ name }) => name), ["push", "pull", "status"]);
  assert.equal(manifest.schema_version, 3);
  assert.equal(manifest.storage_provider.api_version, 1);
  assert.equal(manifest.storage_provider.export, "workspaceStorageProvider");
  assert.equal(pkg.dependencies, undefined);
  assert.equal(typeof storageProvider.list, "function");
  assert.equal(typeof storageProvider.read, "function");
  assert.equal(typeof storageProvider.write, "function");
  assert.equal(workspaceStorageProvider.apiVersion, 1);
  for (const method of ["list", "read", "compareAndSwap", "delete"]) assert.equal(typeof workspaceStorageProvider[method], "function");
});

test("local collection includes only settings and review JSON and is deterministic", () => {
  const root = workspace();
  const snapshot = collectLocalSnapshot(root);
  assert.deepEqual(snapshot.files.map(({ path: filePath }) => filePath), [
    ".vreview/reviews/home/review.json",
    ".vreview/settings.json",
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /must-not-leave|secretRuntime/);
  assert.deepEqual(collectLocalSnapshot(root), snapshot);
});

test("path traversal, secrets, malformed payloads, duplicates, and symlinks are rejected", () => {
  for (const filePath of ["../outside.json", ".vreview/plugins/x.json", ".vreview/reviews/home/job-state.json", ".vreview/reviews/home/secrets.json"]) {
    assert.throws(() => validateSnapshot({ schema_version: 1, files: [{ path: filePath, value: {} }] }), /path|outside|excluded/);
  }
  assert.throws(() => validateSnapshot({ schema_version: 1, files: [
    { path: ".vreview/reviews/a/review.json", value: {} },
    { path: ".vreview/reviews/a/review.json", value: {} },
  ] }), /duplicate/);
  assert.throws(() => validateSnapshot({ schema_version: 1, files: [
    { path: ".vreview/reviews/a/item.json", value: {} },
    { path: ".vreview/reviews/a/item.json/child.json", value: {} },
  ] }), /file\/directory path conflict/);
  const root = workspace();
  symlinkSync(path.join(root, ".vreview", "settings.json"), path.join(root, ".vreview", "reviews", "home", "linked.json"));
  assert.throws(() => collectLocalSnapshot(root), /symbolic links/);
});

test("Firestore REST write/read validates authorization, URL, schema, and digest", async () => {
  const memory = firestoreMemory();
  const snapshot = { schema_version: 1, files: [{ path: ".vreview/reviews/home/review.json", value: { revision: 3 } }] };
  const written = await writeRemoteSnapshot(snapshot, { env, fetch: memory.fetch, collectionId: "reviews", documentId: "team" });
  assert.deepEqual(written.snapshot, snapshot);
  const loaded = await readRemoteSnapshot({ env, fetch: memory.fetch, collectionId: "reviews", documentId: "team" });
  assert.deepEqual(loaded.snapshot, snapshot);
  assert.match(memory.calls[0].url, /projects\/sample-project\/databases\/\(default\)\/documents\/reviews\/team$/);

  const badFetch = async () => response({
    fields: {
      schemaVersion: { integerValue: "1" },
      payload: { stringValue: JSON.stringify({ schema_version: 1, files: [{ path: "../stolen.json", value: {} }] }) },
      digest: { stringValue: "0".repeat(64) },
      updatedAt: { timestampValue: "2025-01-01T00:00:00Z" },
    },
  });
  await assert.rejects(readRemoteSnapshot({ env, fetch: badFetch }), /path/);
});

test("push creates or updates with a remote precondition and reports conflicts", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalProject = process.env.FIREBASE_PROJECT_ID;
  const originalToken = process.env.FIREBASE_ACCESS_TOKEN;
  const originalLog = console.log;
  process.env.FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID;
  process.env.FIREBASE_ACCESS_TOKEN = env.FIREBASE_ACCESS_TOKEN;
  console.log = () => {};
  try {
    await t.test("new document uses create-only", async () => {
      const memory = firestoreMemory();
      globalThis.fetch = memory.fetch;
      await pushCommand({ workspaceRoot: workspace(), pluginDirectory: "", args: [] });
      assert.equal(memory.calls[0].init.method, "GET");
      assert.match(memory.calls[1].url, /currentDocument\.exists=false$/);
    });

    await t.test("existing document uses its updateTime", async () => {
      const memory = firestoreMemory();
      await writeRemoteSnapshot({ schema_version: 1, files: [] }, { env, fetch: memory.fetch });
      memory.calls.length = 0;
      globalThis.fetch = memory.fetch;
      await pushCommand({ workspaceRoot: workspace(), pluginDirectory: "", args: [] });
      assert.equal(memory.calls[0].init.method, "GET");
      assert.match(memory.calls[1].url, /currentDocument\.updateTime=2025-01-01T00%3A00%3A01Z$/);
    });

    await t.test("412 is an explicit conflict", async () => {
      const memory = firestoreMemory();
      await writeRemoteSnapshot({ schema_version: 1, files: [] }, { env, fetch: memory.fetch });
      globalThis.fetch = async (url, init) => init.method === "PATCH"
        ? response({ error: { message: "precondition failed" } }, 412)
        : memory.fetch(url, init);
      await assert.rejects(
        pushCommand({ workspaceRoot: workspace(), pluginDirectory: "", args: [] }),
        (error) => error?.status === 412 && /write conflict.*changed/i.test(error.message),
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalProject === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = originalProject;
    if (originalToken === undefined) delete process.env.FIREBASE_ACCESS_TOKEN;
    else process.env.FIREBASE_ACCESS_TOKEN = originalToken;
  }
});

test("access-token-only authentication is explicit", async () => {
  await assert.rejects(
    readRemoteSnapshot({ env: { FIREBASE_PROJECT_ID: "sample-project", GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json" }, fetch: async () => response({}) }),
    /FIREBASE_ACCESS_TOKEN.*GOOGLE_APPLICATION_CREDENTIALS is not supported/,
  );
  await assert.rejects(readRemoteSnapshot({ env: { FIREBASE_ACCESS_TOKEN: "x" }, fetch: async () => response({}) }), /FIREBASE_PROJECT_ID is required/);
});

test("pull uses atomic replacement and dry-run leaves local data unchanged", async () => {
  const root = workspace();
  const memory = firestoreMemory();
  const remote = { schema_version: 1, files: [
    { path: ".vreview/reviews/home/review.json", value: { revision: 99 } },
    { path: ".vreview/reviews/new/context.json", value: { schema_version: 1 } },
  ] };
  await writeRemoteSnapshot(remote, { env, fetch: memory.fetch });
  const loaded = await readRemoteSnapshot({ env, fetch: memory.fetch });
  applySnapshot(loaded.snapshot, root, { dryRun: true });
  assert.equal(JSON.parse(readFileSync(path.join(root, ".vreview", "reviews", "home", "review.json"))).revision, 2);

  const changed = applySnapshot(loaded.snapshot, root);
  assert.equal(changed.length, 2);
  assert.equal(JSON.parse(readFileSync(path.join(root, ".vreview", "reviews", "home", "review.json"))).revision, 99);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".vreview", "reviews", "new", "context.json"))), { schema_version: 1 });
  assert.equal(readFileSync(path.join(root, ".vreview", "reviews", "home", "review.json"), "utf8").endsWith("\n"), true);
});

test("pull rolls back earlier files when a later commit fails", { skip: process.platform === "win32" }, () => {
  const root = workspace();
  const lockedDirectory = path.join(root, ".vreview", "reviews", "locked");
  const lockedFile = path.join(lockedDirectory, "review.json");
  mkdirSync(lockedDirectory, { recursive: true });
  writeFileSync(lockedFile, JSON.stringify({ revision: 2 }));
  chmodSync(lockedDirectory, 0o500);
  try {
    assert.throws(() => applySnapshot({ schema_version: 1, files: [
      { path: ".vreview/reviews/home/review.json", value: { revision: 99 } },
      { path: ".vreview/reviews/locked/review.json", value: { revision: 99 } },
    ] }, root));
    assert.equal(JSON.parse(readFileSync(path.join(root, ".vreview", "reviews", "home", "review.json"))).revision, 2);
    assert.equal(JSON.parse(readFileSync(lockedFile)).revision, 2);
  } finally {
    chmodSync(lockedDirectory, 0o700);
  }
});

test("workspace provider maps Firestore updateTime to compare-and-swap", async () => {
  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch, documentId: "cas-provider" });
  const key = ".vreview/reviews/home/review.json";
  const created = await provider.compareAndSwap(key, null, { revision: 1 });
  assert.match(created.version, /^2025-/);
  assert.deepEqual(await provider.read(key), { version: created.version, value: { revision: 1 } });
  await assert.rejects(provider.compareAndSwap(key, null, { revision: 2 }), { name: "StorageConflictError" });
  const updated = await provider.compareAndSwap(key, created.version, { revision: 2 });
  assert.deepEqual(await provider.list(".vreview/reviews/"), [key]);
  await provider.delete(key, updated.version);
  assert.equal(await provider.read(key), null);
});

test("status comparison and legacy provider list/read/write work against an in-memory Firestore", async () => {
  const memory = firestoreMemory();
  const provider = createStorageProvider({ env, fetch: memory.fetch, documentId: "provider" });
  const filePath = ".vreview/reviews/home/review.json";
  await provider.write(filePath, { revision: 1 });
  assert.deepEqual(await provider.read(filePath), { revision: 1 });
  assert.deepEqual((await provider.list()).map(({ path: candidate }) => candidate), [filePath]);
  await provider.write(filePath, { revision: 2 });
  const missing = await provider.read(".vreview/reviews/home/resolved.json");
  assert.equal(missing, undefined);

  const changes = compareSnapshots(
    { schema_version: 1, files: [{ path: filePath, value: { revision: 2 } }] },
    { schema_version: 1, files: [
      { path: filePath, value: { revision: 1 } },
      { path: ".vreview/settings.json", value: {} },
    ] },
  );
  assert.deepEqual(changes.map(({ status }) => status), ["modified", "remote-only"]);
  assert.ok(memory.calls.some(({ url }) => url.includes("currentDocument.updateTime=")));
});
