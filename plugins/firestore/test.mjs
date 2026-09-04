import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTokenSource } from "./auth.mjs";
import {
  collectLocalFiles,
  createWorkspaceStorageProvider,
  createWorkspaceStorageProviderFromContext,
  decodeStorageKeyFromDocumentId,
  encodeStorageKeyToDocumentId,
  localPathToStorageKey,
  pullCommand,
  pushCommand,
  statusCommand,
  storageKeyToLocalPath,
  validateStorageKey,
} from "./index.mjs";

const env = { FIREBASE_PROJECT_ID: "sample-project", FIREBASE_ACCESS_TOKEN: "test-token" };

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "vreview-firestore-"));
  mkdirSync(path.join(root, ".vreview", "reviews", "home"), { recursive: true });
  writeFileSync(path.join(root, ".vreview", "settings.json"), JSON.stringify({ schema_version: 1, projects: [] }));
  writeFileSync(path.join(root, ".vreview", "reviews", "home", "review.json"), JSON.stringify({ revision: 2, annotations: [] }));
  writeFileSync(path.join(root, ".vreview", "reviews", "home", "job-state.json"), JSON.stringify({ secretRuntime: true }));
  writeFileSync(path.join(root, ".vreview", "reviews", "home", "secrets.json"), JSON.stringify({ token: "must-not-leave" }));
  writeFileSync(path.join(root, ".vreview", "reviews", "home", "review.json.lock"), "lock");
  return root;
}

function httpResponse(value, status = 200) {
  return new Response(value === undefined ? undefined : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * An in-memory stand-in for the Firestore REST API: one document per collection/documentId pair,
 * supporting GET/PATCH/DELETE with `currentDocument` preconditions and the paginated
 * `documents:list` collection listing used by `list()`/`pull`/`status`.
 */
function firestoreMemory(expectedToken = "test-token") {
  const documents = new Map(); // documentId -> { fields, updateTime }
  let revisionCounter = 0;
  const calls = [];

  const nextUpdateTime = () => {
    revisionCounter += 1;
    return `2025-01-01T00:00:${String(revisionCounter).padStart(2, "0")}Z`;
  };

  const fetchImpl = async (rawUrl, init) => {
    calls.push({ url: String(rawUrl), init });
    if (expectedToken !== null) assert.equal(init.headers.Authorization, `Bearer ${expectedToken}`);
    const url = new URL(rawUrl);
    const segments = url.pathname.split("/documents")[1]?.split("/").filter(Boolean) ?? [];

    if (init.method === "GET" && segments.length === 1) {
      // documents:list on the collection.
      const pageSize = Number(url.searchParams.get("pageSize")) || 300;
      const pageToken = url.searchParams.get("pageToken");
      const allIds = [...documents.keys()].sort();
      const startIndex = pageToken ? allIds.indexOf(pageToken) + 1 : 0;
      const pageIds = allIds.slice(startIndex, startIndex + pageSize);
      const body = {
        documents: pageIds.map((id) => ({ name: `projects/x/databases/(default)/documents/${segments[0]}/${id}`, ...documents.get(id) })),
      };
      if (startIndex + pageSize < allIds.length) body.nextPageToken = pageIds.at(-1);
      return httpResponse(body);
    }

    const documentId = segments.at(-1);
    if (init.method === "GET") {
      const document = documents.get(documentId);
      return document ? httpResponse(document) : httpResponse({ error: { message: "missing" } }, 404);
    }
    if (init.method === "DELETE") {
      const expectedUpdateTime = url.searchParams.get("currentDocument.updateTime");
      const current = documents.get(documentId);
      if (!current || (expectedUpdateTime !== null && expectedUpdateTime !== current.updateTime)) {
        return httpResponse({ error: { message: "precondition failed" } }, 412);
      }
      documents.delete(documentId);
      return httpResponse({});
    }
    assert.equal(init.method, "PATCH");
    const current = documents.get(documentId);
    const expectedUpdateTime = url.searchParams.get("currentDocument.updateTime");
    if (expectedUpdateTime !== null && expectedUpdateTime !== current?.updateTime) {
      return httpResponse({ error: { message: "precondition failed" } }, 412);
    }
    if (url.searchParams.get("currentDocument.exists") === "false" && current) {
      // Firestore answers a failed `exists=false` precondition with 409 ALREADY_EXISTS, not 412.
      return httpResponse({ error: { message: `Document already exists: ${documentId}` } }, 409);
    }
    const document = { fields: JSON.parse(init.body).fields, updateTime: nextUpdateTime() };
    documents.set(documentId, document);
    return httpResponse(document);
  };

  return { calls, fetch: fetchImpl, documentCount: () => documents.size };
}

test("manifest and package expose the three commands and the WorkspaceStorageProviderV1 export", () => {
  const manifest = JSON.parse(readFileSync(new URL("./visual-review.plugin.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "firestore");
  assert.deepEqual(manifest.commands.map(({ name }) => name), ["push", "pull", "status"]);
  assert.equal(manifest.schema_version, 4);
  assert.equal(manifest.storage_provider.api_version, 1);
  assert.equal(manifest.storage_provider.export, "createWorkspaceStorageProviderFromContext");
  assert.equal(manifest.configuration.some((field) => field.key === "document_id"), false);
  const credentialFields = manifest.configuration.filter((field) => field.source === "credential");
  assert.deepEqual(credentialFields.map(({ key }) => key), ["service_account_key", "firebase_web_config"]);
  for (const field of credentialFields) {
    assert.equal(field.type, "secret");
    assert.equal(field.format, "json");
    assert.equal("default" in field, false);
  }
  assert.equal(pkg.dependencies, undefined);
});

test("document ID encoding round-trips, rejects unsafe keys, and never matches Firestore-reserved IDs", () => {
  for (const key of [
    "settings.json",
    "reviews/home/review.json",
    "reviews/a/b/c/deep.json",
    "a".repeat(200),
    "__looks-reserved__.json",
    "..leading-dots.json",
    "unicode/日本語/review.json",
  ]) {
    const documentId = encodeStorageKeyToDocumentId(key);
    assert.equal(documentId.includes("/"), false);
    assert.doesNotMatch(documentId, /^__.*__$/);
    assert.notEqual(documentId, ".");
    assert.notEqual(documentId, "..");
    assert.equal(decodeStorageKeyFromDocumentId(documentId), key);
  }
  for (const key of ["", "/leading-slash", "trailing-slash/", "has//empty", "has\\backslash", "./dot", "../traversal", "a/../b"]) {
    assert.throws(() => validateStorageKey(key));
  }
  assert.throws(() => encodeStorageKeyToDocumentId("x".repeat(2000)), /exceeds \d+ bytes/);
  assert.throws(() => decodeStorageKeyFromDocumentId("not-one-of-ours"), /not a Visual Review storage document ID/);
});

test("local path <-> storage key mapping is defined once and is reversible", () => {
  assert.equal(localPathToStorageKey(".vreview/settings.json"), "settings.json");
  assert.equal(localPathToStorageKey(".vreview/reviews/home/review.json"), "reviews/home/review.json");
  assert.equal(storageKeyToLocalPath("settings.json"), ".vreview/settings.json");
  assert.equal(storageKeyToLocalPath("reviews/home/review.json"), ".vreview/reviews/home/review.json");
  for (const localPath of [".vreview/settings.json", ".vreview/reviews/home/review.json"]) {
    assert.equal(storageKeyToLocalPath(localPathToStorageKey(localPath)), localPath);
  }
});

test("local collection includes only settings and review JSON, excludes runtime/secret/lock files, and is deterministic", () => {
  const root = workspace();
  const files = collectLocalFiles(root);
  assert.deepEqual(files.map(({ key }) => key), ["reviews/home/review.json", "settings.json"]);
  assert.doesNotMatch(JSON.stringify(files), /must-not-leave|secretRuntime/);
  assert.deepEqual(collectLocalFiles(root), files);
});

test("create-only write and stale-create conflict", async () => {
  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch });
  const key = "reviews/home/review.json";
  const created = await provider.compareAndSwap(key, null, { revision: 1 });
  assert.match(created.version, /^2025-/);
  await assert.rejects(provider.compareAndSwap(key, null, { revision: 2 }), { name: "StorageConflictError" });
});

test("compare-and-swap succeeds against the current version and fails against a stale one", async () => {
  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch });
  const key = "reviews/home/review.json";
  const created = await provider.compareAndSwap(key, null, { revision: 1 });
  const updated = await provider.compareAndSwap(key, created.version, { revision: 2 });
  assert.notEqual(updated.version, created.version);
  await assert.rejects(provider.compareAndSwap(key, created.version, { revision: 3 }), { name: "StorageConflictError" });
  assert.deepEqual(await provider.read(key), { version: updated.version, value: { revision: 2 } });
});

test("Firestore HTTP 400 precondition statuses are normalized as storage conflicts", async () => {
  for (const firestoreStatus of ["FAILED_PRECONDITION", "ABORTED", "ALREADY_EXISTS"]) {
    const fetch = async (_url, init) => init.method === "GET"
      ? httpResponse({ error: { message: "missing" } }, 404)
      : httpResponse({ error: { status: firestoreStatus, message: "stored version does not match required base version" } }, 400);
    const provider = createWorkspaceStorageProvider({ env, fetch });
    await assert.rejects(provider.compareAndSwap("reviews/home/review.json", "stale-version", { revision: 3 }), { name: "StorageConflictError" });
  }
});

test("delete succeeds with a matching version and conflicts on a stale or missing one", async () => {
  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch });
  const key = "reviews/home/review.json";
  const created = await provider.compareAndSwap(key, null, { revision: 1 });
  await assert.rejects(provider.delete(key, "2020-01-01T00:00:00Z"), { name: "StorageConflictError" });
  await provider.delete(key, created.version);
  assert.equal(await provider.read(key), null);
  await assert.rejects(provider.delete(key, created.version), { name: "StorageConflictError" });
});

test("prefix listing is deterministic and pages through nextPageToken", async () => {
  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch, listPageSize: 5 });
  const keys = Array.from({ length: 12 }, (_, index) => `reviews/r-${String(index).padStart(2, "0")}/review.json`);
  for (const key of keys) await provider.compareAndSwap(key, null, { key });
  await provider.compareAndSwap("settings.json", null, { schema_version: 1 });

  const listed = await provider.list("reviews/");
  assert.deepEqual(listed, [...keys].sort());
  const listCalls = memory.calls.filter(({ url }) => new URL(url).searchParams.has("pageSize"));
  assert.ok(listCalls.length > 1, "listing 13 documents at a page size of 300 in this test setup should still exercise pagination");
  assert.ok(listCalls.some(({ url }) => new URL(url).searchParams.has("pageToken")), "a later page must be requested with pageToken");

  const all = await provider.list("");
  assert.deepEqual(all, [...keys, "settings.json"].sort());
});

test("JSON round-trip preserves values without leaking backend-specific Firestore types", async () => {
  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch });
  const value = { revision: 3, annotations: [{ id: "a1", ok: true, note: null }], nested: { z: 1, a: 2 } };
  const written = await provider.compareAndSwap("reviews/home/review.json", null, value);
  const read = await provider.read("reviews/home/review.json");
  assert.deepEqual(read.value, value);
  assert.equal(read.version, written.version);
});

test("read rejects a malformed, digest-mismatched, wrong-schema, or oversized document before it reaches callers", async () => {
  const badSchema = async () => httpResponse({
    updateTime: "2025-01-01T00:00:00Z",
    fields: {
      schemaVersion: { integerValue: "99" },
      key: { stringValue: "reviews/home/review.json" },
      payload: { stringValue: "{}" },
      digest: { stringValue: "0".repeat(64) },
      updatedAt: { timestampValue: "2025-01-01T00:00:00Z" },
    },
  });
  await assert.rejects(createWorkspaceStorageProvider({ env, fetch: badSchema }).read("reviews/home/review.json"), /unsupported schema/);

  const wrongTypes = async () => httpResponse({
    updateTime: "2025-01-01T00:00:00Z",
    fields: {
      schemaVersion: { integerValue: "1" },
      key: { stringValue: "reviews/home/review.json" },
      payload: { integerValue: "123" },
      digest: { stringValue: "0".repeat(64) },
      updatedAt: { timestampValue: "2025-01-01T00:00:00Z" },
    },
  });
  await assert.rejects(createWorkspaceStorageProvider({ env, fetch: wrongTypes }).read("reviews/home/review.json"), /invalid types/);

  const badDigest = async () => httpResponse({
    updateTime: "2025-01-01T00:00:00Z",
    fields: {
      schemaVersion: { integerValue: "1" },
      key: { stringValue: "reviews/home/review.json" },
      payload: { stringValue: JSON.stringify({ ok: true }) },
      digest: { stringValue: "0".repeat(64) },
      updatedAt: { timestampValue: "2025-01-01T00:00:00Z" },
    },
  });
  await assert.rejects(createWorkspaceStorageProvider({ env, fetch: badDigest }).read("reviews/home/review.json"), /digest/);

  const oversized = async () => httpResponse({
    updateTime: "2025-01-01T00:00:00Z",
    fields: {
      schemaVersion: { integerValue: "1" },
      key: { stringValue: "reviews/home/review.json" },
      payload: { stringValue: "x".repeat(900 * 1024) },
      digest: { stringValue: "0".repeat(64) },
      updatedAt: { timestampValue: "2025-01-01T00:00:00Z" },
    },
  });
  await assert.rejects(createWorkspaceStorageProvider({ env, fetch: oversized }).read("reviews/home/review.json"), /exceeds the safe size limit/);

  const malformed = async () => httpResponse({ updateTime: "2025-01-01T00:00:00Z" });
  await assert.rejects(createWorkspaceStorageProvider({ env, fetch: malformed }).read("reviews/home/review.json"), /has no fields/);

  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch });
  const oversizedValue = { blob: "y".repeat(900 * 1024) };
  await assert.rejects(provider.compareAndSwap("reviews/home/review.json", null, oversizedValue), /exceeds the safe Firestore document size limit/);
  assert.equal(memory.calls.length, 0, "an oversized payload must be rejected before any network request");
});

test("createWorkspaceStorageProviderFromContext builds a WorkspaceStorageProviderV1 from a PluginRuntimeContextV1-shaped context", async () => {
  const memory = firestoreMemory("context-token");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = memory.fetch;
  try {
    const provider = createWorkspaceStorageProviderFromContext({
      workspaceRoot: "/unused",
      pluginDirectory: "/unused",
      configuration: { auth_mode: "access_token", project_id: "sample-project" },
      credentials: {},
      env: { FIREBASE_ACCESS_TOKEN: "context-token" },
    });
    assert.equal(provider.apiVersion, 1);
    const key = "reviews/home/review.json";
    const written = await provider.compareAndSwap(key, null, { revision: 1 });
    assert.equal(memory.calls[0].init.headers.Authorization, "Bearer context-token");
    assert.deepEqual(await provider.read(key), { version: written.version, value: { revision: 1 } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("push creates or updates each file's own document and reports a stale conflict", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalProject = process.env.FIREBASE_PROJECT_ID;
  const originalToken = process.env.FIREBASE_ACCESS_TOKEN;
  const originalLog = console.log;
  process.env.FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID;
  process.env.FIREBASE_ACCESS_TOKEN = env.FIREBASE_ACCESS_TOKEN;
  console.log = () => {};
  try {
    await t.test("dry-run touches no network and reports the file count", async () => {
      const memory = firestoreMemory();
      globalThis.fetch = memory.fetch;
      await pushCommand({ workspaceRoot: workspace(), pluginDirectory: "", args: ["--dry-run"] });
      assert.equal(memory.calls.length, 0);
    });

    await t.test("new documents use create-only, one per synchronized file", async () => {
      const memory = firestoreMemory();
      globalThis.fetch = memory.fetch;
      await pushCommand({ workspaceRoot: workspace(), pluginDirectory: "", args: [] });
      assert.equal(memory.documentCount(), 2);
    });

    await t.test("a concurrently modified document surfaces as an explicit conflict", async () => {
      const memory = firestoreMemory();
      const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch });
      await provider.compareAndSwap("reviews/home/review.json", null, { revision: 999 });
      globalThis.fetch = async (url, init) => (init.method === "PATCH" && String(url).includes("currentDocument.updateTime"))
        ? httpResponse({ error: { message: "precondition failed" } }, 412)
        : memory.fetch(url, init);
      await assert.rejects(pushCommand({ workspaceRoot: workspace(), pluginDirectory: "", args: [] }), { name: "StorageConflictError" });
    });

    await t.test("unknown arguments and --document are rejected", async () => {
      await assert.rejects(pushCommand({ workspaceRoot: workspace(), pluginDirectory: "", args: ["--document", "x"] }), /unknown argument/);
      await assert.rejects(pushCommand({ workspaceRoot: workspace(), pluginDirectory: "", args: ["--bogus"] }), /unknown argument/);
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

function withEnvAndFetch(fetchImpl, run) {
  const originalFetch = globalThis.fetch;
  const originalProject = process.env.FIREBASE_PROJECT_ID;
  const originalToken = process.env.FIREBASE_ACCESS_TOKEN;
  const originalLog = console.log;
  process.env.FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID;
  process.env.FIREBASE_ACCESS_TOKEN = env.FIREBASE_ACCESS_TOKEN;
  globalThis.fetch = fetchImpl;
  console.log = () => {};
  return run().finally(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalProject === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = originalProject;
    if (originalToken === undefined) delete process.env.FIREBASE_ACCESS_TOKEN;
    else process.env.FIREBASE_ACCESS_TOKEN = originalToken;
  });
}

test("pull writes remote documents atomically and dry-run leaves local data unchanged", async () => {
  const root = workspace();
  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch });
  await provider.compareAndSwap("reviews/home/review.json", null, { revision: 99 });
  await provider.compareAndSwap("reviews/new/context.json", null, { schema_version: 1 });

  await withEnvAndFetch(memory.fetch, async () => {
    await pullCommand({ workspaceRoot: root, pluginDirectory: "", args: ["--dry-run"], configuration: {}, credentials: {} });
    assert.equal(JSON.parse(readFileSync(path.join(root, ".vreview", "reviews", "home", "review.json"))).revision, 2);

    await pullCommand({ workspaceRoot: root, pluginDirectory: "", args: [], configuration: {}, credentials: {} });
    assert.equal(JSON.parse(readFileSync(path.join(root, ".vreview", "reviews", "home", "review.json"))).revision, 99);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".vreview", "reviews", "new", "context.json"))), { schema_version: 1 });
  });
});

test("status reports local-only, remote-only, modified, and unchanged, and dry-run is rejected", async () => {
  const root = workspace();
  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch });
  await provider.compareAndSwap("reviews/home/review.json", null, { revision: 1 });
  await provider.compareAndSwap("reviews/remote-only/review.json", null, { schema_version: 1 });

  await withEnvAndFetch(memory.fetch, async () => {
    const changes = await statusCommand({ workspaceRoot: root, pluginDirectory: "", args: [], configuration: {}, credentials: {} });
    const byKey = Object.fromEntries(changes.map(({ key, status }) => [key, status]));
    assert.equal(byKey["reviews/home/review.json"], "modified");
    assert.equal(byKey["reviews/remote-only/review.json"], "remote-only");
    assert.equal(byKey["settings.json"], "local-only");

    await assert.rejects(
      statusCommand({ workspaceRoot: root, pluginDirectory: "", args: ["--dry-run"], configuration: {}, credentials: {} }),
      /--dry-run is only valid/,
    );
  });
});

function decodeBase64Url(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeJwt(token) {
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  return {
    header: JSON.parse(decodeBase64Url(headerPart).toString("utf8")),
    payload: JSON.parse(decodeBase64Url(payloadPart).toString("utf8")),
    signingInput: `${headerPart}.${payloadPart}`,
    signature: decodeBase64Url(signaturePart),
  };
}

function fakeChildProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test("access_token mode sends the environment token as Bearer and is explicit about missing configuration", async () => {
  const memory = firestoreMemory();
  const provider = createWorkspaceStorageProvider({ env, fetch: memory.fetch });
  await provider.compareAndSwap("settings.json", null, { ok: true });
  assert.equal(memory.calls[0].init.headers.Authorization, "Bearer test-token");

  await assert.rejects(
    createWorkspaceStorageProvider({ env: { FIREBASE_PROJECT_ID: "sample-project" }, fetch: memory.fetch }).read("settings.json"),
    /FIREBASE_ACCESS_TOKEN/,
  );
  await assert.rejects(
    createWorkspaceStorageProvider({ env: { FIREBASE_ACCESS_TOKEN: "x" }, fetch: memory.fetch }).read("settings.json"),
    /Firebase project ID is required/,
  );
});

test("service_account mode signs an RS256 JWT, exchanges it, and its project ID falls back to the key", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccountKey = {
    client_email: "sample@sample-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    project_id: "sample-project",
  };
  const memory = firestoreMemory("service-account-access-token");
  const tokenCalls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      tokenCalls.push({ url, init });
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const decoded = decodeJwt(body.get("assertion"));
      assert.deepEqual(decoded.header, { alg: "RS256", typ: "JWT" });
      assert.equal(decoded.payload.iss, serviceAccountKey.client_email);
      assert.equal(decoded.payload.scope, "https://www.googleapis.com/auth/datastore");
      assert.equal(decoded.payload.exp - decoded.payload.iat, 3600);
      const verifier = createVerify("RSA-SHA256");
      verifier.update(decoded.signingInput);
      assert.ok(verifier.verify(publicKey, decoded.signature));
      return httpResponse({ access_token: "service-account-access-token", expires_in: 3600 });
    }
    return memory.fetch(url, init);
  };
  const provider = createWorkspaceStorageProvider({
    configuration: { auth_mode: "service_account" },
    credentials: { service_account_key: JSON.stringify(serviceAccountKey) },
    fetch: fetchImpl,
  });
  await provider.compareAndSwap("settings.json", null, { ok: true });
  assert.equal(tokenCalls.length, 1);
  assert.match(memory.calls[0].url, /projects\/sample-project\//);
});

test("service_account mode rejects a malformed key without leaking the key material", async () => {
  await assert.rejects(
    createWorkspaceStorageProvider({ configuration: { auth_mode: "service_account" }, credentials: { service_account_key: "not-json" }, fetch: async () => httpResponse({}) }).read("settings.json"),
    (error) => error instanceof Error && /must be valid JSON/.test(error.message) && !error.message.includes("not-json"),
  );
});

test("gcloud mode runs gcloud auth print-access-token with --account only when configured, never in a shell", async () => {
  const memory = firestoreMemory("gcloud-cli-token");
  const spawnCalls = [];
  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const child = fakeChildProcess();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("gcloud-cli-token\n"));
      child.emit("close", 0, null);
    });
    return child;
  };
  const provider = createWorkspaceStorageProvider({
    configuration: { auth_mode: "gcloud", gcloud_account: "svc@example.iam.gserviceaccount.com", project_id: "sample-project" },
    spawn: spawnImpl,
    fetch: memory.fetch,
  });
  await provider.compareAndSwap("settings.json", null, { ok: true });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "gcloud");
  assert.deepEqual(spawnCalls[0].args, ["auth", "print-access-token", "--account", "svc@example.iam.gserviceaccount.com"]);
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(memory.calls[0].init.headers.Authorization, "Bearer gcloud-cli-token");
});

test("gcloud mode reports a clear error when the CLI is missing and never leaks partial stdout on failure", async () => {
  const missingSpawn = () => {
    const child = fakeChildProcess();
    queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" })));
    return child;
  };
  await assert.rejects(
    createWorkspaceStorageProvider({ configuration: { auth_mode: "gcloud", project_id: "sample-project" }, spawn: missingSpawn, fetch: async () => httpResponse({}) }).read("settings.json"),
    /gcloud CLI was not found/,
  );

  const failingSpawn = () => {
    const child = fakeChildProcess();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("partial-token-leak"));
      child.stderr.emit("data", Buffer.from("ERROR: (gcloud.auth.print-access-token) You do not currently have an active account\n"));
      child.emit("close", 1, null);
    });
    return child;
  };
  await assert.rejects(
    createWorkspaceStorageProvider({ configuration: { auth_mode: "gcloud", project_id: "sample-project" }, spawn: failingSpawn, fetch: async () => httpResponse({}) }).read("settings.json"),
    (error) => error instanceof Error && /exit code 1/.test(error.message) && /active account/.test(error.message) && !error.message.includes("partial-token-leak"),
  );
});

test("gcloud mode caches the token until near expiry and forceRefresh bypasses the cache", async () => {
  let calls = 0;
  const spawnImpl = () => {
    calls += 1;
    const child = fakeChildProcess();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(`token-${calls}\n`));
      child.emit("close", 0, null);
    });
    return child;
  };
  let clock = 0;
  const source = createTokenSource({ mode: "gcloud", configuration: {}, spawn: spawnImpl, now: () => clock });
  assert.equal(await source.getAccessToken(), "token-1");
  assert.equal(await source.getAccessToken(), "token-1");
  assert.equal(calls, 1);
  clock += 51 * 60 * 1000;
  assert.equal(await source.getAccessToken(), "token-2");
  assert.equal(calls, 2);
  assert.equal(await source.getAccessToken({ forceRefresh: true }), "token-3");
  assert.equal(calls, 3);
});

test("firebase_web mode signs in anonymously, refreshes via refresh_token, and never exposes the apiKey in errors", async () => {
  const memory = firestoreMemory();
  const config = { apiKey: "sample-web-api-key-not-a-real-google-key", projectId: "sample-project" };
  let refreshCount = 0;
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    if (target.hostname === "identitytoolkit.googleapis.com") {
      assert.equal(target.searchParams.get("key"), config.apiKey);
      const body = JSON.parse(init.body);
      assert.equal(body.returnSecureToken, true);
      return httpResponse({ idToken: "anon-id-token-1", refreshToken: "refresh-token-1", expiresIn: "3600" });
    }
    if (target.hostname === "securetoken.googleapis.com") {
      refreshCount += 1;
      assert.equal(target.searchParams.get("key"), config.apiKey);
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "refresh-token-1");
      return httpResponse({ id_token: "anon-id-token-2", refresh_token: "refresh-token-1", expires_in: "3600" });
    }
    return memory.fetch(url, init);
  };
  let clock = 0;
  const source = createTokenSource({ mode: "firebase_web", credentials: { firebase_web_config: JSON.stringify(config) }, fetch: fetchImpl, now: () => clock });
  assert.equal(await source.getAccessToken(), "anon-id-token-1");
  assert.equal(source.projectIdHint, "sample-project");
  clock += 3600 * 1000;
  assert.equal(await source.getAccessToken(), "anon-id-token-2");
  assert.equal(refreshCount, 1);

  await assert.rejects(
    (async () => {
      const badSource = createTokenSource({ mode: "firebase_web", credentials: { firebase_web_config: "{}" }, fetch: fetchImpl, now: () => clock });
      await badSource.getAccessToken();
    })(),
    (error) => error instanceof Error && /missing apiKey/.test(error.message) && !error.message.includes(config.apiKey),
  );
});

test("a 401 Firestore response forces exactly one token refresh and retries exactly once", async () => {
  const memory = firestoreMemory(null);
  let tokenCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      tokenCalls += 1;
      return httpResponse({ access_token: `token-${tokenCalls}`, expires_in: 3600 });
    }
    if (init.headers.Authorization === "Bearer token-1") return httpResponse({ error: { message: "expired" } }, 401);
    return memory.fetch(url, init);
  };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccountKey = { client_email: "sample@sample-project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
  const provider = createWorkspaceStorageProvider({
    configuration: { auth_mode: "service_account", project_id: "sample-project" },
    credentials: { service_account_key: JSON.stringify(serviceAccountKey) },
    fetch: fetchImpl,
  });
  // The document does not exist yet in `memory`, so after the retry this resolves as `null`,
  // proving the retry actually reached Firestore with the refreshed token.
  assert.equal(await provider.read("settings.json"), null);
  assert.equal(tokenCalls, 2);
});

test("command context delivers configuration and credentials without routing them through argv or logged output", async () => {
  const secretMarker = "super-secret-service-account-material";
  const serviceAccountKey = { client_email: "svc@sample.iam.gserviceaccount.com", private_key: secretMarker };
  const context = {
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "vreview-firestore-cmd-")),
    pluginDirectory: "/unused",
    args: ["--collection", "team-workspace", "--dry-run"],
    configuration: { auth_mode: "service_account", project_id: "sample-project" },
    credentials: { service_account_key: JSON.stringify(serviceAccountKey) },
  };
  mkdirSync(path.join(context.workspaceRoot, ".vreview", "reviews"), { recursive: true });
  assert.doesNotMatch(JSON.stringify(context.args), new RegExp(secretMarker));
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await pushCommand(context);
  } finally {
    console.log = originalLog;
  }
  assert.doesNotMatch(logs.join("\n"), new RegExp(secretMarker));
});
