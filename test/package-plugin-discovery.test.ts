import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverPackagePlugins,
  installPlugin,
  installedPluginDirectory,
  listPlugins,
  loadPluginCommand,
} from "../src/index.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-package-discovery-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

function writePackage(root: string, name: string, options: { id?: string; metadata?: unknown; marker?: string } = {}): string {
  const directory = path.join(root, "node_modules", ...name.split("/"));
  const pluginDirectory = path.join(directory, "plugin");
  mkdirSync(pluginDirectory, { recursive: true });
  const id = options.id ?? name.replace(/^@[^/]+\//, "");
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    name,
    version: "1.0.0",
    visualReview: options.metadata ?? { apiVersion: 1, manifest: "./plugin/visual-review.plugin.json" },
  }));
  writeFileSync(path.join(pluginDirectory, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 1,
    id,
    version: "1.0.0",
    commands: [{ name: "run", module: "./index.js" }],
  }));
  writeFileSync(path.join(pluginDirectory, "index.js"), options.marker
    ? `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(options.marker)}, "evaluated"); export default () => undefined;\n`
    : "export default () => undefined;\n");
  return pluginDirectory;
}

test("discovers direct dependency sections with Node resolution, including third-party scopes, without evaluating code", async () => {
  const root = workspace();
  const marker = path.join(root, "evaluated");
  const runtimeDirectory = writePackage(root, "@third-party/review-plugin", { id: "scoped-plugin", marker });
  writePackage(root, "dev-review-plugin", { id: "dev-plugin" });
  writePackage(root, "optional-review-plugin", { id: "optional-plugin" });
  writePackage(root, "transitive-review-plugin", { id: "must-not-be-discovered" });
  const ordinary = path.join(root, "node_modules", "ordinary-package");
  mkdirSync(ordinary, { recursive: true });
  writeFileSync(path.join(ordinary, "package.json"), JSON.stringify({ name: "ordinary-package", version: "1.0.0", dependencies: { "transitive-review-plugin": "1.0.0" } }));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({
    dependencies: { "@third-party/review-plugin": "1.0.0", "ordinary-package": "1.0.0" },
    devDependencies: { "dev-review-plugin": "1.0.0" },
    optionalDependencies: { "optional-review-plugin": "1.0.0", "missing-optional-package": "1.0.0" },
  }));

  const discovered = discoverPackagePlugins(root);
  assert.deepEqual(discovered.map(({ id }) => id), ["scoped-plugin", "dev-plugin", "optional-plugin"]);
  assert.equal(existsSync(marker), false);
  assert.equal(installedPluginDirectory("scoped-plugin", root), realpathSync(runtimeDirectory));

  await loadPluginCommand("scoped-plugin", "run", root);
  assert.equal(existsSync(marker), true);
});

test("validates package visualReview API and manifest paths", () => {
  const root = workspace();
  writePackage(root, "bad-api", { metadata: { apiVersion: 2, manifest: "./plugin/visual-review.plugin.json" } });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "bad-api": "1.0.0" } }));
  assert.throws(() => discoverPackagePlugins(root), /apiVersion must be 1/);

  writePackage(root, "bad-path", { metadata: { apiVersion: 1, manifest: "../visual-review.plugin.json" } });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "bad-path": "1.0.0" } }));
  assert.throws(() => discoverPackagePlugins(root), /manifest path is invalid/);
});

test("listPlugins explicitly rejects duplicate ids across package discovery and the legacy registry", async () => {
  const root = workspace();
  const legacy = path.join(root, "legacy");
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, "visual-review.plugin.json"), JSON.stringify({ schema_version: 1, id: "duplicate", version: "1.0.0" }));
  await installPlugin(legacy, root);

  writePackage(root, "package-plugin", { id: "duplicate" });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "package-plugin": "1.0.0" } }));
  assert.throws(() => listPlugins(root), /duplicate plugin id duplicate/);
});
