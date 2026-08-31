import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import {
  createPluginScaffold,
  effectivePluginSettings,
  installPlugin,
  listPlugins,
  loadPluginAnnotationFlowProvider,
  loadPluginCommand,
  loadPluginIssueProvider,
  loadPluginStorageProvider,
  loadTrustedPluginAnnotationFlowProvider,
  parsePluginBridgeContract,
  parsePluginManifest,
  parsePluginUiDocument,
  pluginSettingsRevision,
  readPluginSettings,
  removePlugin,
  updatePluginSettings,
} from "../src/index.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-plugins-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

const trustedBundledRoot = new URL("../src/bundled-plugins", import.meta.url).pathname;

function bundledFixture(idsToDowngrade: string[] = []): string {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "visual-review-bundled-"));
  cpSync(trustedBundledRoot, fixture, { recursive: true });
  for (const id of idsToDowngrade) {
    const manifestPath = path.join(fixture, id, "visual-review.plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.schema_version = 3;
    delete manifest.server;
    delete manifest.ui;
    delete manifest.requires;
    delete manifest.provides;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return fixture;
}

function restoreBundledPlugin(fixture: string, id: string): void {
  const destination = path.join(fixture, id);
  rmSync(destination, { recursive: true, force: true });
  cpSync(path.join(trustedBundledRoot, id), destination, { recursive: true });
}

function localPlugin(root: string, id = "example-plugin"): string {
  const directory = path.join(root, "plugins", id);
  mkdirSync(path.join(directory, "dist"), { recursive: true });
  writeFileSync(path.join(directory, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 1,
    id,
    version: "1.2.3",
    commands: [{ name: "hello", module: "./dist/plugin.js", export: "run" }],
    storage_provider: { module: "./dist/plugin.js" },
    issue_provider: { module: "./dist/plugin.js", export: "issues" },
  }));
  writeFileSync(path.join(directory, "dist/plugin.js"), `
    import { writeFileSync } from "node:fs";
    writeFileSync(new URL("./evaluated", import.meta.url), "yes");
    export async function run(context) { context.args.push?.("handled"); }
    export default { kind: "test-storage" };
    export const issues = { async createIssue(_root, _draft) { return { url: "https://github.com/example/project/issues/1" }; } };
  `);
  return directory;
}

test("creates a one-level plugin base that can be installed and executed", async () => {
  const root = workspace();
  const scaffold = createPluginScaffold("example-base", root);
  assert.match(scaffold.directory, /\/plugins\/example-base$/);
  assert.equal(existsSync(path.join(scaffold.directory, "visual-review.plugin.json")), true);
  assert.equal(existsSync(path.join(scaffold.directory, "package.json")), true);
  const manifest = JSON.parse(readFileSync(path.join(scaffold.directory, "visual-review.plugin.json"), "utf8")) as { schema_version: number; display: { title: string; readme: string }; configuration: unknown[] };
  assert.equal(manifest.schema_version, 3);
  assert.equal(manifest.display.title, "example-base");
  assert.equal(manifest.display.readme, "./README.md");
  assert.deepEqual(manifest.configuration, []);
  assert.throws(() => createPluginScaffold("example-base", root), /already exists/);

  await installPlugin(scaffold.directory, root);
  const args = ["world"];
  const loaded = await loadPluginCommand("example-base", "hello", root);
  await loaded.handler({ workspaceRoot: root, pluginDirectory: scaffold.directory, args });
  assert.equal(loaded.manifest.id, "example-base");
});

test("installs a one-level nested local plugin without evaluating it, then loads declared exports", async () => {
  const root = workspace();
  const source = localPlugin(root);
  const result = await installPlugin(source, root);
  const installedModuleDirectory = path.join(result.directory, "dist");
  assert.equal(result.plugin.id, "example-plugin");
  assert.equal(existsSync(path.join(installedModuleDirectory, "evaluated")), false);
  assert.deepEqual(listPlugins(root).map(({ id, version }) => ({ id, version })), [{ id: "example-plugin", version: "1.2.3" }]);
  const registry = JSON.parse(readFileSync(path.join(root, ".vreview/plugins.json"), "utf8")) as { schema_version: number };
  assert.equal(registry.schema_version, 1);
  const ignores = readFileSync(path.join(root, ".vreview/.gitignore"), "utf8");
  assert.match(ignores, /^plugins\/$/m);
  assert.match(ignores, /^plugins\.json$/m);
  assert.match(ignores, /^plugin-settings\.json$/m);
  assert.match(ignores, /^custom-commands\.json$/m);

  const loadedCommand = await loadPluginCommand("example-plugin", "hello", root);
  assert.equal(typeof loadedCommand.handler, "function");
  assert.equal(existsSync(path.join(installedModuleDirectory, "evaluated")), true);
  const loadedStorage = await loadPluginStorageProvider<{ kind: string }>("example-plugin", root);
  assert.equal(loadedStorage.provider.kind, "test-storage");
  const loadedIssues = await loadPluginIssueProvider("example-plugin", root);
  assert.deepEqual(await loadedIssues.provider.createIssue(root, { title: "Title", body: "Body" }), { url: "https://github.com/example/project/issues/1" });

  removePlugin("example-plugin", root);
  assert.deepEqual(listPlugins(root), []);
  assert.equal(existsSync(result.directory), false);
});

test("parses schema-v4 server and independent UI contributions without evaluating modules", async () => {
  const root = workspace();
  const source = path.join(root, "plugins/v4-plugin");
  mkdirSync(path.join(source, "dist"), { recursive: true });
  mkdirSync(path.join(source, "ui"), { recursive: true });
  writeFileSync(path.join(source, "README.md"), "# V4\n");
  writeFileSync(path.join(source, "server.contract.json"), JSON.stringify({ schema_version: 1, queries: [], commands: [] }));
  writeFileSync(path.join(source, "ui/main.json"), JSON.stringify({ schema_version: 1, root: { type: "app-shell", children: [] } }));
  writeFileSync(path.join(source, "dist/server.js"), "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./evaluated', import.meta.url), 'yes'); export default {};\n");
  writeFileSync(path.join(source, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 4,
    id: "v4-plugin",
    version: "1.0.0",
    display: { title: "V4", summary: "Schema v4 fixture", readme: "./README.md" },
    configuration: [],
    server: { api_version: 1, bridge_api_version: 1, module: "./dist/server.js", contract: "./server.contract.json" },
    ui: { renderer_api_version: 1, bridge_api_version: 1, contributions: [{ id: "main", slot: "review.main", document: "./ui/main.json", order: 100 }] },
    requires: [{ capability: "host.target", api_version: 1, optional: false }],
    provides: [{ capability: "review", api_version: 1 }],
  }));

  await installPlugin(source, root);
  assert.equal(existsSync(path.join(root, ".vreview/plugins/v4-plugin/dist/evaluated")), false);
  const manifest = listPlugins(root)[0]!.manifest;
  assert.equal(manifest.schema_version, 4);
  assert.equal(manifest.server?.contract, "./server.contract.json");
  assert.deepEqual(manifest.ui?.contributions.map(({ id, slot }) => ({ id, slot })), [{ id: "main", slot: "review.main" }]);
});

test("rejects invalid schema-v4 paths, slots, versions, and duplicate capabilities", () => {
  const base = {
    schema_version: 4,
    id: "invalid-v4",
    version: "1.0.0",
    display: { title: "Invalid", summary: "Invalid fixture", readme: "./README.md" },
    configuration: [],
  };
  assert.throws(() => parsePluginManifest({ ...base, server: { api_version: 1, bridge_api_version: 1, module: "./index.js", contract: "../contract.json" } }), /contract/);
  assert.throws(() => parsePluginManifest({ ...base, ui: { renderer_api_version: 1, bridge_api_version: 1, contributions: [{ id: "main", slot: "unknown", document: "./ui.json", order: 0 }] } }), /slot/);
  assert.throws(() => parsePluginManifest({ ...base, server: { api_version: 2, bridge_api_version: 1, module: "./index.js", contract: "./contract.json" } }), /api_version/);
  assert.throws(() => parsePluginManifest({ ...base, commands: [{ name: "run", module: "./index.js" }], requires: [
    { capability: "host.target", api_version: 1, optional: false },
    { capability: "host.target", api_version: 1, optional: true },
  ] }), /duplicated/);
});

test("validates static bridge contracts with bounded exact JSON schemas", () => {
  const objectSchema = { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"], additionalProperties: false };
  const contract = parsePluginBridgeContract({
    schema_version: 1,
    queries: [{ name: "session.get", permission: "review.read", input_schema: { type: "object", properties: {}, additionalProperties: false }, output_schema: objectSchema, resources: ["session"] }],
    commands: [{ name: "annotation.resolve", permission: "review.write", input_schema: objectSchema, output_schema: objectSchema, invalidates: ["session", "archive"] }],
  });
  assert.equal(contract.queries[0]?.name, "session.get");
  assert.throws(() => parsePluginBridgeContract({ schema_version: 1, queries: [], commands: [{ name: "run", permission: "review.write", input_schema: { type: "object", properties: {}, additionalProperties: true }, output_schema: objectSchema, invalidates: [] }] }), /additionalProperties/);
  assert.throws(() => parsePluginBridgeContract({ schema_version: 1, queries: [{ name: "get", permission: "review.read", input_schema: objectSchema, output_schema: objectSchema, resources: ["bad/path"] }], commands: [] }), /resources/);
});

test("validates bounded declarative UI documents and rejects executable fields", () => {
  const parsed = parsePluginUiDocument({
    schema_version: 1,
    local_state: [{ key: "viewport", type: "enum", default: "desktop" }],
    resources: [{ id: "session", query: "session.get", input: {} }],
    root: { type: "app-shell", children: [{ id: "save", type: "button", props: { variant: { literal: "primary" } } }] },
  });
  assert.equal(parsed.root.children?.[0]?.type, "button");
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "script" } }), /unsupported/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "text", props: { innerHTML: "<img>" } } }), /forbidden/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "button", onClick: "run()" } }), /unsupported field/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "text" } }, 600 * 1024), /too large/);
});

test("rejects malformed manifests, escaping module paths, and symlinks", async () => {
  const root = workspace();
  const malformed = path.join(root, "plugins/malformed");
  mkdirSync(malformed, { recursive: true });
  writeFileSync(path.join(malformed, "visual-review.plugin.json"), JSON.stringify({ schema_version: 1, id: "malformed", version: "1.0.0", commands: [{ name: "bad", module: "../outside.js" }] }));
  await assert.rejects(installPlugin(malformed, root), /module/);

  const linked = localPlugin(root, "linked-plugin");
  symlinkSync(path.join(linked, "dist/plugin.js"), path.join(linked, "linked.js"));
  await assert.rejects(installPlugin(linked, root), /symbolic link/);
  assert.deepEqual(listPlugins(root), []);
});

test("installs an npm package spec through npm pack", async () => {
  const root = workspace();
  const packageDirectory = path.join(root, "npm-source");
  mkdirSync(packageDirectory);
  writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ name: "visual-review-test-plugin", version: "1.0.0", type: "module", files: ["visual-review.plugin.json", "index.js"] }));
  writeFileSync(path.join(packageDirectory, "visual-review.plugin.json"), JSON.stringify({ schema_version: 1, id: "packed-plugin", version: "1.0.0", commands: [{ name: "run", module: "./index.js" }] }));
  writeFileSync(path.join(packageDirectory, "index.js"), "export default () => undefined;\n");

  const result = await installPlugin(`file:${packageDirectory}`, root);
  assert.equal(result.plugin.id, "packed-plugin");
  assert.equal(result.plugin.source, `file:${packageDirectory}`);
  assert.equal(existsSync(path.join(result.directory, "index.js")), true);
});

test("does not overwrite an installed plugin id or persist credentialed sources", async () => {
  const root = workspace();
  const source = localPlugin(root);
  await installPlugin(source, root);
  await assert.rejects(installPlugin(source, root), /already installed/);
  const credentialedUrl = ["https://", "user", ":", "placeholder", "@example.com/plugin.tgz"].join("");
  const credentialQueryUrl = ["https://example.com/plugin.tgz?access_", "token=", "placeholder"].join("");
  await assert.rejects(installPlugin(credentialedUrl, root), /credentials/);
  await assert.rejects(installPlugin(credentialQueryUrl, root), /credential parameters/);
  assert.equal(listPlugins(root).length, 1);
});

test("reloads changed plugin code after an explicit remove and reinstall", async () => {
  const root = workspace();
  const source = localPlugin(root, "reload-plugin");
  await installPlugin(source, root);
  const firstArgs: string[] = [];
  await (await loadPluginCommand("reload-plugin", "hello", root)).handler({ workspaceRoot: root, pluginDirectory: source, args: firstArgs });
  assert.deepEqual(firstArgs, ["handled"]);

  removePlugin("reload-plugin", root);
  writeFileSync(path.join(source, "dist/plugin.js"), "export function run(context) { context.args.push('updated'); }\nexport default {};\n");
  await installPlugin(source, root);
  const secondArgs: string[] = [];
  await (await loadPluginCommand("reload-plugin", "hello", root)).handler({ workspaceRoot: root, pluginDirectory: source, args: secondArgs });
  assert.deepEqual(secondArgs, ["updated"]);
});

test("integrates install, list, run, and remove with the built CLI", () => {
  const root = workspace();
  const source = localPlugin(root, "cli-plugin");
  const cli = new URL("../src/cli.js", import.meta.url);
  const invoke = (...args: string[]) => spawnSync(process.execPath, [cli.pathname, "plugin", ...args], { cwd: root, encoding: "utf8" });
  const installed = invoke("install", source);
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installed cli-plugin@1\.2\.3/);
  const listed = invoke("list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /cli-plugin\s+1\.2\.3/);
  const run = invoke("run", "cli-plugin", "hello", "one", "two");
  assert.equal(run.status, 0, run.stderr);
  const removed = invoke("remove", "cli-plugin");
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Removed cli-plugin/);
});

test("CLI plugin create help documents the schema-v3 template", () => {
  const cli = new URL("../src/cli.js", import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname, "plugin", "create", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /schema v3/);
  assert.match(result.stdout, /configuration template/);
  assert.match(result.stdout, /source=environment/);
});

test("CLI creates and immediately installs a plugin base", () => {
  const root = workspace();
  const cli = new URL("../src/cli.js", import.meta.url);
  const created = spawnSync(process.execPath, [cli.pathname, "plugin", "create", "created-plugin", "--title", "Created Plugin", "--summary", "Generated for tests", "--install"], { cwd: root, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Created created-plugin/);
  assert.match(created.stdout, /Installed created-plugin@0\.1\.0/);
  assert.equal(existsSync(path.join(root, "plugins/created-plugin/README.md")), true);
  const manifest = JSON.parse(readFileSync(path.join(root, "plugins/created-plugin/visual-review.plugin.json"), "utf8")) as { display: { title: string; summary: string } };
  assert.deepEqual(manifest.display, { title: "Created Plugin", summary: "Generated for tests", readme: "./README.md" });
  const run = spawnSync(process.execPath, [cli.pathname, "plugin", "run", "created-plugin", "hello", "world"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Hello from created-plugin: world/);
});

test("automatically installs bundled default plugins once per workspace", async () => {
  const root = workspace();
  assert.deepEqual(await ensureDefaultPlugins(root), ["review@1.1.3", "github-issue@1.1.3", "custom-command@1.1.3", "annotation-workflow@1.1.3"]);
  const defaults = listPlugins(root);
  assert.deepEqual(defaults.map(({ id }) => id), ["review", "github-issue", "custom-command", "annotation-workflow"]);
  const expectedVersions = new Map([
    ["review", "1.1.3"],
    ["github-issue", "1.1.3"],
    ["custom-command", "1.1.3"],
    ["annotation-workflow", "1.1.3"],
  ]);
  for (const plugin of defaults) {
    const packageJson = JSON.parse(readFileSync(path.join(root, ".vreview/plugins", plugin.id, "package.json"), "utf8")) as { version: string };
    assert.equal(plugin.version, expectedVersions.get(plugin.id));
    assert.equal(packageJson.version, plugin.version);
  }
  assert.ok(defaults.every(({ manifest }) => effectivePluginSettings(manifest, root).enabled));
  assert.deepEqual(await ensureDefaultPlugins(root), []);
  assert.equal(typeof (await loadPluginIssueProvider("github-issue", root)).provider.createIssue, "function");
  assert.equal(typeof (await loadPluginCommand("custom-command", "custom-command", root)).handler, "function");
  const flow = await loadPluginAnnotationFlowProvider("annotation-workflow", root);
  assert.deepEqual(flow.policy.events, ["annotation-created", "annotation-reopened"]);
  assert.equal(flow.policy.debounceMs, 300);
  assert.equal(flow.policy.settings.runner.label, "CLI");
  assert.equal(flow.policy.settings.maxParallel.max, 10);
  assert.match(flow.policy.settings.autoRun.label, /自動/);
  assert.equal(existsSync(path.join(root, ".vreview/plugins/annotation-workflow/package.json")), true);
  assert.equal(existsSync(path.join(root, ".vreview/plugins/review/server/review-store.js")), true);
  const review = defaults.find(({ id }) => id === "review")!;
  assert.equal(review.manifest.schema_version, 4);
  assert.deepEqual(review.manifest.provides, [{ capability: "review", api_version: 1 }]);
});

test("upgrades proven schema-v3 bundled defaults while preserving workspace data", async () => {
  const root = workspace();
  const bundledRoot = bundledFixture(["github-issue", "custom-command", "annotation-workflow"]);
  await ensureDefaultPlugins(root, bundledRoot);
  assert.deepEqual(listPlugins(root).filter(({ id }) => id !== "review").map(({ manifest }) => manifest.schema_version), [3, 3, 3]);

  const customCommand = listPlugins(root).find(({ id }) => id === "custom-command")!;
  updatePluginSettings("custom-command", customCommand.manifest, {
    revision: pluginSettingsRevision(readPluginSettings(root)),
    enabled: false,
    configuration: {},
  }, root);
  const settingsBefore = readFileSync(path.join(root, ".vreview/plugin-settings.json"), "utf8");
  const commandsBefore = `${JSON.stringify({ schema_version: 1, runners: [{ runner_id: "kept", command: "agent" }] }, null, 2)}\n`;
  writeFileSync(path.join(root, ".vreview/custom-commands.json"), commandsBefore);

  for (const id of ["github-issue", "custom-command", "annotation-workflow"]) restoreBundledPlugin(bundledRoot, id);
  assert.deepEqual(await ensureDefaultPlugins(root, bundledRoot), ["github-issue@1.1.3", "custom-command@1.1.3", "annotation-workflow@1.1.3"]);
  assert.deepEqual(listPlugins(root).filter(({ id }) => id !== "review").map(({ manifest }) => manifest.schema_version), [4, 4, 4]);
  assert.equal(readFileSync(path.join(root, ".vreview/plugin-settings.json"), "utf8"), settingsBefore);
  assert.equal(readFileSync(path.join(root, ".vreview/custom-commands.json"), "utf8"), commandsBefore);
});

test("upgrades same-schema trusted bundled UI when its SemVer is older", async () => {
  const root = workspace();
  const bundledRoot = bundledFixture();
  const reviewRoot = path.join(bundledRoot, "review");
  const manifestPath = path.join(reviewRoot, "visual-review.plugin.json");
  const packagePath = path.join(reviewRoot, "package.json");
  const uiPath = path.join(reviewRoot, "ui/review.ui.json");
  const oldManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { schema_version: number; version: string };
  const oldPackage = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
  oldManifest.version = "1.0.0";
  oldPackage.version = "1.0.0";
  writeFileSync(manifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`);
  writeFileSync(packagePath, `${JSON.stringify(oldPackage, null, 2)}\n`);
  writeFileSync(uiPath, `${JSON.stringify({ schema_version: 1, root: { type: "text", props: { text: { literal: "stale bundled UI" } } } }, null, 2)}\n`);

  assert.deepEqual(await ensureDefaultPlugins(root, bundledRoot), ["review@1.0.0", "github-issue@1.1.3", "custom-command@1.1.3", "annotation-workflow@1.1.3"]);
  assert.match(readFileSync(path.join(root, ".vreview/plugins/review/ui/review.ui.json"), "utf8"), /stale bundled UI/);
  assert.equal(listPlugins(root).find(({ id }) => id === "review")?.manifest.schema_version, 4);

  restoreBundledPlugin(bundledRoot, "review");
  assert.deepEqual(await ensureDefaultPlugins(root, bundledRoot), ["review@1.1.3"]);
  assert.equal(readFileSync(path.join(root, ".vreview/plugins/review/ui/review.ui.json"), "utf8"), readFileSync(path.join(trustedBundledRoot, "review/ui/review.ui.json"), "utf8"));
  assert.equal(listPlugins(root).find(({ id }) => id === "review")?.version, "1.1.3");
});

test("preserves a local same-ID install instead of treating it as a bundled default", async () => {
  const root = workspace();
  const source = localPlugin(root, "github-issue");
  await installPlugin(source, root);
  const bundledRoot = bundledFixture();

  await ensureDefaultPlugins(root, bundledRoot);
  const installed = listPlugins(root).find(({ id }) => id === "github-issue")!;
  assert.equal(installed.source, source);
  assert.equal(installed.version, "1.2.3");
  assert.match(readFileSync(path.join(root, ".vreview/plugins/github-issue/dist/plugin.js"), "utf8"), /handled/);
});

test("fails closed for a tampered installed manifest and never evaluates a tampered module", async () => {
  const manifestRoot = workspace();
  const manifestBundle = bundledFixture(["github-issue"]);
  await ensureDefaultPlugins(manifestRoot, manifestBundle);
  restoreBundledPlugin(manifestBundle, "github-issue");
  const installedManifestPath = path.join(manifestRoot, ".vreview/plugins/github-issue/visual-review.plugin.json");
  const tampered = JSON.parse(readFileSync(installedManifestPath, "utf8")) as { display: { summary: string } };
  tampered.display.summary = "locally changed";
  writeFileSync(installedManifestPath, JSON.stringify(tampered));
  assert.deepEqual(await ensureDefaultPlugins(manifestRoot, manifestBundle), []);
  assert.equal((JSON.parse(readFileSync(installedManifestPath, "utf8")) as { schema_version: number }).schema_version, 3);

  const moduleRoot = workspace();
  const moduleBundle = bundledFixture(["annotation-workflow"]);
  await ensureDefaultPlugins(moduleRoot, moduleBundle);
  restoreBundledPlugin(moduleBundle, "annotation-workflow");
  const marker = path.join(moduleRoot, "tampered-module-evaluated");
  const modulePath = path.join(moduleRoot, ".vreview/plugins/annotation-workflow/index.js");
  writeFileSync(modulePath, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad");\nexport default {};\n`);
  assert.deepEqual(await ensureDefaultPlugins(moduleRoot, moduleBundle), ["annotation-workflow@1.1.3"]);
  assert.equal(existsSync(marker), false);
  assert.equal((JSON.parse(readFileSync(path.join(moduleRoot, ".vreview/plugins/annotation-workflow/visual-review.plugin.json"), "utf8")) as { schema_version: number }).schema_version, 4);
});

test("serializes concurrent bundled upgrades and leaves same-version installs untouched", async () => {
  const root = workspace();
  const bundledRoot = bundledFixture(["github-issue", "custom-command", "annotation-workflow"]);
  await ensureDefaultPlugins(root, bundledRoot);
  for (const id of ["github-issue", "custom-command", "annotation-workflow"]) restoreBundledPlugin(bundledRoot, id);

  const results = await Promise.all([ensureDefaultPlugins(root, bundledRoot), ensureDefaultPlugins(root, bundledRoot)]);
  assert.equal(results.flat().length, 3);
  const installedAt = listPlugins(root).map(({ id, installed_at }) => [id, installed_at]);
  assert.deepEqual(await ensureDefaultPlugins(root, bundledRoot), []);
  assert.deepEqual(listPlugins(root).map(({ id, installed_at }) => [id, installed_at]), installedAt);
});

test("disabled plugin state persists separately from installation and gates runtime loading", async () => {
  const root = workspace();
  await ensureDefaultPlugins(root);
  const plugin = listPlugins(root).find(({ id }) => id === "custom-command")!;
  const settings = readPluginSettings(root);
  const updated = updatePluginSettings("custom-command", plugin.manifest, {
    revision: pluginSettingsRevision(settings),
    enabled: false,
    configuration: {},
  }, root);
  assert.equal(updated.effective.enabled, false);
  assert.equal(listPlugins(root).some(({ id }) => id === "custom-command"), true);
  await assert.rejects(loadPluginCommand("custom-command", "custom-command", root), /plugin is disabled/);
  assert.deepEqual(await ensureDefaultPlugins(root), []);
});

test("automatic annotation workflow rejects a tampered workspace copy before evaluation", async () => {
  const root = workspace();
  await ensureDefaultPlugins(root);
  const marker = path.join(root, "plugin-evaluated");
  writeFileSync(path.join(root, ".vreview/plugins/annotation-workflow/index.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "bad");\nexport default { apiVersion: 1, policy() { return { events: ["annotation-created"], debounceMs: 0 }; } };\n`);
  const trusted = new URL("../src/bundled-plugins/annotation-workflow", import.meta.url).pathname;
  await assert.rejects(loadTrustedPluginAnnotationFlowProvider("annotation-workflow", trusted, root), /does not match the bundled module/);
  assert.equal(existsSync(marker), false);
});

test("concurrent default bootstrap accepts a verified winner", async () => {
  const root = workspace();
  const results = await Promise.all([ensureDefaultPlugins(root), ensureDefaultPlugins(root)]);
  assert.equal(results.flat().length, 4);
  assert.deepEqual(listPlugins(root).map(({ id }) => id).sort(), ["annotation-workflow", "custom-command", "github-issue", "review"]);
});

test("installs and dispatches the bundled custom-command and Firebase sample plugins", () => {
  const root = workspace();
  const cli = new URL("../src/cli.js", import.meta.url);
  const customSource = new URL("../../plugins/custom-command", import.meta.url).pathname;
  const firebaseSource = new URL("../../plugins/firebase-storage", import.meta.url).pathname;
  const invoke = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [cli.pathname, "plugin", ...args], { cwd: root, encoding: "utf8", env });

  assert.equal(invoke(["install", customSource]).status, 0);
  const customList = invoke(["run", "custom-command", "custom-command", "list"]);
  assert.equal(customList.status, 0, customList.stderr);
  assert.match(customList.stdout, /No custom commands/);

  assert.equal(invoke(["install", firebaseSource]).status, 0);
  const dryRun = invoke(["run", "firebase-storage", "push", "--dry-run"], { ...process.env, FIREBASE_PROJECT_ID: "example-project" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Would push 0 file\(s\)/);
});
