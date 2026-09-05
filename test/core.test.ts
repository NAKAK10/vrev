import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { atomicWriteJson, fileSha256, resolveTarget, ReviewStore, reviewDirectoryName, sanitizeAnchor, withFileLock } from "../src/index.js";
import { createLocalReviewDocumentStorage } from "../src/review-storage-local.js";

function repository(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-"));
  mkdirSync(path.join(root, ".code/htmls/pages"), { recursive: true });
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, ".code/htmls/pages/index.html"), "<h1>日本語</h1>");
  writeFileSync(path.join(root, "assets/image.png"), "png");
  return root;
}

function payload(store: ReviewStore) {
  return { kind: "dom" as const, page_path: store.entryPath, comment: "直してください", anchor: { selector: " h1 ", attributes: { id: "title", "data-api-key": "secret" }, viewport_mode: "mobile" as const, unknown: "secret" }, source_hash: fileSha256(store.targetPath) };
}

test("local storage tolerates missing transaction files but rejects dangling symlinks", () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: root });
  const paths = { active: path.join(root, "active.json"), resolved: path.join(root, "resolved.json"), legacy: path.join(root, "legacy.json"), transaction: path.join(root, "transaction.json"), context: path.join(root, "context.json") };
  assert.doesNotThrow(() => createLocalReviewDocumentStorage(store.target, paths));
  for (const candidate of [paths.legacy, paths.transaction]) {
    symlinkSync(path.join(root, "missing.json"), candidate);
    assert.throws(() => createLocalReviewDocumentStorage(store.target, paths), /must not be symbolic links/);
    unlinkSync(candidate);
  }
});

test("uses deterministic destination and stable JSON format", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: root });
  assert.equal(reviewDirectoryName(store.entryPath), "index--d324f44dd58b");
  await store.load();
  assert.match(store.path, /\.vrev\/reviews\/index--d324f44dd58b\/review\.json$/);
  assert.match(store.resolvedPath, /\.vrev\/reviews\/index--d324f44dd58b\/resolved\.json$/);
  const text = readFileSync(store.path, "utf8");
  assert.ok(text.includes("日本語") === false);
  assert.ok(text.endsWith("\n"));
  atomicWriteJson(path.join(root, "unicode.json"), { text: "日本語" });
  assert.equal(readFileSync(path.join(root, "unicode.json"), "utf8"), '{\n  "text": "日本語"\n}\n');
});

test("safe stem excludes decomposed Unicode combining marks", () => {
  assert.equal(reviewDirectoryName("assets/cafe\u0301.png").split("--")[0], "cafe");
  assert.equal(reviewDirectoryName("assets/é.png").split("--")[0], "é");
});

test("accepts loopback, private-network HTTP, and public HTTPS targets while rejecting unsafe URLs", () => {
  const root = repository();
  const live = resolveTarget("http://127.0.0.1:5173/dashboard?tab=one#ignored", root);
  assert.equal(live.liveUrl, "http://127.0.0.1:5173/dashboard?tab=one");
  assert.equal(live.kind, "html");
  assert.equal(live.urlMode, "loopback");
  const privateNetwork = resolveTarget("http://192.168.11.13:3000/dashboard#ignored", root);
  assert.equal(privateNetwork.liveUrl, "http://192.168.11.13:3000/dashboard");
  assert.equal(privateNetwork.urlMode, "private");
  assert.equal(resolveTarget("http://10.0.0.8:8080", root).urlMode, "private");
  assert.equal(resolveTarget("http://172.16.4.8:8080", root).urlMode, "private");
  const hosted = resolveTarget("https://example.com/products?tab=one#ignored", root);
  assert.equal(hosted.liveUrl, "https://example.com/products?tab=one");
  assert.equal(hosted.urlMode, "public");
  assert.throws(() => resolveTarget("http://example.com", root), /public host/);
  assert.throws(() => resolveTarget("http://169.254.169.254", root), /public host/);
  const credentialed = ["https://", "user", ":", "placeholder", "@example.com"].join("");
  assert.throws(() => resolveTarget(credentialed, root), /credentials/);
});

test("rejects absolute, traversal, hidden, sensitive, wrong-root and symlink targets", () => {
  const root = repository();
  writeFileSync(path.join(root, "assets/.hidden.png"), "x");
  writeFileSync(path.join(root, "assets/credentials.png"), "x");
  symlinkSync(path.join(root, "assets/image.png"), path.join(root, "assets/link.png"));
  for (const target of ["/assets/image.png", "../image.png", "assets/.hidden.png", "assets/credentials.png", ".code/htmls/pages/image.png", "assets/link.png"]) {
    assert.throws(() => resolveTarget(target, root));
  }
  assert.equal(resolveTarget("assets/image.png", root).kind, "image");
});

test("stores workspace settings centrally for a monorepo project", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-monorepo-"));
  mkdirSync(path.join(root, ".git"));
  const project = path.join(root, "apps/web");
  mkdirSync(path.join(project, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(project, ".code/htmls/index.html"), "<h1>Web</h1>");
  const store = new ReviewStore("apps/web/.code/htmls/index.html", { projectRoot: root, projectDirectory: project });
  await store.load();
  const settings = JSON.parse(readFileSync(path.join(root, ".vrev/settings.json"), "utf8")) as { workspace: { monorepo: boolean }; projects: Array<{ path: string; reviews: Array<{ review_path: string }> }> };
  assert.equal(settings.workspace.monorepo, true);
  assert.equal(settings.projects[0]?.path, "apps/web");
  assert.match(settings.projects[0]?.reviews[0]?.review_path ?? "", /^\.vrev\/reviews\/.*\/review\.json$/);
});

test("separates resolved annotations and moves reopened feedback back to active JSON", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  let review = await store.createAnnotation(payload(store));
  const id = review.annotations[0]!.id;
  await store.setStatus(id, { actor: "ai", status: "addressed" });
  await store.setStatus(id, { actor: "human", status: "resolved" });
  assert.equal((JSON.parse(readFileSync(store.path, "utf8")) as { annotations: unknown[] }).annotations.length, 0);
  assert.equal((JSON.parse(readFileSync(store.resolvedPath, "utf8")) as { annotations: unknown[] }).annotations.length, 1);
  review = await store.addMessage(id, { actor: "human", body: "再対応" });
  assert.equal(review.annotations[0]?.status, "open");
  assert.equal((JSON.parse(readFileSync(store.path, "utf8")) as { annotations: unknown[] }).annotations.length, 1);
  assert.equal((JSON.parse(readFileSync(store.resolvedPath, "utf8")) as { annotations: unknown[] }).annotations.length, 0);
});

test("active reads exclude archived annotations without loading the resolved payload", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  const id = (await store.createAnnotation(payload(store))).annotations[0]!.id;
  await store.setStatus(id, { actor: "human", status: "resolved" });
  writeFileSync(store.resolvedPath, "{ intentionally-not-loaded", "utf8");
  assert.deepEqual((await store.loadActive()).annotations, []);
  await assert.rejects(store.load());
});

test("migrates legacy review JSON into root .vrev storage", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  const review = await store.load();
  unlinkSync(store.path);
  unlinkSync(store.resolvedPath);
  atomicWriteJson(store.legacyPath, review);
  const migrated = await store.load();
  assert.equal(migrated.review_id, review.review_id);
  assert.equal(existsSync(store.legacyPath), false);
  assert.equal(existsSync(store.path), true);
  assert.equal(existsSync(store.resolvedPath), true);
});

test("recovers an interrupted active/resolved split transaction", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  const expected = await store.createAnnotation(payload(store));
  atomicWriteJson(store.transactionPath, expected);
  atomicWriteJson(store.path, { ...expected, annotations: [], events: [] });
  const recovered = await store.load();
  assert.equal(recovered.annotations.length, 1);
  assert.equal(existsSync(store.transactionPath), false);
  assert.equal((JSON.parse(readFileSync(store.path, "utf8")) as { annotations: unknown[] }).annotations.length, 1);
});

test("human can force-resolve an annotation from every active status", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  const id = (await store.createAnnotation(payload(store))).annotations[0]!.id;
  assert.equal((await store.setStatus(id, { actor: "human", status: "resolved" })).annotations[0]!.status, "resolved");
  await store.setStatus(id, { actor: "human", status: "open" });
  await store.setStatus(id, { actor: "ai", status: "in_progress" });
  assert.equal((await store.setStatus(id, { actor: "human", status: "resolved" })).annotations[0]!.status, "resolved");
  await store.setStatus(id, { actor: "human", status: "open" });
  await store.setStatus(id, { actor: "ai", status: "failed" });
  assert.equal((await store.setStatus(id, { actor: "human", status: "resolved" })).annotations[0]!.status, "resolved");
});

test("human feedback reopens a failed annotation", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  const id = (await store.createAnnotation(payload(store))).annotations[0]!.id;
  await store.setStatus(id, { actor: "ai", status: "in_progress" });
  await store.addMessage(id, { actor: "ai", body: "AI修正に失敗しました。" });
  await store.setStatus(id, { actor: "ai", status: "failed" });
  const reopened = await store.addMessage(id, { actor: "human", body: "もう一度お願いします" });
  assert.equal(reopened.annotations[0]!.status, "open");
});

test("refreshes the annotation source hash after an AI fix", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  const review = await store.createAnnotation(payload(store));
  const id = review.annotations[0]!.id;
  await store.setStatus(id, { actor: "ai", status: "in_progress" });
  writeFileSync(store.targetPath, "<h1>AI fixed</h1>", "utf8");
  const addressed = await store.setStatus(id, { actor: "ai", status: "addressed" });
  assert.equal(addressed.annotations[0]!.source_hash, fileSha256(store.targetPath));
});

test("rejects a symlinked review storage root", () => {
  const root = repository();
  const outside = mkdtempSync(path.join(os.tmpdir(), "vrev-outside-"));
  symlinkSync(outside, path.join(root, ".vrev"));
  assert.throws(
    () => new ReviewStore("assets/image.png", { projectRoot: root }),
    /storage path.*symbolic links/,
  );
});

test("creates schema v2, sanitizes anchors and records status/message events", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  let review = await store.createAnnotation(payload(store));
  assert.equal(review.schema_version, 2);
  assert.deepEqual(review.annotations[0]!.anchor, { selector: "h1", attributes: { id: "title" }, viewport_mode: "mobile" });
  const id = review.annotations[0]!.id;
  review = await store.setStatus(id, { status: "addressed", actor: "ai" });
  await assert.rejects(store.setStatus(id, { status: "resolved", actor: "ai" }), /invalid/);
  review = await store.addMessage(id, { body: "再確認", actor: "human" });
  assert.equal(review.annotations[0]!.status, "open");
  assert.equal(review.revision, 4);
  assert.deepEqual(review.events.map(({ type }) => type), ["annotation_created", "status_changed", "message_added", "status_changed"]);
  assert.throws(() => sanitizeAnchor("region", { bounds: { x: 0, y: 0, width: -1, height: 1 } }), /nonnegative/);
  assert.throws(() => sanitizeAnchor("dom", { selector: "h1", viewport_mode: "watch" }), /viewport_mode/);
});

test("matches the schema 1 compatibility fixture", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/schema-v1-compat.json", import.meta.url), "utf8")) as {
    input: Record<string, unknown>;
    expected: Record<string, unknown>;
  };
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  atomicWriteJson(store.path, fixture.input);

  const migrated = await store.load() as unknown as Record<string, unknown>;
  const { migrated_at: migratedAt, ...stable } = migrated;
  assert.equal(typeof migratedAt, "string");
  assert.deepEqual(stable, fixture.expected);
  assert.deepEqual(await store.load(), migrated);
});

test("migrates schema 1 anchors without changing revision/events", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  const initial = await store.load();
  atomicWriteJson(store.path, { ...initial, schema_version: 1, revision: 7, annotations: [{ kind: "dom", anchor: { selector: " #safe ", value: "secret" } }], events: [{ type: "legacy" }] });
  const migrated = await store.load() as unknown as Record<string, unknown>;
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.revision, 7);
  assert.deepEqual((migrated.annotations as Array<Record<string, unknown>>)[0]!.anchor, { selector: "#safe" });
  assert.deepEqual(migrated.events, [{ type: "legacy" }]);
});

test("serializes competing worker updates and recovers an expired lock", async () => {
  const store = new ReviewStore(".code/htmls/pages/index.html", { projectRoot: repository() });
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.moduleUrl).then(async ({ ReviewStore, fileSha256 }) => {
      const store = new ReviewStore(workerData.target, { projectRoot: workerData.root });
      await store.createAnnotation({
        kind: "dom",
        page_path: store.entryPath,
        comment: workerData.comment,
        anchor: { selector: "h1" },
        source_hash: fileSha256(store.targetPath),
      });
      parentPort.postMessage(null);
    }).catch((error) => parentPort.postMessage(String(error && error.stack || error)));
  `;
  const updates = Array.from({ length: 12 }, (_, index) => new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { moduleUrl, root: store.target.projectRoot, target: store.entryPath, comment: `note-${index}` },
    });
    worker.once("message", (error: unknown) => error === null ? resolve() : reject(new Error(String(error))));
    worker.once("error", reject);
  }));
  await Promise.all(updates);
  const review = await store.load();
  assert.equal(review.annotations.length, 12);
  assert.deepEqual(review.events.map(({ revision }) => revision), Array.from({ length: 12 }, (_, index) => index + 1));
  writeFileSync(`${store.path}.lock`, "stale");
  const result = withFileLock(store.path, () => 42, { staleMs: -1 });
  assert.equal(result, 42);
});
