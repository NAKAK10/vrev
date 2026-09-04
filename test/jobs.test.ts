import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createSpawnExecutor,
  fileSha256,
  JobManager,
  JobStore,
  ReviewStore,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ReviewCli,
  type RunningCommand,
  validateEnqueueInput,
} from "../src/index.js";
import { installShutdownHandlers, parseAnnotationArguments, type SignalSource } from "../src/cli.js";

function repository(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-jobs-"));
  mkdirSync(path.join(root, ".code/htmls/pages"), { recursive: true });
  writeFileSync(path.join(root, ".code/htmls/pages/a.html"), "<h1>A</h1>");
  writeFileSync(path.join(root, ".code/htmls/pages/b.html"), "<h1>B</h1>");
  return root;
}

test("workflow enqueue accepts only workflow-owned options", () => {
  assert.deepEqual(validateEnqueueInput({ max_parallel: 10 }), { max_parallel: 10, annotation_ids: null });
  assert.deepEqual(validateEnqueueInput({ max_parallel: 2, annotation_ids: ["annotation-1"] }), { max_parallel: 2, annotation_ids: ["annotation-1"] });
  assert.throws(() => validateEnqueueInput({ max_parallel: 2, runner: "pi" }), /unknown field/);
  assert.throws(() => validateEnqueueInput({ max_parallel: 2, runner_id: "opaque-runner" }), /unknown field/);
  assert.throws(() => validateEnqueueInput({ max_parallel: 2, method_id: "pi" }), /unknown field/);
  assert.throws(() => validateEnqueueInput({ max_parallel: 11 }), /1 to 10/);
});

async function annotate(store: ReviewStore, pagePath: string, comment: string): Promise<string> {
  const page = new ReviewStore(pagePath, { projectRoot: store.target.projectRoot });
  const review = await store.createAnnotation({
    kind: "dom", page_path: pagePath, comment, anchor: { selector: "h1" }, source_hash: fileSha256(page.targetPath),
  });
  return review.annotations.at(-1)!.id;
}

interface Pending { spec: CommandSpec; resolve(result: CommandResult): void }

function controlledExecutor(): { executor: CommandExecutor; pending: Pending[] } {
  const pending: Pending[] = [];
  const executor: CommandExecutor = (spec) => {
    let resolve!: (result: CommandResult) => void;
    const result = new Promise<CommandResult>((done) => { resolve = done; });
    const command: RunningCommand = { result, cancel: () => resolve({ exitCode: null, reason: "cancelled" }) };
    pending.push({ spec, resolve });
    return command;
  };
  return { executor, pending };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}

async function runAnnotationCli(args: string[], stdin = ""): Promise<void> {
  const cli = new URL("../src/cli.js", import.meta.url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli.pathname, ...args], { shell: false, stdio: ["pipe", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString())));
    child.stdin.end(stdin);
  });
}

test("annotation workflow has no Issue draft coordinator integration", () => {
  const source = readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/server/job-manager.ts"), "utf8");
  assert.doesNotMatch(source, /ISSUE_DRAFT|taskCapability|acceptCoordinatorOutput/);
});

test("annotation workflow delegates AI selection to the AI package", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  await annotate(store, store.entryPath, "use package selection");
  const invocations: Array<Record<string, unknown>> = [];
  const ai = {
    apiVersion: 1 as const,
    list: async () => { throw new Error("feature package must not select AI"); },
    invoke: (input: Record<string, unknown>) => {
      invocations.push(input);
      return { cancel() {}, result: Promise.resolve({ status: "failed" as const, output: "", exit_code: 1, message: "fixture" }) };
    },
  };
  const manager = new JobManager(store, { ai });
  await manager.start();
  await manager.enqueue({ max_parallel: 1 });
  await waitFor(() => invocations.length === 1);
  assert.equal(Object.hasOwn(invocations[0]!, "method_id"), false);
  assert.equal(invocations[0]!.mode, "workspace-write");
  await manager.close();
});

test("runs one coordinator process per batch with IDs-only prompt and max subagent limit", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const first = await annotate(store, ".code/htmls/pages/a.html", "SECRET COMMENT A");
  const second = await annotate(store, ".code/htmls/pages/a.html", "SECRET COMMENT B");
  const third = await annotate(store, ".code/htmls/pages/b.html", "SECRET COMMENT C");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  await manager.start();
  const enqueued = await manager.enqueue({ max_parallel: 4 });
  assert.ok((await store.load()).annotations.every(({ status }) => status === "in_progress"));
  await waitFor(() => control.pending.length === 1);
  const prompt = control.pending[0]!.spec.args.at(-1)!;
  assert.equal(control.pending[0]!.spec.cwd, store.target.projectRoot);
  const reviewSnapshotPath = prompt.match(/review snapshot: (.+)\ncontext snapshot:/)?.[1];
  const contextSnapshotPath = prompt.match(/context snapshot: (.+)\n/)?.[1];
  assert.ok(reviewSnapshotPath && contextSnapshotPath);
  assert.notEqual(reviewSnapshotPath, store.path);
  assert.equal(path.dirname(reviewSnapshotPath), path.dirname(contextSnapshotPath));
  assert.equal(path.relative(root, reviewSnapshotPath).startsWith(".."), true, "runtime snapshot must be outside the repository");
  assert.equal(JSON.parse(readFileSync(reviewSnapshotPath, "utf8")).annotations.length, 3);
  assert.deepEqual(JSON.parse(readFileSync(contextSnapshotPath, "utf8")), { schema_version: 1, discovery_status: "pending", primary_project: ".", related_scopes: [] });
  assert.ok([first, second, third].every((id) => prompt.includes(id)));
  assert.doesNotMatch(prompt, /SECRET COMMENT/);
  assert.match(prompt, /最大4個のread-only subagent/);
  assert.match(prompt, /subagentはファイル変更禁止/);
  assert.match(prompt, /5件以下.*subagentを使わず/);
  assert.match(prompt, /利用可能なbrowser確認手段/);
  assert.match(prompt, /組み合わせごとに1回だけvisual検証/);
  assert.match(prompt, /直接必要な最小限/);
  assert.doesNotMatch(prompt, /Mobile MCP|Chrome DevTools MCP/);
  assert.match(prompt, /全annotationを最後まで保留しない/);
  assert.match(prompt, /git add、commit、push、stash、resetは禁止/);
  assert.match(prompt, /一時fileをrepository内へ作らずstdin/);
  assert.equal((await manager.enqueue({ max_parallel: 4 })).jobs.length, 0);
  control.pending[0]!.resolve({ exitCode: 1, reason: "exit" });
  await manager.close();
  assert.equal(existsSync(path.dirname(reviewSnapshotPath)), false, "runtime snapshot must be cleaned after the coordinator exits");
  assert.equal(enqueued.jobs.length, 3);
  assert.ok((await store.load()).annotations.every(({ status }) => status === "failed"));
  assert.ok((await store.load()).annotations.every(({ thread }) => thread.at(-1)?.body.includes("終了コード1")));
});

test("retry queues only the selected failed annotation", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const failedId = await annotate(store, ".code/htmls/pages/a.html", "retry me");
  const untouchedId = await annotate(store, ".code/htmls/pages/b.html", "leave me open");
  await store.setStatus(failedId, { actor: "ai", status: "in_progress" });
  await store.setStatus(failedId, { actor: "ai", status: "failed" });
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  await manager.start();

  const retried = await manager.retry(failedId, { max_parallel: 1 });

  assert.deepEqual(retried.jobs.map(({ annotation_id }) => annotation_id), [failedId]);
  assert.equal((await store.load()).annotations.find(({ id }) => id === failedId)?.status, "in_progress");
  assert.equal((await store.load()).annotations.find(({ id }) => id === untouchedId)?.status, "open");
  await waitFor(() => control.pending.length === 1);
  control.pending[0]!.resolve({ exitCode: 1, reason: "exit" });
  await manager.close();
});

test("treats normal coordinator exit as success and adds a verification message when completion is missing", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const succeededId = await annotate(store, ".code/htmls/pages/a.html", "a");
  const failedId = await annotate(store, ".code/htmls/pages/b.html", "b");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  await manager.start();
  await manager.enqueue({ max_parallel: 2 });
  await waitFor(() => control.pending.length === 1);
  await store.addMessage(succeededId, { actor: "ai", body: "implemented and verified" });
  control.pending[0]!.resolve({ exitCode: 0, reason: "exit" });
  await waitFor(async () => (await manager.list()).jobs.every(({ state }) => state === "succeeded"));
  const byAnnotation = new Map((await manager.list()).jobs.map((job) => [job.annotation_id, job]));
  assert.equal(byAnnotation.get(succeededId)?.summary, "succeeded: AI completion message received");
  assert.match(byAnnotation.get(failedId)?.summary ?? "", /human verification required/);
  const annotations = (await store.load()).annotations;
  assert.equal(annotations.find(({ id }) => id === succeededId)?.status, "addressed");
  const verification = annotations.find(({ id }) => id === failedId);
  assert.equal(verification?.status, "addressed");
  assert.equal(verification?.thread.at(-1)?.body, "AI処理が完了しました。変更内容は人間による確認が必要です。");
  await manager.close();
});

test("durable completion wins over a later coordinator timeout", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const annotationId = await annotate(store, store.entryPath, "completed before timeout");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  await manager.start();
  await manager.enqueue({ max_parallel: 1 });
  await waitFor(() => control.pending.length === 1);
  await store.addMessage(annotationId, { actor: "ai", body: "implemented and verified" });
  await store.setStatus(annotationId, { actor: "ai", status: "addressed" });
  control.pending[0]!.resolve({ exitCode: null, reason: "timeout" });
  await waitFor(async () => (await manager.list()).jobs[0]?.state === "succeeded");
  assert.match((await manager.list()).jobs[0]?.summary ?? "", /completion persisted before coordinator timeout/);
  assert.equal((await store.load()).annotations.find(({ id }) => id === annotationId)?.status, "addressed");
  await manager.close();
});

test("keeps a human-resolved annotation archived when its coordinator later exits zero", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const annotationId = await annotate(store, store.entryPath, "resolved during run");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  await manager.start();
  await manager.enqueue({ max_parallel: 1 });
  await waitFor(() => control.pending.length === 1);
  await store.setStatus(annotationId, { actor: "human", status: "resolved" });
  control.pending[0]!.resolve({ exitCode: 0, reason: "exit" });
  await waitFor(async () => (await manager.list()).jobs[0]?.state === "succeeded");
  const annotation = (await store.load()).annotations.find(({ id }) => id === annotationId);
  assert.equal(annotation?.status, "resolved");
  assert.equal(annotation?.thread.at(-1)?.body, "AI処理が完了しました。変更内容は人間による確認が必要です。");
  await manager.close();
});

test("recovers legacy postcondition failures when a late completion message arrives", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const annotationId = await annotate(store, store.entryPath, "late");
  await store.setStatus(annotationId, { actor: "ai", status: "in_progress" });
  await store.setStatus(annotationId, { actor: "ai", status: "failed" });
  const manager = new JobManager(store, { executor: controlledExecutor().executor });
  const timestamp = new Date(Date.now() - 1000).toISOString();
  manager.jobStore.update((state) => {
    state.batches.push({ id: "legacy", max_parallel: 1, opencode_attach: null, custom_command: null });
    state.jobs.push({ id: "legacy-postcondition", batch_id: "legacy", annotation_id: annotationId, page_path: store.entryPath, source_hash: fileSha256(store.targetPath), cli: "claude", custom_name: null, session_id: null, state: "failed", created: timestamp, started: timestamp, finished: timestamp, exit_code: 0, summary: "failed: annotation postcondition not met" });
  });
  await store.addMessage(annotationId, { actor: "ai", body: "late completion message" });
  assert.equal((await manager.list()).jobs[0]?.state, "succeeded");
  assert.equal((await store.load()).annotations[0]?.status, "addressed");
});

test("recovers legacy zero-exit postcondition failures without a completion message", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const annotationId = await annotate(store, store.entryPath, "legacy no message");
  await store.setStatus(annotationId, { actor: "ai", status: "failed" });
  const manager = new JobManager(store, { executor: controlledExecutor().executor });
  const timestamp = new Date(Date.now() - 1000).toISOString();
  manager.jobStore.update((state) => {
    state.batches.push({ id: "legacy-zero", max_parallel: 1, opencode_attach: null, custom_command: null });
    state.jobs.push({ id: "legacy-zero-job", batch_id: "legacy-zero", annotation_id: annotationId, page_path: store.entryPath, source_hash: fileSha256(store.targetPath), cli: "claude", custom_name: null, session_id: null, state: "failed", created: timestamp, started: timestamp, finished: timestamp, exit_code: 0, summary: "failed: annotation postcondition not met" });
  });
  assert.equal((await manager.list()).jobs[0]?.state, "succeeded");
  const annotation = (await store.loadActive()).annotations[0];
  assert.equal(annotation?.status, "addressed");
  assert.equal(annotation?.thread.at(-1)?.body, "AI処理が完了しました。変更内容は人間による確認が必要です。");
});

test("fails a job when its page target is deleted while the coordinator runs", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const annotationId = await annotate(store, store.entryPath, "delete during run");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  await manager.start();
  await manager.enqueue({ max_parallel: 1 });
  await waitFor(() => control.pending.length === 1);
  await store.addMessage(annotationId, { actor: "ai", body: "implemented and verified" });
  await store.setStatus(annotationId, { actor: "ai", status: "addressed" });
  unlinkSync(store.targetPath);
  control.pending[0]!.resolve({ exitCode: 0, reason: "exit" });
  await waitFor(async () => (await manager.list()).jobs[0]?.state === "failed");
  assert.match((await manager.list()).jobs[0]?.summary ?? "", /page unavailable after coordinator exit/);
  const completed = (await store.load()).annotations.find(({ id }) => id === annotationId);
  assert.equal(completed?.status, "addressed");
  assert.equal(completed?.thread.at(-1)?.body, "implemented and verified");
  await manager.close();
});

test("refreshes a deferred checkpoint after an earlier managed edit on the same page", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const firstId = await annotate(store, ".code/htmls/pages/a.html", "first managed edit");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  await manager.start();
  await manager.enqueue({ max_parallel: 1 });
  await waitFor(() => control.pending.length === 1);

  const secondId = await annotate(store, ".code/htmls/pages/a.html", "queued behind first");
  const second = (await manager.enqueue({ max_parallel: 1 })).jobs.find(({ annotation_id }) => annotation_id === secondId)!;
  assert.equal(second.deferred_checkpoint, true);
  writeFileSync(store.targetPath, "<h1>Managed result</h1>");
  await store.addMessage(firstId, { actor: "ai", body: "first completed" });
  await store.setStatus(firstId, { actor: "ai", status: "addressed" });
  control.pending[0]!.resolve({ exitCode: 0, reason: "exit" });

  await waitFor(() => control.pending.length === 2);
  const running = (await manager.list()).jobs.find(({ id }) => id === second.id)!;
  assert.equal(running.state, "running");
  assert.equal(running.deferred_checkpoint, false);
  assert.equal(running.source_hash, fileSha256(store.targetPath));
  await store.addMessage(secondId, { actor: "ai", body: "second completed" });
  await store.setStatus(secondId, { actor: "ai", status: "addressed" });
  control.pending[1]!.resolve({ exitCode: 0, reason: "exit" });
  await waitFor(async () => (await manager.list()).jobs.find(({ id }) => id === second.id)?.state === "succeeded");
  await manager.close();
});

test("checks external hashes immediately before launch and contains missing targets per job", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  await annotate(store, ".code/htmls/pages/a.html", "first batch");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  await manager.start();
  await manager.enqueue({ max_parallel: 1 });
  await waitFor(() => control.pending.length === 1);
  const staleId = await annotate(store, ".code/htmls/pages/b.html", "stale before launch");
  const queued = await manager.enqueue({ max_parallel: 1 });
  writeFileSync(path.join(root, ".code/htmls/pages/b.html"), "<h1>B external</h1>");
  control.pending[0]!.resolve({ exitCode: 1, reason: "exit" });
  await waitFor(async () => (await manager.list()).jobs.find(({ annotation_id }) => annotation_id === staleId)?.state === "skipped");
  assert.equal(control.pending.length, 1);
  assert.equal((await manager.list()).jobs.find(({ id }) => id === queued.jobs[0]!.id)?.state, "skipped");

  const missingId = await annotate(store, ".code/htmls/pages/a.html", "missing before launch");
  const blocker = await annotate(store, ".code/htmls/pages/b.html", "blocker");
  writeFileSync(path.join(root, ".code/htmls/pages/b.html"), "<h1>B external 2</h1>");
  const next = await manager.enqueue({ max_parallel: 1 });
  assert.ok([missingId, blocker].some((id) => next.jobs.some((job) => job.annotation_id === id)));
  // Enqueue refreshes both checkpoints; removing A is caught as a launch-time per-job failure.
  unlinkSync(path.join(root, ".code/htmls/pages/a.html"));
  await waitFor(async () => (await manager.list()).jobs.find(({ annotation_id }) => annotation_id === missingId)?.state === "failed");
  await manager.close();
});

test("cancels queued jobs individually, running coordinator as a batch, and recovers restart state", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const firstId = await annotate(store, ".code/htmls/pages/a.html", "a");
  const secondId = await annotate(store, ".code/htmls/pages/b.html", "b");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  await manager.start();
  const jobs = (await manager.enqueue({ max_parallel: 1 })).jobs;
  await waitFor(() => control.pending.length === 1);
  const queuedId = await annotate(store, ".code/htmls/pages/a.html", "queued later");
  const queuedJob = (await manager.enqueue({ max_parallel: 1 })).jobs.find(({ annotation_id }) => annotation_id === queuedId)!;
  assert.equal((await manager.cancel(queuedJob.id)).state, "cancelled");
  await manager.cancel(jobs[0]!.id);
  await waitFor(async () => {
    const state = await manager.list();
    return jobs.every((job) => state.jobs.find(({ id }) => id === job.id)?.state === "cancelled");
  });
  await manager.close();

  const jobStore = new JobStore(store.path);
  const timestamp = new Date().toISOString();
  jobStore.update((state) => {
    state.batches.push({ id: "restart", max_parallel: 1, opencode_attach: null, custom_command: null });
    state.jobs.push({ id: "unknown", batch_id: "restart", annotation_id: firstId, page_path: ".code/htmls/pages/a.html", source_hash: fileSha256(path.join(root, ".code/htmls/pages/a.html")), cli: "opencode", custom_name: null, session_id: null, state: "running", created: timestamp, started: timestamp, finished: null, exit_code: null, summary: "running" });
    state.jobs.push({ id: "resume-queued", batch_id: "restart", annotation_id: secondId, page_path: ".code/htmls/pages/b.html", source_hash: fileSha256(path.join(root, ".code/htmls/pages/b.html")), cli: "opencode", custom_name: null, session_id: null, state: "queued", created: timestamp, started: null, finished: null, exit_code: null, summary: "queued" });
  });
  const restartControl = controlledExecutor();
  const restarted = new JobManager(store, { executor: restartControl.executor });
  await restarted.start();
  assert.equal((await restarted.list()).jobs.find(({ id }) => id === "unknown")?.state, "failed");
  await waitFor(() => restartControl.pending.length === 1);
  assert.equal((await restarted.list()).jobs.find(({ id }) => id === "resume-queued")?.state, "running");
  await restarted.close();
});

test("refreshes an old annotation hash when enqueueing against the current source", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  await annotate(store, store.entryPath, "stale");
  writeFileSync(store.targetPath, "<h1>external</h1>");
  const manager = new JobManager(store, { executor: controlledExecutor().executor });
  await manager.start();
  const result = await manager.enqueue({ max_parallel: 1 });
  assert.equal(result.jobs[0]?.state, "queued");
  assert.equal(result.jobs[0]?.source_hash, fileSha256(store.targetPath));
});

test("contains deleted, renamed, and unreadable targets as failed annotation jobs", async () => {
  for (const failure of ["deleted", "renamed", "permission"] as const) {
    const root = repository();
    const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
    await annotate(store, store.entryPath, failure);
    const target = store.targetPath;
    if (failure === "deleted") unlinkSync(target);
    else if (failure === "renamed") renameSync(target, `${target}.moved`);
    else chmodSync(target, 0o000);
    try {
      const manager = new JobManager(store, { executor: controlledExecutor().executor });
      await manager.start();
      const result = await manager.enqueue({ max_parallel: 1 });
      assert.equal(result.jobs[0]?.state, "failed", failure);
      assert.match(result.jobs[0]?.summary ?? "", /page unavailable/, failure);
      await manager.close();
    } finally {
      if (failure === "permission") chmodSync(target, 0o600);
    }
  }
});

test("spawn executor bounds stdout and supports timeout and cancellation", async () => {
  const run = (script: string, executor = createSpawnExecutor({ timeoutMs: 2_000, killGraceMs: 10 })) => executor({
    command: process.execPath as ReviewCli, args: ["-e", script], cwd: process.cwd(), env: { ...process.env },
  });
  const timeout = await run("setInterval(() => {}, 1000)", createSpawnExecutor({ timeoutMs: 20, killGraceMs: 10 }));
  assert.equal((await timeout.result).reason, "timeout");
  const output = await run("process.stdout.write('0123456789abcdefghij')", createSpawnExecutor({ outputLimit: 10, killGraceMs: 10 }));
  const outputResult = await output.result;
  assert.equal(outputResult.reason, "output-limit");
  assert.equal(outputResult.output, "abcdefghij");
  const diagnostics = await run("process.stderr.write('x'.repeat(100)); process.stdout.write('日本語')", createSpawnExecutor({ outputLimit: 10, killGraceMs: 10 }));
  assert.deepEqual(await diagnostics.result, { exitCode: 0, reason: "exit", output: "日本語" });
  const cancelled = await run("setInterval(() => {}, 1000)");
  cancelled.cancel();
  assert.equal((await cancelled.result).reason, "cancelled");
});

test("POSIX executor starts a detached process group and terminates the whole group", async () => {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough; pid: number };
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let detached: boolean | undefined;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const executor = createSpawnExecutor({
    platform: "darwin",
    killGraceMs: 5,
    spawnProcess: ((_command: string, _args: readonly string[], options: { detached?: boolean }) => {
      detached = options.detached;
      return child;
    }) as unknown as typeof spawn,
    killProcess: (pid, signal) => { signals.push([pid, signal]); },
  });
  const command = executor({ command: "opencode", args: [], cwd: process.cwd(), env: {} });
  command.cancel();
  assert.equal(detached, true);
  assert.deepEqual(signals[0], [-4321, "SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(signals[1], [-4321, "SIGKILL"]);
  child.emit("close", null);
  assert.equal((await command.result).reason, "cancelled");
});

test("POSIX executor cancellation terminates a real parent and grandchild process tree", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "visual-review-process-tree-"));
  const pidPath = path.join(fixtureRoot, "pids.json");
  const script = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
    setInterval(() => {}, 1000);
  `;
  const executor = createSpawnExecutor({ timeoutMs: 5_000, killGraceMs: 100 });
  const command = executor({ command: process.execPath as ReviewCli, args: ["-e", script], cwd: fixtureRoot, env: { ...process.env } });
  await waitFor(() => existsSync(pidPath));
  const pids = JSON.parse(readFileSync(pidPath, "utf8")) as { parent: number; grandchild: number };
  command.cancel();
  assert.equal((await command.result).reason, "cancelled");
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  };
  for (let attempt = 0; attempt < 200 && (alive(pids.parent) || alive(pids.grandchild)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(alive(pids.parent), false, "parent process must exit");
  assert.equal(alive(pids.grandchild), false, "grandchild process must exit");
});

test("SIGINT/SIGTERM shutdown handler awaits the supplied close path once", async () => {
  const source = new EventEmitter() as EventEmitter & SignalSource;
  let closeCalls = 0;
  let releaseClose!: () => void;
  const closed = new Promise<void>((resolve) => { releaseClose = resolve; });
  const remove = installShutdownHandlers(async () => { closeCalls += 1; await closed; }, source);
  source.emit("SIGTERM");
  source.emit("SIGINT");
  assert.equal(closeCalls, 1);
  releaseClose();
  await closed;
  remove();
});

test("annotation CLI works for external projects and requires the canonical review path", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const id = await annotate(store, store.entryPath, "fix");
  const reviewPath = path.relative(store.target.projectRoot, store.path).split(path.sep).join("/");
  const common = ["--project-root", root, "--review-path", reviewPath, "--annotation-id", id];
  await runAnnotationCli(["annotation", "add-message", ...common, "--actor", "ai", "--body-stdin"], "implemented\n");
  await runAnnotationCli(["annotation", "set-status", ...common, "--status", "addressed"]);
  const annotation = (await store.load()).annotations.find((candidate) => candidate.id === id)!;
  assert.equal(annotation.status, "addressed");
  assert.equal(annotation.thread.at(-1)?.body, "implemented");

  const issueReview = await store.createIssueRequest({
    kind: "dom",
    page_path: store.entryPath,
    comment: "large change",
    anchor: { selector: "h1" },
    source_hash: store.sourceHash(),
  });
  const issueId = issueReview.annotations.at(-1)!.id;
  await store.setStatus(issueId, { actor: "ai", status: "in_progress" });
  await assert.rejects(
    store.setIssueDraftReady(issueId, "Internal reference", `Visual Review注釈: ${issueId}`),
    /understandable without internal review references/,
  );
  await assert.rejects(
    store.setIssueDraftReady(issueId, "Internal path", "See .vreview/reviews/page/review.json"),
    /understandable without internal review references/,
  );
  await runAnnotationCli(
    ["annotation", "set-issue-draft", "--project-root", root, "--review-path", reviewPath, "--annotation-id", issueId, "--draft-stdin"],
    JSON.stringify({ title: "Large change", body: "## Expected\nUpdated UI" }),
  );
  const issue = (await store.load()).annotations.find((candidate) => candidate.id === issueId)!;
  assert.equal(issue.status, "addressed");
  assert.equal(issue.issue_state, "ready");
  assert.equal(issue.issue_title, "Large change");
  assert.throws(() => parseAnnotationArguments(["annotation", "set-status", "--project-root", root, "--review-path", `./${reviewPath}`, "--annotation-id", id, "--status", "addressed"]), /canonical/);
});

test("job store rejects corrupt or data-bearing state instead of overwriting it", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  await store.load();
  const jobs = new JobStore(store.path);
  writeFileSync(jobs.path, JSON.stringify({ revision: 0, batches: [], jobs: [], prompt: "must not persist" }));
  assert.throws(() => jobs.load(), /invalid job-state\.json.*unknown field/);
});
