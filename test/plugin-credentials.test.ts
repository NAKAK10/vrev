import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  createVisualReviewServer,
  deletePluginCredential,
  installPlugin,
  loadPluginCommand,
  loadPluginStorageProvider,
  parsePluginManifest,
  pluginCredentialsPath,
  pluginRuntimeContext,
  readPluginCredentialPresence,
  readPluginCredentials,
  setPluginCredential,
  updatePluginSettings,
  readPluginSettings,
  pluginSettingsRevision,
  type VisualReviewServer,
} from "../src/index.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-credentials-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

const baseManifestFields = {
  schema_version: 3 as const,
  id: "credential-fixture",
  version: "1.0.0",
  display: { title: "Credential fixture", summary: "テスト用fixture", readme: "./README.md" },
};

test("manifest validation accepts a well-formed credential field and rejects malformed combinations", () => {
  const valid = parsePluginManifest({
    ...baseManifestFields,
    configuration: [
      { key: "service_account_key", title: "Key", type: "secret", source: "credential", required: false, format: "json" },
    ],
  });
  assert.equal(valid.configuration?.[0]?.type, "secret");
  assert.equal(valid.configuration?.[0]?.source, "credential");
  assert.equal(valid.configuration?.[0]?.format, "json");

  const textFormatDefaultsAbsent = parsePluginManifest({
    ...baseManifestFields,
    configuration: [{ key: "token", title: "Token", type: "secret", source: "credential", required: false }],
  });
  assert.equal("format" in (textFormatDefaultsAbsent.configuration?.[0] ?? {}), false);

  const cases: Array<[string, Record<string, unknown>]> = [
    ["type secret without source credential", { key: "a", title: "A", type: "secret", source: "workspace", required: false }],
    ["source credential without type secret", { key: "a", title: "A", type: "string", source: "credential", required: false }],
    ["credential with a default", { key: "a", title: "A", type: "secret", source: "credential", required: false, default: "x" }],
    ["credential with options", { key: "a", title: "A", type: "secret", source: "credential", required: false, options: [{ value: "x", label: "X" }] }],
    ["credential with environment", { key: "a", title: "A", type: "secret", source: "credential", required: false, environment: "A" }],
    ["format on a non-credential field", { key: "a", title: "A", type: "string", source: "workspace", required: false, format: "json" }],
    ["invalid format value", { key: "a", title: "A", type: "secret", source: "credential", required: false, format: "xml" }],
  ];
  for (const [label, field] of cases) {
    assert.throws(() => parsePluginManifest({ ...baseManifestFields, configuration: [field] }), Error, label);
  }
});

function credentialFixturePlugin(root: string): string {
  const directory = path.join(root, "plugins", "credential-fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "visual-review.plugin.json"), JSON.stringify({
    ...baseManifestFields,
    configuration: [
      { key: "api_key", title: "API key", description: "text credential", type: "secret", source: "credential", required: false, format: "text" },
      { key: "config_json", title: "Config", description: "json credential", type: "secret", source: "credential", required: true, format: "json" },
    ],
    commands: [{ name: "dump", module: "./index.mjs", export: "dumpCommand" }],
    storage_provider: { api_version: 1, module: "./index.mjs", export: "createProviderFromContext" },
  }));
  writeFileSync(path.join(directory, "README.md"), "# Credential fixture\n");
  writeFileSync(path.join(directory, "index.mjs"), `
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    export async function dumpCommand(context) {
      const debugPath = path.join(context.workspaceRoot, "debug-context.json");
      writeFileSync(debugPath, JSON.stringify({ args: context.args, credentials: context.credentials, configuration: context.configuration }));
    }
    export function createProviderFromContext(context) {
      return {
        apiVersion: 1,
        contextSeen: { credentials: context.credentials, configuration: context.configuration, workspaceRoot: context.workspaceRoot },
        async list() { return []; },
        async read() { return null; },
        async compareAndSwap() { return { version: "v1" }; },
        async delete() {},
      };
    }
  `);
  return directory;
}

test("plugin-credentials store: set/read/delete/presence, file modes, symlink rejection, and gitignore entry", () => {
  const root = workspace();
  setPluginCredential("credential-fixture", "api_key", "secret-value-1", root);
  const filePath = pluginCredentialsPath("credential-fixture", root);
  assert.equal(existsSync(filePath), true);

  const presence = readPluginCredentialPresence("credential-fixture", root);
  assert.equal(presence.api_key?.present, true);
  assert.equal(typeof presence.api_key?.updated_at, "string");
  assert.equal(presence.api_key?.fingerprint.length, 8);
  assert.doesNotMatch(JSON.stringify(presence), /secret-value-1/);

  const values = readPluginCredentials("credential-fixture", root, ["api_key", "config_json"]);
  assert.deepEqual(values, { api_key: "secret-value-1" });

  if (process.platform !== "win32") {
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(filePath)).mode & 0o777, 0o700);
  }

  const ignoreContent = readFileSync(path.join(root, ".vreview", ".gitignore"), "utf8");
  assert.match(ignoreContent, /^credentials\/$/m);

  deletePluginCredential("credential-fixture", "api_key", root);
  assert.deepEqual(readPluginCredentialPresence("credential-fixture", root), {});
  // Deleting an absent value is a no-op, not an error.
  deletePluginCredential("credential-fixture", "api_key", root);
});

test("plugin credential directory and file symlinks are rejected", () => {
  const root = workspace();
  mkdirSync(path.join(root, ".vreview"), { recursive: true });
  const realDir = path.join(root, ".vreview", "real-credentials");
  mkdirSync(realDir, { recursive: true });
  symlinkSync(realDir, path.join(root, ".vreview", "credentials"));
  assert.throws(() => setPluginCredential("credential-fixture", "api_key", "value", root), /symbolic link/);

  const root2 = workspace();
  mkdirSync(path.join(root2, ".vreview", "credentials"), { recursive: true });
  writeFileSync(path.join(root2, ".vreview", "credentials", "real-file.json"), JSON.stringify({ schema_version: 1, values: {} }));
  symlinkSync(path.join(root2, ".vreview", "credentials", "real-file.json"), path.join(root2, ".vreview", "credentials", "credential-fixture.json"));
  assert.throws(() => setPluginCredential("credential-fixture", "api_key", "value", root2), /symbolic link/);
});

test("credential value validation rejects non-strings, oversized values, and NUL characters", () => {
  const root = workspace();
  assert.throws(() => setPluginCredential("credential-fixture", "api_key", 123 as unknown as string, root), /string/);
  assert.throws(() => setPluginCredential("credential-fixture", "api_key", "a".repeat(64 * 1024 + 1), root), /too large/);
  assert.throws(() => setPluginCredential("credential-fixture", "api_key", `bad${String.fromCharCode(0)}value`, root), /NUL/);
  assert.throws(() => setPluginCredential("credential-fixture", "Bad-Key", "value", root), /invalid/);
});

let serverRoot: string;
let server: VisualReviewServer;
let baseUrl: string;

before(async () => {
  serverRoot = workspace();
  mkdirSync(path.join(serverRoot, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(serverRoot, ".code/htmls/index.html"), "<h1>Fixture</h1>");
  const fixtureDirectory = credentialFixturePlugin(serverRoot);
  await installPlugin(fixtureDirectory, serverRoot);
  server = createVisualReviewServer({ projectRoot: serverRoot, target: ".code/htmls/index.html" });
  await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await server.close();
});

test("HTTP credential routes never return the value and expose only presence/fingerprint", async () => {
  const initial = await (await fetch(`${baseUrl}/api/settings/plugins`)).json() as {
    revision: string;
    plugins: Array<{ id: string; configuration: Array<Record<string, unknown>> }>;
  };
  const fixture = initial.plugins.find(({ id }) => id === "credential-fixture");
  assert.ok(fixture);
  const apiKeyField = fixture!.configuration.find((field) => field.key === "api_key")!;
  assert.equal(apiKeyField.present, false);
  assert.equal(apiKeyField.value, null);
  assert.equal(apiKeyField.updated_at, null);
  assert.equal(apiKeyField.fingerprint, null);

  const putResponse = await fetch(`${baseUrl}/api/settings/plugins/credential-fixture/credentials/api_key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "top-secret-api-key-value" }),
  });
  assert.equal(putResponse.status, 200);
  const putPayload = await putResponse.text();
  assert.doesNotMatch(putPayload, /top-secret-api-key-value/);
  const parsedPut = JSON.parse(putPayload) as { plugins: Array<{ id: string; configuration: Array<Record<string, unknown>> }> };
  const updatedField = parsedPut.plugins.find(({ id }) => id === "credential-fixture")!.configuration.find((field) => field.key === "api_key")!;
  assert.equal(updatedField.present, true);
  assert.equal(updatedField.value, null);
  assert.equal(typeof updatedField.fingerprint, "string");
  assert.equal((updatedField.fingerprint as string).length, 8);
  assert.equal(typeof updatedField.updated_at, "string");

  const jsonField = { value: "not-valid-json" };
  const badJsonResponse = await fetch(`${baseUrl}/api/settings/plugins/credential-fixture/credentials/config_json`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(jsonField),
  });
  assert.equal(badJsonResponse.status, 400);

  const goodJsonResponse = await fetch(`${baseUrl}/api/settings/plugins/credential-fixture/credentials/config_json`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify({ some: "object" }) }),
  });
  assert.equal(goodJsonResponse.status, 200);

  const notDeclared = await fetch(`${baseUrl}/api/settings/plugins/credential-fixture/credentials/not_declared`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x" }),
  });
  assert.equal(notDeclared.status, 404);

  const unknownPlugin = await fetch(`${baseUrl}/api/settings/plugins/does-not-exist/credentials/api_key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x" }),
  });
  assert.equal(unknownPlugin.status, 404);

  const deleteResponse = await fetch(`${baseUrl}/api/settings/plugins/credential-fixture/credentials/api_key`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  const afterDelete = await deleteResponse.json() as { plugins: Array<{ id: string; configuration: Array<Record<string, unknown>> }> };
  const deletedField = afterDelete.plugins.find(({ id }) => id === "credential-fixture")!.configuration.find((field) => field.key === "api_key")!;
  assert.equal(deletedField.present, false);

  // Deleting an already-absent credential is a no-op 200, not an error.
  const deleteAgain = await fetch(`${baseUrl}/api/settings/plugins/credential-fixture/credentials/api_key`, { method: "DELETE" });
  assert.equal(deleteAgain.status, 200);
});

test("the plain plugin settings PUT rejects a credential key in the configuration body", async () => {
  const listed = await (await fetch(`${baseUrl}/api/settings/plugins`)).json() as { revision: string };
  const response = await fetch(`${baseUrl}/api/settings/plugins/credential-fixture`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: listed.revision, enabled: true, configuration: { api_key: "sneaking-in-through-the-workspace-put" } }),
  });
  assert.notEqual(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /sneaking-in-through-the-workspace-put/);
});

test("updatePluginSettings (direct call) also rejects a credential key even outside HTTP", () => {
  const manifest = parsePluginManifest(JSON.parse(readFileSync(path.join(serverRoot, ".vreview", "plugins", "credential-fixture", "visual-review.plugin.json"), "utf8")));
  const settings = readPluginSettings(serverRoot);
  const revision = pluginSettingsRevision(settings);
  assert.throws(
    () => updatePluginSettings("credential-fixture", manifest, { revision, enabled: true, configuration: { api_key: "direct-call-secret" } }, serverRoot),
    /invalid/,
  );
});

test("loadPluginStorageProvider calls a function export once with a PluginRuntimeContextV1 containing the credential", async () => {
  setPluginCredential("credential-fixture", "api_key", "provider-context-secret", serverRoot);
  setPluginCredential("credential-fixture", "config_json", JSON.stringify({ a: 1 }), serverRoot);
  const loaded = await loadPluginStorageProvider<{ contextSeen: { credentials: Record<string, string>; configuration: Record<string, unknown>; workspaceRoot: string } }>("credential-fixture", serverRoot);
  assert.equal(loaded.provider.contextSeen.credentials.api_key, "provider-context-secret");
  assert.equal(loaded.provider.contextSeen.credentials.config_json, JSON.stringify({ a: 1 }));
  assert.equal(loaded.provider.contextSeen.workspaceRoot, realpathSync(serverRoot));
});

test("pluginRuntimeContext exposes declared credentials for a plugin", () => {
  setPluginCredential("credential-fixture", "api_key", "runtime-context-secret", serverRoot);
  const context = pluginRuntimeContext("credential-fixture", serverRoot);
  assert.equal(context.credentials.api_key, "runtime-context-secret");
  assert.equal(context.workspaceRoot, realpathSync(serverRoot));
});

test("plugin run delivers credentials through PluginCommandContext, never through argv", async () => {
  setPluginCredential("credential-fixture", "api_key", "argv-must-not-see-this-secret", serverRoot);
  const context = pluginRuntimeContext("credential-fixture", serverRoot);
  const { handler } = await loadPluginCommand("credential-fixture", "dump", serverRoot);
  const args = ["--not-secret", "plain-argument"];
  await handler({
    workspaceRoot: serverRoot,
    pluginDirectory: path.join(serverRoot, ".vreview", "plugins", "credential-fixture"),
    args,
    configuration: context.configuration,
    credentials: context.credentials,
  });
  const debugPath = path.join(serverRoot, "debug-context.json");
  const written = JSON.parse(readFileSync(debugPath, "utf8")) as { args: string[]; credentials: Record<string, string> };
  assert.deepEqual(written.args, args);
  assert.doesNotMatch(JSON.stringify(written.args), /argv-must-not-see-this-secret/);
  assert.equal(written.credentials.api_key, "argv-must-not-see-this-secret");
});
