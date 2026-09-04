import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createVrevServer, type VrevServer } from "../src/index.js";
import { ensureDefaultPlugins } from "../src/cli.js";

let root: string;
let vrev: VrevServer;
let baseUrl: string;

function localFixture(root: string, id: string): string {
  const source = path.join(root, "fixtures", id);
  mkdirSync(path.join(source, "dist"), { recursive: true });
  writeFileSync(path.join(source, "vrev.plugin.json"), JSON.stringify({
    schema_version: 1,
    id,
    version: "1.0.0",
    commands: [{ name: "hello", module: "./dist/plugin.js" }],
  }));
  writeFileSync(path.join(source, "dist/plugin.js"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(new URL("./evaluated", import.meta.url), "yes");
    export default async function hello() {}
  `);
  return source;
}

function serverFixture(root: string, id: string): string {
  const source = path.join(root, "server-fixtures", id);
  mkdirSync(source, { recursive: true });
  const empty = { type: "object", properties: {}, additionalProperties: false };
  const output = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  writeFileSync(path.join(source, "README.md"), "# Runtime fixture\n");
  writeFileSync(path.join(source, "contract.json"), JSON.stringify({ schema_version: 1, queries: [{ name: "fixture.get", permission: "fixture.read", input_schema: empty, output_schema: output, resources: ["fixture"] }], commands: [] }));
  writeFileSync(path.join(source, "server.js"), `
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    writeFileSync(path.join(import.meta.dirname, "evaluated"), "yes");
    export default { apiVersion: 1, create(context) { return { start() {}, query() { return { ok: true, data: { value: "ready" } }; }, command() {}, stop() { writeFileSync(path.join(context.plugin.root, "stopped"), "yes"); } }; } };
  `);
  writeFileSync(path.join(source, "vrev.plugin.json"), JSON.stringify({ schema_version: 4, id, version: "1.0.0", display: { title: id, summary: "Runtime fixture", readme: "./README.md" }, configuration: [], server: { api_version: 1, bridge_api_version: 1, module: "./server.js", contract: "./contract.json" } }));
  return source;
}

function npmPackableFixture(root: string, id: string): string {
  const source = path.join(root, "npm-fixtures", id);
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: `vrev-test-${id}`, version: "1.0.0", type: "module", files: ["vrev.plugin.json", "index.js"] }));
  writeFileSync(path.join(source, "vrev.plugin.json"), JSON.stringify({ schema_version: 1, id, version: "1.0.0", commands: [{ name: "run", module: "./index.js" }] }));
  writeFileSync(path.join(source, "index.js"), "export default () => undefined;\n");
  return source;
}

before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "vrev-plugin-install-api-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(root, ".code/htmls/index.html"), "<h1>Target</h1>");
  await ensureDefaultPlugins(root);
  vrev = createVrevServer({ projectRoot: root, target: ".code/htmls/index.html" });
  await new Promise<void>((resolve) => vrev.server.listen(0, "127.0.0.1", resolve));
  const address = vrev.server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await vrev.close();
});

test("installs a local plugin without evaluating it, disabled by default, with a local resolution digest", async () => {
  const source = localFixture(root, "install-api-local");
  const response = await fetch(`${baseUrl}/api/settings/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as {
    installed: { id: string; version: string; resolved: { kind: string; digest: string } | null; warnings: string[] };
    plugins: Array<{ id: string; enabled: boolean; resolved: { kind: string; digest: string } | null; bundled: boolean }>;
  };
  assert.equal(body.installed.id, "install-api-local");
  assert.equal(body.installed.version, "1.0.0");
  assert.equal(body.installed.resolved?.kind, "local");
  assert.ok(body.installed.resolved?.digest);
  assert.deepEqual(body.installed.warnings, []);

  const listed = body.plugins.find((plugin) => plugin.id === "install-api-local");
  assert.ok(listed);
  assert.equal(listed?.enabled, false);
  assert.equal(listed?.bundled, false);
  assert.equal(listed?.resolved?.kind, "local");

  assert.equal(existsSync(path.join(root, ".vrev/plugins/install-api-local/dist/evaluated")), false);
});

test("enabling and disabling a newly installed package server reconciles its lifecycle", async () => {
  const source = serverFixture(root, "runtime-api-local");
  const installed = await fetch(`${baseUrl}/api/settings/plugins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) });
  assert.equal(installed.status, 201);
  const directory = path.join(root, ".vrev/plugins/runtime-api-local");
  assert.equal(existsSync(path.join(directory, "evaluated")), false);

  const initial = await (await fetch(`${baseUrl}/api/settings/plugins`)).json() as { revision: string };
  const enabled = await fetch(`${baseUrl}/api/settings/plugins/runtime-api-local`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: initial.revision, enabled: true, configuration: {} }) });
  assert.equal(enabled.status, 200);
  assert.equal(existsSync(path.join(directory, "evaluated")), true);
  const query = await fetch(`${baseUrl}/api/plugin-host/v1/plugins/runtime-api-local/queries/fixture.get`, { method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify({ protocol: "plugin-bridge/1", request_id: "runtime", input: {} }) });
  assert.equal(query.status, 200);
  assert.deepEqual((await query.json() as { data: unknown }).data, { value: "ready" });

  const current = await (await fetch(`${baseUrl}/api/settings/plugins`)).json() as { revision: string };
  const disabled = await fetch(`${baseUrl}/api/settings/plugins/runtime-api-local`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: current.revision, enabled: false, configuration: {} }) });
  assert.equal(disabled.status, 200);
  assert.equal(existsSync(path.join(directory, "stopped")), true);
});

test("installs an npm-packed file: spec, resolved as npm with integrity and an unpinned warning", async () => {
  const source = npmPackableFixture(root, "install-api-npm");
  const response = await fetch(`${baseUrl}/api/settings/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: `file:${source}` }),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { installed: { resolved: { kind: string; digest: string; integrity?: string } | null; warnings: string[] } };
  assert.equal(body.installed.resolved?.kind, "npm");
  assert.ok(body.installed.resolved?.digest);
  assert.equal(Array.isArray(body.installed.warnings), true);
});

test("rejects a local source that does not exist", async () => {
  const response = await fetch(`${baseUrl}/api/settings/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "./does-not-exist" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /does not exist/);
});

test("rejects an unpinned GitHub shorthand source", async () => {
  const response = await fetch(`${baseUrl}/api/settings/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "github:owner/repo" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /pin/);
});

test("rejects a credentialed git URL", async () => {
  const credentialedUrl = ["https://", "user", ":", "placeholder", "@github.com/o/r.git#abc"].join("");
  const response = await fetch(`${baseUrl}/api/settings/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: credentialedUrl }),
  });
  assert.equal(response.status, 400);
});

test("rejects installing an id that is already installed", async () => {
  const source = localFixture(root, "install-api-duplicate");
  const first = await fetch(`${baseUrl}/api/settings/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  assert.equal(first.status, 201);
  const second = await fetch(`${baseUrl}/api/settings/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  assert.equal(second.status, 409);
});

test("removes an installed plugin, refuses a bundled plugin, and 404s an unknown id", async () => {
  const source = localFixture(root, "install-api-removable");
  const installed = await fetch(`${baseUrl}/api/settings/plugins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source }),
  });
  assert.equal(installed.status, 201);

  const removed = await fetch(`${baseUrl}/api/settings/plugins/install-api-removable`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const afterRemoval = await (await fetch(`${baseUrl}/api/settings/plugins`)).json() as { plugins: Array<{ id: string }> };
  assert.equal(afterRemoval.plugins.some((plugin) => plugin.id === "install-api-removable"), false);
  assert.equal(existsSync(path.join(root, ".vrev/plugins/install-api-removable")), false);

  const bundledRemoval = await fetch(`${baseUrl}/api/settings/plugins/review`, { method: "DELETE" });
  assert.equal(bundledRemoval.status, 409);

  const unknownRemoval = await fetch(`${baseUrl}/api/settings/plugins/does-not-exist`, { method: "DELETE" });
  assert.equal(unknownRemoval.status, 404);
});

test("plugin install and remove routes 404 when plugin management is hidden", async () => {
  const hiddenRoot = mkdtempSync(path.join(os.tmpdir(), "vrev-plugin-install-api-hidden-"));
  mkdirSync(path.join(hiddenRoot, ".git"));
  mkdirSync(path.join(hiddenRoot, ".code/htmls"), { recursive: true });
  mkdirSync(path.join(hiddenRoot, ".vrev"), { recursive: true });
  writeFileSync(path.join(hiddenRoot, ".code/htmls/index.html"), "<h1>Hidden</h1>");
  writeFileSync(path.join(hiddenRoot, ".vrev/settings.json"), JSON.stringify({
    schema_version: 1,
    workspace: { root: ".", monorepo: false },
    ui: { plugin_management: false },
    projects: [],
  }));
  await ensureDefaultPlugins(hiddenRoot);
  const hiddenServer = createVrevServer({ projectRoot: hiddenRoot, target: ".code/htmls/index.html" });
  await new Promise<void>((resolve) => hiddenServer.server.listen(0, "127.0.0.1", resolve));
  try {
    const hiddenAddress = hiddenServer.server.address();
    assert.ok(hiddenAddress && typeof hiddenAddress !== "string");
    const hiddenUrl = `http://127.0.0.1:${hiddenAddress.port}`;
    const installResponse = await fetch(`${hiddenUrl}/api/settings/plugins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "pkg" }),
    });
    assert.equal(installResponse.status, 404);
    const removeResponse = await fetch(`${hiddenUrl}/api/settings/plugins/review`, { method: "DELETE" });
    assert.equal(removeResponse.status, 404);
  } finally {
    await hiddenServer.close();
  }
});
