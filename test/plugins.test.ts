import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createPluginScaffold,
  installPlugin,
  listPlugins,
  loadPluginCommand,
  loadPluginIssueProvider,
  loadPluginStorageProvider,
  removePlugin,
} from "../src/index.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-plugins-"));
  mkdirSync(path.join(root, ".git"));
  return root;
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

test("CLI creates and immediately installs a plugin base", () => {
  const root = workspace();
  const cli = new URL("../src/cli.js", import.meta.url);
  const created = spawnSync(process.execPath, [cli.pathname, "plugin", "create", "created-plugin", "--install"], { cwd: root, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Created created-plugin/);
  assert.match(created.stdout, /Installed created-plugin@0\.1\.0/);
  assert.equal(existsSync(path.join(root, "plugins/created-plugin/README.md")), true);
  const run = spawnSync(process.execPath, [cli.pathname, "plugin", "run", "created-plugin", "hello", "world"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Hello from created-plugin: world/);
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
