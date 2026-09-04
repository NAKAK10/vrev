import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import { loadPluginUiSurface, parsePluginBridgeContract, parsePluginManifest, parsePluginUiDocument } from "../src/index.js";

const pluginRoot = fileURLToPath(new URL("../../plugins/page-map", import.meta.url));

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-page-map-"));
  return root;
}

test("page-map manifest parses as a valid schema-v4 manifest", () => {
  const manifest = JSON.parse(readFileSync(path.join(pluginRoot, "vrev.plugin.json"), "utf8")) as unknown;
  const parsed = parsePluginManifest(manifest);
  assert.equal(parsed.id, "page-map");
  assert.equal(parsed.schema_version, 4);
  assert.deepEqual(parsed.requires?.map(({ capability }) => capability), ["review"]);
  assert.deepEqual(parsed.provides?.map(({ capability }) => capability), ["page-map"]);
});

test("page-map server.contract.json parses under the bounded bridge-contract schema", () => {
  const contract = JSON.parse(readFileSync(path.join(pluginRoot, "server.contract.json"), "utf8")) as unknown;
  const parsed = parsePluginBridgeContract(contract);
  assert.deepEqual(parsed.queries.map(({ name }) => name), ["page-map.get"]);
  assert.deepEqual(parsed.commands.map(({ name }) => name), ["page-map.refresh"]);
  assert.deepEqual(parsed.queries[0]?.resources, ["page-map"]);
  assert.deepEqual(parsed.commands[0]?.invalidates, ["page-map"]);
});

test("page-map ui/stage.ui.json parses as a valid plugin UI document", () => {
  const bytes = readFileSync(path.join(pluginRoot, "ui/stage.ui.json"));
  const document = parsePluginUiDocument(JSON.parse(bytes.toString("utf8")), bytes.byteLength);
  assert.equal(document.schema_version, 1);
  assert.deepEqual(document.resources?.map((resource) => (resource as { id: string }).id), ["page-map"]);
});

test("page-map is auto-installed as a default plugin and contributes a review.stage", async () => {
  const root = workspace();
  await ensureDefaultPlugins(root);
  const surface = loadPluginUiSurface(root);
  const stage = surface.contributions.find(({ plugin_id, id }) => plugin_id === "page-map" && id === "page-map-stage");
  assert.ok(stage);
  assert.equal(stage?.slot, "review.stage");
  assert.equal(stage?.title, "画面遷移マップ");
  assert.ok(stage?.browser_module_url);
  assert.deepEqual(surface.diagnostics.filter(({ plugin_id }) => plugin_id === "page-map"), []);
});
