import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import * as rootApi from "../src/index.js";
import { JobManager as CompatibilityJobManager } from "../src/job-manager.js";
import { JobStore as CompatibilityJobStore } from "../src/job-store.js";
import { parsePluginManifest } from "../src/plugin-manifest.js";
import { ReviewStore as CompatibilityReviewStore } from "../src/review-store.js";

function manifestBase(schemaVersion: 1 | 2 | 3, id: string): Record<string, unknown> {
  return { schema_version: schemaVersion, id, version: "1.2.3" };
}

async function serverFixture(legacyUi = false): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "vrev-deprecation-"));
  mkdirSync(path.join(projectRoot, ".git"));
  mkdirSync(path.join(projectRoot, ".code/htmls"), { recursive: true });
  mkdirSync(path.join(projectRoot, ".vrev"), { recursive: true });
  writeFileSync(path.join(projectRoot, ".code/htmls/index.html"), "<h1>Compatibility target</h1>");
  writeFileSync(path.join(projectRoot, ".vrev/settings.json"), JSON.stringify({
    schema_version: 1,
    workspace: { root: ".", monorepo: false },
    ui: { plugin_management: true },
    projects: [],
  }));
  await ensureDefaultPlugins(projectRoot);

  const vrev = rootApi.createVrevServer({
    projectRoot,
    target: ".code/htmls/index.html",
    legacyUi,
  });
  await new Promise<void>((resolve) => vrev.server.listen(0, "127.0.0.1", resolve));
  const address = vrev.server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => vrev.close(),
  };
}

async function page(baseUrl: string, pathname: string): Promise<string> {
  const response = await fetch(`${baseUrl}${pathname}`);
  assert.equal(response.status, 200, `${pathname} remains available`);
  return response.text();
}

test("plugin manifest schemas v1-v3 retain their provider API contracts", () => {
  const v1 = parsePluginManifest({
    ...manifestBase(1, "compat-v1"),
    commands: [{ name: "run", module: "./command.js", export: "run" }],
    storage_provider: { module: "./storage.js", export: "storage" },
    issue_provider: { module: "./issues.js" },
  });
  assert.equal(v1.schema_version, 1);
  assert.deepEqual(v1.storage_provider, { module: "./storage.js", export: "storage" });
  assert.deepEqual(v1.issue_provider, { module: "./issues.js" });

  const v2 = parsePluginManifest({
    ...manifestBase(2, "compat-v2"),
    storage_provider: { api_version: 1, module: "./storage.js" },
    annotation_flow_provider: { api_version: 1, module: "./annotation-flow.js", export: "provider" },
  });
  assert.equal(v2.schema_version, 2);
  assert.deepEqual(v2.storage_provider, { module: "./storage.js", api_version: 1 });
  assert.equal(v2.annotation_flow_provider?.api_version, 1);

  const v3 = parsePluginManifest({
    ...manifestBase(3, "compat-v3"),
    display: { title: "Compatibility v3", summary: "A representative schema v3 plugin.", readme: "./README.md" },
    configuration: [],
    storage_provider: { api_version: 1, module: "./storage.js" },
    custom_command_provider: { api_version: 1, module: "./custom-command.js" },
  });
  assert.equal(v3.schema_version, 3);
  assert.deepEqual(v3.storage_provider, { module: "./storage.js", api_version: 1 });
  assert.equal(v3.custom_command_provider?.api_version, 1);

  assert.throws(() => parsePluginManifest({
    ...manifestBase(2, "unversioned-storage"),
    storage_provider: { module: "./storage.js" },
  }), /storage_provider\.api_version must be 1/);
  assert.throws(() => parsePluginManifest({
    ...manifestBase(3, "unversioned-custom-command"),
    display: { title: "Invalid", summary: "Missing provider API version.", readme: "./README.md" },
    configuration: [],
    custom_command_provider: { module: "./custom-command.js" },
  }), /custom_command_provider\.api_version must be 1/);
});

test("one-beta declarative and legacy UI routes remain available", async () => {
  const defaultServer = await serverFixture();
  try {
    assert.match(await page(defaultServer.baseUrl, "/"), /id="renderer-root"/);
    assert.match(await page(defaultServer.baseUrl, "/legacy"), /class="app-shell"/);
    assert.match(await page(defaultServer.baseUrl, "/settings/plugins"), /id="renderer-root"/);
    assert.match(await page(defaultServer.baseUrl, "/settings/legacy"), /id="plugin-list"/);
  } finally {
    await defaultServer.close();
  }

  const legacyServer = await serverFixture(true);
  try {
    assert.match(await page(legacyServer.baseUrl, "/"), /class="app-shell"/);
    assert.match(await page(legacyServer.baseUrl, "/settings/plugins"), /id="plugin-list"/);
  } finally {
    await legacyServer.close();
  }
});

test("root index retains announced compatibility façade exports", () => {
  assert.equal(rootApi.JobManager, CompatibilityJobManager);
  assert.equal(rootApi.JobStore, CompatibilityJobStore);
  assert.equal(rootApi.ReviewStore, CompatibilityReviewStore);
});
