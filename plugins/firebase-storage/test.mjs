import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTokenSource } from "./auth.mjs";
import {
  applySnapshot,
  collectLocalSnapshot,
  compareSnapshots,
  createStorageProvider,
  createWorkspaceStorageProvider,
  createWorkspaceStorageProviderFromContext,
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

function firestoreMemory(expectedToken = "test-token") {
  let document;
  let revision = 0;
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (expectedToken !== null) assert.equal(init.headers.Authorization, `Bearer ${expectedToken}`);
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
  assert.equal(manifest.storage_provider.export, "createWorkspaceStorageProviderFromContext");
  const credentialFields = manifest.configuration.filter((field) => field.source === "credential");
  assert.deepEqual(credentialFields.map(({ key }) => key), ["service_account_key", "firebase_web_config"]);
  for (const field of credentialFields) {
    assert.equal(field.type, "secret");
    assert.equal(field.format, "json");
    assert.equal("default" in field, false);
  }
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

test("access-token mode is the default and is explicit about missing configuration", async () => {
  await assert.rejects(
    readRemoteSnapshot({ env: { FIREBASE_PROJECT_ID: "sample-project", GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json" }, fetch: async () => response({}) }),
    /FIREBASE_ACCESS_TOKEN.*GOOGLE_APPLICATION_CREDENTIALS is not supported/,
  );
  await assert.rejects(readRemoteSnapshot({ env: { FIREBASE_ACCESS_TOKEN: "x" }, fetch: async () => response({}) }), /Firebase project ID is required/);
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

test("service_account mode signs an RS256 JWT and exchanges it, and its project ID falls back to the key", async () => {
  const memoryToken = "service-account-access-token";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccountKey = {
    client_email: "sample@sample-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    project_id: "sample-project",
  };
  const memory = firestoreMemory(memoryToken);
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
      assert.equal(decoded.payload.aud, "https://oauth2.googleapis.com/token");
      assert.ok(decoded.payload.exp - decoded.payload.iat === 3600);
      const verifier = createVerify("RSA-SHA256");
      verifier.update(decoded.signingInput);
      assert.ok(verifier.verify(publicKey, decoded.signature), "JWT signature must verify against the key's public counterpart");
      return response({ access_token: "service-account-access-token", expires_in: 3600 });
    }
    return memory.fetch(url, { ...init, headers: { ...init.headers, Authorization: "Bearer service-account-access-token" } });
  };
  const snapshot = { schema_version: 1, files: [] };
  await writeRemoteSnapshot(snapshot, {
    configuration: { auth_mode: "service_account" },
    credentials: { service_account_key: JSON.stringify(serviceAccountKey) },
    fetch: fetchImpl,
  });
  assert.equal(tokenCalls.length, 1);
  assert.match(memory.calls[0].url, /projects\/sample-project\//);
});

test("service_account mode rejects a malformed key without leaking the key material", async () => {
  await assert.rejects(
    readRemoteSnapshot({ configuration: { auth_mode: "service_account" }, credentials: { service_account_key: "not-json" }, fetch: async () => response({}) }),
    (error) => error instanceof Error && /must be valid JSON/.test(error.message) && !error.message.includes("not-json"),
  );
});

test("gcloud mode runs gcloud auth print-access-token and passes --account when configured", async () => {
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
  const fetchImpl = async (url, init) => memory.fetch(url, init);
  await writeRemoteSnapshot({ schema_version: 1, files: [] }, {
    configuration: { auth_mode: "gcloud", gcloud_account: "svc@example.iam.gserviceaccount.com", project_id: "sample-project" },
    spawn: spawnImpl,
    fetch: fetchImpl,
  });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "gcloud");
  assert.deepEqual(spawnCalls[0].args, ["auth", "print-access-token", "--account", "svc@example.iam.gserviceaccount.com"]);
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(memory.calls[0].init.headers.Authorization, "Bearer gcloud-cli-token");
});

test("gcloud mode reports a clear error when the CLI is missing and never leaks stdout on failure", async () => {
  const missingSpawn = () => {
    const child = fakeChildProcess();
    queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" })));
    return child;
  };
  await assert.rejects(
    readRemoteSnapshot({ configuration: { auth_mode: "gcloud", project_id: "sample-project" }, spawn: missingSpawn, fetch: async () => response({}) }),
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
    readRemoteSnapshot({ configuration: { auth_mode: "gcloud", project_id: "sample-project" }, spawn: failingSpawn, fetch: async () => response({}) }),
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
      return response({ idToken: "anon-id-token-1", refreshToken: "refresh-token-1", expiresIn: "3600" });
    }
    if (target.hostname === "securetoken.googleapis.com") {
      refreshCount += 1;
      assert.equal(target.searchParams.get("key"), config.apiKey);
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "refresh-token-1");
      return response({ id_token: "anon-id-token-2", refresh_token: "refresh-token-1", expires_in: "3600" });
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

test("a 401 Firestore response forces exactly one token refresh and retries once", async () => {
  const memory = firestoreMemory(null);
  let tokenCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      tokenCalls += 1;
      return response({ access_token: `token-${tokenCalls}`, expires_in: 3600 });
    }
    if (init.headers.Authorization === "Bearer token-1") return response({ error: { message: "expired" } }, 401);
    return memory.fetch(url, init);
  };
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  void publicKey;
  const serviceAccountKey = { client_email: "sample@sample-project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
  const result = await readRemoteSnapshot({
    configuration: { auth_mode: "service_account", project_id: "sample-project" },
    credentials: { service_account_key: JSON.stringify(serviceAccountKey) },
    fetch: fetchImpl,
  }).catch((error) => error);
  // The document does not exist yet in `memory`, so after the retry this resolves as a 404, proving
  // the retry actually reached Firestore with the refreshed token rather than failing on the 401.
  assert.ok(result instanceof Error);
  assert.match(result.message, /Firestore request failed/);
  assert.equal(tokenCalls, 2);
});

test("createWorkspaceStorageProviderFromContext builds a WorkspaceStorageProviderV1 from a PluginRuntimeContextV1-shaped context", async () => {
  const memory = firestoreMemory("context-token");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = memory.fetch;
  try {
    const provider = createWorkspaceStorageProviderFromContext({
      workspaceRoot: "/unused",
      pluginDirectory: "/unused",
      configuration: { auth_mode: "access_token", project_id: "sample-project", document_id: "context-provider" },
      credentials: {},
      env: { FIREBASE_ACCESS_TOKEN: "context-token" },
    });
    assert.equal(provider.apiVersion, 1);
    const key = ".vreview/reviews/home/review.json";
    const written = await provider.compareAndSwap(key, null, { revision: 1 });
    assert.equal(memory.calls[0].init.headers.Authorization, "Bearer context-token");
    assert.deepEqual(await provider.read(key), { version: written.version, value: { revision: 1 } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("command context delivers configuration and credentials without routing them through argv or logged output", async () => {
  const secretMarker = "super-secret-service-account-material";
  const serviceAccountKey = { client_email: "svc@sample.iam.gserviceaccount.com", private_key: secretMarker };
  const context = {
    workspaceRoot: mkdtempSync(path.join(tmpdir(), "vreview-firebase-cmd-")),
    pluginDirectory: "/unused",
    args: ["--document", "team-workspace", "--dry-run"],
    configuration: { auth_mode: "service_account", project_id: "sample-project", document_id: "ignored-because-arg-wins" },
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
