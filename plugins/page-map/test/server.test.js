import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createPageMapBridgeAdapter } from "../server/index.js";
import { analyzeSite } from "../server/analyze.js";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));
const fixturesRoot = path.join(pluginRoot, "test", "fixtures");

test("page-map.get returns the fixture site analysis through the bridge adapter", async () => {
  const adapter = createPageMapBridgeAdapter({ projectRoot: fixturesRoot, entryPath: "site/index.html", kind: "html" });
  const result = await adapter.query("page-map.get", { request_id: "r1", input: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.analysis_state, "ready");
  assert.equal(result.data.analysis_reason, "none");
  assert.equal(result.data.entry_path, "site/index.html");
  assert.ok(result.data.stats.pages > 0);
});

test("page-map.get on a non-html target returns an empty result with a warning", async () => {
  const adapter = createPageMapBridgeAdapter({ projectRoot: fixturesRoot, entryPath: "assets/image.png", kind: "image" });
  const result = await adapter.query("page-map.get", { request_id: "r2", input: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.analysis_state, "unsupported");
  assert.equal(result.data.analysis_reason, "unsupported_target");
  assert.deepEqual(result.data.pages, []);
  assert.equal(result.data.warnings[0], "静的HTML以外の対象は未対応です");
});

test("page-map.get on a live target returns an empty result with a warning", async () => {
  const adapter = createPageMapBridgeAdapter({ projectRoot: fixturesRoot, entryPath: "http://localhost:4000/", kind: "html", liveUrl: "http://localhost:4000/" });
  const result = await adapter.query("page-map.get", { request_id: "r3", input: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.analysis_state, "unsupported");
  assert.equal(result.data.analysis_reason, "unsupported_target");
  assert.deepEqual(result.data.pages, []);
});

test("page-map.get distinguishes an empty static directory from an unsupported target", async () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "vrev-page-map-empty-"));
  mkdirSync(path.join(projectRoot, "public"));
  const adapter = createPageMapBridgeAdapter({ projectRoot, entryPath: "public/index.html", kind: "html" });
  const result = await adapter.query("page-map.get", { request_id: "r-empty", input: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.analysis_state, "empty");
  assert.equal(result.data.analysis_reason, "no_html_files");
  assert.equal(result.data.stats.files, 0);
});

test("page-map.get reports an incomplete scan when the public directory is missing", async () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "vrev-page-map-missing-"));
  const adapter = createPageMapBridgeAdapter({ projectRoot, entryPath: "public/index.html", kind: "html" });
  const result = await adapter.query("page-map.get", { request_id: "r-missing", input: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.analysis_state, "incomplete");
  assert.equal(result.data.analysis_reason, "scan_incomplete");
  assert.match(result.data.warnings[0], /directory/);
});

test("page-map.refresh clears the cache and invalidates the page-map resource", async () => {
  const adapter = createPageMapBridgeAdapter({ projectRoot: fixturesRoot, entryPath: "site/index.html", kind: "html" });
  await adapter.query("page-map.get", { request_id: "r4", input: {} });
  assert.ok(adapter.cache.stats().misses > 0);
  const result = await adapter.command("page-map.refresh", { request_id: "r5", input: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(result.effects, [{ type: "resource.invalidate", resources: ["page-map"] }]);
  assert.deepEqual(adapter.cache.stats(), { hits: 0, misses: 0 });
});

test("unknown query and command names return a PLUGIN_PROTOCOL_ERROR-shaped failure", async () => {
  const adapter = createPageMapBridgeAdapter({ projectRoot: fixturesRoot, entryPath: "site/index.html", kind: "html" });
  const queryResult = await adapter.query("nope.query", { request_id: "r6", input: {} });
  assert.equal(queryResult.ok, false);
  assert.equal(queryResult.error.code, "NOT_FOUND");
  const commandResult = await adapter.command("nope.command", { request_id: "r7", input: {} });
  assert.equal(commandResult.ok, false);
  assert.equal(commandResult.error.code, "NOT_FOUND");
});

test("server sources never import network/process/eval capabilities", () => {
  // These patterns target real capability acquisition (module imports, calls) rather than the
  // literal substrings "http"/"https", which legitimately appear in this plugin's own regex
  // literals when classifying an already-extracted URL scheme (never used to open a connection).
  const forbiddenPatterns = [
    /\brequire\(\s*["']node:(?:https?|child_process|vm)["']\s*\)/,
    /\brequire\(\s*["'](?:https?|child_process|vm)["']\s*\)/,
    /\bfrom\s+["']node:(?:https?|child_process|vm)["']/,
    /\bfrom\s+["'](?:https?|child_process|vm)["']/,
    /\bimport\(\s*["']node:(?:https?|child_process|vm)["']/,
    /\bfetch\s*\(/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /\bjsdom\b/i,
    /<iframe/i,
  ];
  const serverDir = path.join(pluginRoot, "server");
  const violations = [];
  for (const name of readdirSync(serverDir)) {
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(path.join(serverDir, name), "utf8");
    source.split("\n").forEach((line, index) => {
      if (forbiddenPatterns.some((pattern) => pattern.test(line))) violations.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(violations, [], `forbidden identifiers found:\n${violations.join("\n")}`);
});

test("analyzeSite never calls globalThis.fetch", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("fetch must never be called by the static analyzer"); };
  try {
    const result = analyzeSite({ projectRoot: fixturesRoot, entryPath: "site/index.html" });
    assert.ok(result.stats.pages > 0);
  } finally {
    globalThis.fetch = original;
  }
});
