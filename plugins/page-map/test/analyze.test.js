import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { analyzeSite, createAnalysisCache } from "../server/analyze.js";

const fixturesRoot = fileURLToPath(new URL("./fixtures", import.meta.url));

test("analyzes the fixture site: pages, edges, reachability, unknowns and externals", () => {
  const result = analyzeSite({ projectRoot: fixturesRoot, entryPath: "site/index.html" });

  assert.equal(result.entry_path, "site/index.html");
  assert.equal(result.scan_root, "site");
  assert.equal(result.stats.files, 6);
  assert.equal(result.truncated, false);

  const byPath = Object.fromEntries(result.pages.map((page) => [page.path, page]));
  assert.equal(byPath["site/index.html"].reachable, true);
  assert.equal(byPath["site/unreachable.html"].reachable, false);
  assert.equal(byPath["site/missing.html"].exists, false);
  assert.equal(byPath["site/about.html"].exists, true);
  assert.equal(byPath["site/about.html"].title, "概要");

  // outside.html is one directory above the scan root: it must never be read, so it gets no
  // page node and its own link ("never-read.html") never shows up anywhere in the output.
  assert.equal(byPath["outside.html"], undefined);
  assert.equal(result.pages.some(({ path: p }) => p.includes("never-read")), false);
  assert.equal(JSON.stringify(result).includes("never-read"), false);

  assert.ok(result.externals.some((entry) => entry.url === "https://example.com/"));

  assert.equal(result.unknown.length, 1);
  assert.equal(result.unknown[0].from, "site/index.html");

  const selfEdge = result.edges.find((edge) => edge.kind === "form" && edge.from === edge.to);
  assert.ok(selfEdge);
});

test("the analysis cache avoids re-parsing unchanged files", () => {
  const cache = createAnalysisCache();
  analyzeSite({ projectRoot: fixturesRoot, entryPath: "site/index.html", cache });
  const afterFirst = cache.stats();
  assert.equal(afterFirst.hits, 0);
  assert.ok(afterFirst.misses > 0);

  analyzeSite({ projectRoot: fixturesRoot, entryPath: "site/index.html", cache });
  const afterSecond = cache.stats();
  assert.equal(afterSecond.hits, afterFirst.misses);
});

test("limits truncate the scan and report a warning instead of throwing", () => {
  const result = analyzeSite({
    projectRoot: fixturesRoot,
    entryPath: "site/index.html",
    limits: { max_files: 1, max_file_bytes: 1024 * 1024, max_total_ms: 5000 },
  });
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.length > 0);
  assert.ok(result.stats.files <= 1);
});

test("a symlink inside the scan root is never followed, and its target is never read", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "page-map-symlink-"));
  cpSync(fixturesRoot, tmp, { recursive: true });
  const secretTarget = path.join(tmp, "secret-outside.html");
  writeFileSync(secretTarget, `<a href="should-not-appear.html">leak</a>`);
  const linkPath = path.join(tmp, "site", "linked.html");
  try {
    symlinkSync(secretTarget, linkPath);
  } catch (error) {
    // Symlink creation can fail without elevated privileges on some CI platforms; skip in that case.
    if (error?.code === "EPERM") return;
    throw error;
  }

  const result = analyzeSite({ projectRoot: tmp, entryPath: "site/index.html" });
  assert.equal(result.pages.some(({ path: p }) => p.includes("linked.html")), false);
  assert.equal(JSON.stringify(result).includes("should-not-appear"), false);
  // Confirm the symlink target really does contain the marker, so the assertion above is meaningful.
  assert.match(readFileSync(secretTarget, "utf8"), /should-not-appear/);
});
