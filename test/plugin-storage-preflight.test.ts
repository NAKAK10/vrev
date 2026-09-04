import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createVisualReviewServer, type VisualReviewServer } from "../src/index.js";
import { installPlugin } from "../src/plugin-registry.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-storage-preflight-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

function storagePlugin(root: string, id: string, providerBody: string): string {
  const directory = path.join(root, "plugins", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 3,
    id,
    version: "1.0.0",
    display: { title: id, summary: "storage preflight fixture", readme: "./README.md" },
    configuration: [],
    storage_provider: { api_version: 1, module: "./index.mjs", export: "createProvider" },
  }));
  writeFileSync(path.join(directory, "README.md"), `# ${id}\n`);
  writeFileSync(path.join(directory, "index.mjs"), providerBody);
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

const workingProviderBody = `
  export function createProvider() {
    return {
      apiVersion: 1,
      async list() { return []; },
      async read() { return null; },
      async compareAndSwap() { throw new Error("not used in this test"); },
      async delete() { throw new Error("not used in this test"); },
    };
  }
`;

const failingProviderBody = `
  export function createProvider() {
    return {
      apiVersion: 1,
      async list() { throw new Error("backend rejected the request: invalid credentials"); },
      async read() { return null; },
      async compareAndSwap() { throw new Error("not used in this test"); },
      async delete() { throw new Error("not used in this test"); },
    };
  }
`;

const hangingProviderBody = `
  export function createProvider() {
    return {
      apiVersion: 1,
      async list() { return new Promise(() => {}); },
      async read() { return null; },
      async compareAndSwap() { throw new Error("not used in this test"); },
      async delete() { throw new Error("not used in this test"); },
    };
  }
`;

let httpRoot: string;
let server: VisualReviewServer;
let baseUrl: string;

async function pluginPayload(): Promise<{ revision: string; plugins: Array<{ id: string; enabled: boolean }> }> {
  const response = await fetch(`${baseUrl}/api/settings/plugins`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ revision: string; plugins: Array<{ id: string; enabled: boolean }> }>;
}

before(async () => {
  httpRoot = workspace();
  mkdirSync(path.join(httpRoot, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(httpRoot, ".code/htmls/index.html"), "<h1>Fixture</h1>");
  await installPlugin(storagePlugin(httpRoot, "working-storage", workingProviderBody), httpRoot);
  await installPlugin(storagePlugin(httpRoot, "failing-storage", failingProviderBody), httpRoot);
  await installPlugin(storagePlugin(httpRoot, "hanging-storage", hangingProviderBody), httpRoot);
  await installPlugin(noStoragePlugin(httpRoot, "no-storage"), httpRoot);

  server = createVisualReviewServer({
    projectRoot: httpRoot,
    target: ".code/htmls/index.html",
    storagePreflightTimeoutMs: 200,
  });
  await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await server.close();
});

test("enabling a storage provider plugin whose backend rejects the preflight read returns 409 and leaves it disabled", async () => {
  const before1 = await pluginPayload();
  const response = await fetch(`${baseUrl}/api/settings/plugins/failing-storage`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: before1.revision, enabled: true, configuration: {} }),
  });
  assert.equal(response.status, 409);
  const text = await response.text();
  assert.match(text, /ストレージbackendへ接続できないため有効化できません/);
  assert.match(text, /backend rejected the request: invalid credentials/);

  const after1 = await pluginPayload();
  const plugin = after1.plugins.find((candidate) => candidate.id === "failing-storage");
  assert.equal(plugin?.enabled, false);
});

test("enabling a storage provider plugin whose backend accepts the preflight read succeeds", async () => {
  const before1 = await pluginPayload();
  const response = await fetch(`${baseUrl}/api/settings/plugins/working-storage`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: before1.revision, enabled: true, configuration: {} }),
  });
  assert.equal(response.status, 200);

  const after1 = await pluginPayload();
  const plugin = after1.plugins.find((candidate) => candidate.id === "working-storage");
  assert.equal(plugin?.enabled, true);
});

test("enabling a plugin without a storage provider never triggers a preflight", async () => {
  const before1 = await pluginPayload();
  const response = await fetch(`${baseUrl}/api/settings/plugins/no-storage`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: before1.revision, enabled: true, configuration: {} }),
  });
  assert.equal(response.status, 200);

  const after1 = await pluginPayload();
  const plugin = after1.plugins.find((candidate) => candidate.id === "no-storage");
  assert.equal(plugin?.enabled, true);
});

test("disabling a storage provider plugin never triggers a preflight", async () => {
  const before1 = await pluginPayload();
  const response = await fetch(`${baseUrl}/api/settings/plugins/working-storage`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: before1.revision, enabled: false, configuration: {} }),
  });
  assert.equal(response.status, 200);

  const after1 = await pluginPayload();
  const plugin = after1.plugins.find((candidate) => candidate.id === "working-storage");
  assert.equal(plugin?.enabled, false);
});

test("a storage provider that never responds times out and leaves the plugin disabled", async () => {
  const before1 = await pluginPayload();
  const response = await fetch(`${baseUrl}/api/settings/plugins/hanging-storage`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: before1.revision, enabled: true, configuration: {} }),
  });
  assert.equal(response.status, 409);
  const text = await response.text();
  assert.match(text, /タイムアウト/);

  const after1 = await pluginPayload();
  const plugin = after1.plugins.find((candidate) => candidate.id === "hanging-storage");
  assert.equal(plugin?.enabled, false);
});
