import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import {
  CapabilityRegistry,
  createPluginHostRuntime,
  createReviewCapability,
  fileSha256,
  REVIEW_CAPABILITY_ID,
  REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID,
  reviewDomainDependencies,
  ReviewStore,
  type ReviewCapabilityV1,
} from "../src/index.js";

function repository(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-extraction-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(root, ".code/htmls/index.html"), "<h1>Review</h1>");
  return root;
}

test("deprecated ReviewStore and ReviewCapability share the plugin-owned persistence implementation", () => {
  const root = repository();
  const facade = new ReviewStore(".code/htmls/index.html", { projectRoot: root });
  const capability = createReviewCapability(".code/htmls/index.html", { projectRoot: root });
  const created = facade.createAnnotation({
    kind: "dom",
    page_path: facade.entryPath,
    comment: "same aggregate",
    anchor: { selector: "h1" },
    source_hash: fileSha256(facade.targetPath),
  });

  assert.equal(capability.store.load().review_id, created.review_id);
  assert.equal(capability.store.load().revision, 1);
  assert.throws(() => facade.createAnnotation({
    kind: "dom",
    page_path: facade.entryPath,
    comment: "stale write",
    anchor: { selector: "h1" },
    source_hash: fileSha256(facade.targetPath),
  }, "review:0"), /review revision conflict/);
  assert.equal(capability.store.load().revision, 1);
  assert.match(facade.path, /\.vreview\/reviews\/index--60e665b01e89\/review\.json$/);
});

test("bundled review server registers and removes ReviewCapabilityV1", async () => {
  const root = repository();
  await ensureDefaultPlugins(root);
  const capabilities = new CapabilityRegistry();
  capabilities.register(REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID, 1, reviewDomainDependencies);
  const runtime = createPluginHostRuntime({
    workspaceRoot: root,
    workspaceId: "workspace",
    target: { id: "target", source: ".code/htmls/index.html" },
    capabilities,
  });

  await runtime.start();
  assert.equal(runtime.status("review").state, "ready");
  const review = capabilities.resolve<ReviewCapabilityV1>(REVIEW_CAPABILITY_ID, 1);
  assert.equal(review.apiVersion, 1);
  assert.equal(review.store.load().schema_version, 2);
  await runtime.stop();
  assert.equal(capabilities.has(REVIEW_CAPABILITY_ID, 1), false);
});

test("core review adapters contain no review validation, migration, or persistence logic", () => {
  const facade = readFileSync(new URL("../../src/review-store.ts", import.meta.url), "utf8");
  const types = readFileSync(new URL("../../src/types.ts", import.meta.url), "utf8");
  const implementation = readFileSync(new URL("../../plugins/review/server/review-store.ts", import.meta.url), "utf8");
  const http = readFileSync(new URL("../../src/http-server.ts", import.meta.url), "utf8");

  assert.doesNotMatch(facade, /schema_version|withFileLock|status transition|atomicWriteJson/);
  assert.match(facade, /plugins\/review\/server\/review-store/);
  assert.match(types, /plugins\/review\/server\/review-types/);
  assert.doesNotMatch(implementation, /from ["']\.\.\/\.\.\/\.\.\/src\//);
  assert.match(http, /createReviewCapability/);
  assert.doesNotMatch(http, /invalid human status transition|sanitizeLegacyAnchor/);
});
