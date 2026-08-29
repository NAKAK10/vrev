import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildCommand,
  createSpawnExecutor,
  fileSha256,
  JobManager,
  JobStore,
  parseCustomCommand,
  ReviewStore,
  testCustomCommand,
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

test("accepts supported and custom command configurations", () => {
  assert.equal(validateEnqueueInput({ cli: "opencode", max_parallel: 10 }).max_parallel, 10);
  assert.equal(validateEnqueueInput({ cli: "copilot", max_parallel: 2 }).cli, "copilot");
  assert.equal(validateEnqueueInput({ cli: "pi", max_parallel: 2 }).cli, "pi");
  const custom = validateEnqueueInput({ cli: "custom", max_parallel: 2, custom_name: "Cloud model", custom_command: "runner --prompt {prompt}" });
  assert.equal(custom.custom_command, "runner --prompt {prompt}");
  assert.throws(() => validateEnqueueInput({ cli: "custom", max_parallel: 2 }), /custom_name/);
  assert.throws(() => validateEnqueueInput({ cli: "opencode", max_parallel: 11 }), /1 to 10/);
});

function annotate(store: ReviewStore, pagePath: string, comment: string): string {
  const page = new ReviewStore(pagePath, { projectRoot: store.target.projectRoot });
  const review = store.createAnnotation({
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
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

test("builds fixed argv for all adapters without annotation comments", () => {
  const base = { prompt: "fixed prompt", projectRoot: "/repo", opencodeAttach: null };
  assert.deepEqual(buildCommand({ ...base, cli: "opencode", sessionId: null }).args, ["run", "--format", "json", "fixed prompt"]);
  assert.deepEqual(buildCommand({ ...base, cli: "opencode", sessionId: "s:1", opencodeAttach: "http://127.0.0.1:4096" }).args, ["run", "--format", "json", "--session", "s:1", "--attach", "http://127.0.0.1:4096", "fixed prompt"]);
  assert.deepEqual(buildCommand({ ...base, cli: "claude", sessionId: "s.1" }).args, ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--resume", "s.1", "fixed prompt"]);
  assert.deepEqual(buildCommand({ ...base, cli: "codex", sessionId: null }).args, ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", "--json", "fixed prompt"]);
  assert.deepEqual(buildCommand({ ...base, cli: "codex", sessionId: "abc" }).args, ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", "resume", "--json", "abc", "fixed prompt"]);
  assert.deepEqual(buildCommand({ ...base, cli: "copilot", sessionId: null }).args, ["--prompt", "fixed prompt", "--allow-all-tools"]);
  assert.deepEqual(buildCommand({ ...base, cli: "pi", sessionId: null }).args, ["--print", "--mode", "json", "--no-session", "--approve", "fixed prompt"]);
  const custom = buildCommand({ ...base, cli: "custom", sessionId: null, customCommand: "ollama launch claude --model model -- {prompt}" });
  assert.equal(custom.command, "ollama");
  assert.deepEqual(custom.args, ["launch", "claude", "--model", "model", "--", "fixed prompt"]);
  assert.deepEqual(parseCustomCommand("runner --flag {prompt}", "prompt"), { command: "runner", args: ["--flag", "prompt"] });
  assert.throws(() => parseCustomCommand("runner --flag", "prompt"), /include \{prompt\} exactly once/);
  assert.throws(() => parseCustomCommand("runner {prompt} {prompt}", "prompt"), /include \{prompt\} exactly once/);
  assert.throws(() => parseCustomCommand("runner 'unfinished", "prompt"), /unfinished/);
});

test("custom command capability test requires both a response and tool use", async () => {
  const respondingExecutor: CommandExecutor = (spec) => {
    writeFileSync(path.join(spec.cwd, ".visual-review-command-test"), "VISUAL_REVIEW_OK", "utf8");
    return { result: Promise.resolve({ exitCode: 0, reason: "exit", output: "VISUAL_REVIEW_OK" }), cancel: () => undefined };
  };
  const probe = await testCustomCommand("runner {prompt}", respondingExecutor);
  assert.ok(probe.durationMs >= 0);

  const textOnlyExecutor: CommandExecutor = () => ({
    result: Promise.resolve({ exitCode: 0, reason: "exit", output: "VISUAL_REVIEW_OK" }),
    cancel: () => undefined,
  });
  await assert.rejects(testCustomCommand("runner {prompt}", textOnlyExecutor), /toolによるファイル操作/);
});

test("runs one coordinator process per batch with IDs-only prompt and max subagent limit", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const first = annotate(store, ".code/htmls/pages/a.html", "SECRET COMMENT A");
  const second = annotate(store, ".code/htmls/pages/a.html", "SECRET COMMENT B");
  const third = annotate(store, ".code/htmls/pages/b.html", "SECRET COMMENT C");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  manager.start();
  const enqueued = manager.enqueue({ cli: "opencode", max_parallel: 4 });
  assert.ok(store.load().annotations.every(({ status }) => status === "in_progress"));
  await waitFor(() => control.pending.length === 1);
  const prompt = control.pending[0]!.spec.args.at(-1)!;
  assert.equal(control.pending[0]!.spec.cwd, store.target.projectRoot);
  assert.ok([first, second, third].every((id) => prompt.includes(id)));
  assert.doesNotMatch(prompt, /SECRET COMMENT/);
  assert.match(prompt, /最大4個のread-only subagent/);
  assert.match(prompt, /subagentはファイル変更禁止/);
  assert.match(prompt, /5件以下.*subagentを使わず/);
  assert.match(prompt, /Chrome DevTools MCP/);
  assert.match(prompt, /組み合わせごとに1回/);
  assert.match(prompt, /全annotationを最後まで保留しない/);
  assert.equal(manager.enqueue({ cli: "claude", max_parallel: 4 }).jobs.length, 0);
  control.pending[0]!.resolve({ exitCode: 1, reason: "exit" });
  await manager.close();
  assert.equal(enqueued.jobs.length, 3);
  assert.ok(store.load().annotations.every(({ status }) => status === "open"));
});

test("requires addressed plus a new AI message for each successful job", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const succeededId = annotate(store, ".code/htmls/pages/a.html", "a");
  const failedId = annotate(store, ".code/htmls/pages/b.html", "b");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  manager.start();
  manager.enqueue({ cli: "claude", max_parallel: 2, session_id: "shared" });
  await waitFor(() => control.pending.length === 1);
  store.addMessage(succeededId, { actor: "ai", body: "implemented and verified" });
  store.setStatus(succeededId, { actor: "ai", status: "addressed" });
  control.pending[0]!.resolve({ exitCode: 0, reason: "exit" });
  await waitFor(() => manager.list().jobs.every(({ state }) => state === "succeeded" || state === "failed"));
  const byAnnotation = new Map(manager.list().jobs.map((job) => [job.annotation_id, job]));
  assert.equal(byAnnotation.get(succeededId)?.state, "succeeded");
  assert.equal(byAnnotation.get(failedId)?.state, "failed");
  assert.match(byAnnotation.get(failedId)?.summary ?? "", /postcondition/);
  assert.equal(store.load().annotations.find(({ id }) => id === succeededId)?.status, "addressed");
  assert.equal(store.load().annotations.find(({ id }) => id === failedId)?.status, "open");
  await manager.close();
});

test("fails a job when its page target is deleted while the coordinator runs", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const annotationId = annotate(store, store.entryPath, "delete during run");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  manager.start();
  manager.enqueue({ cli: "claude", max_parallel: 1 });
  await waitFor(() => control.pending.length === 1);
  store.addMessage(annotationId, { actor: "ai", body: "implemented and verified" });
  store.setStatus(annotationId, { actor: "ai", status: "addressed" });
  unlinkSync(store.targetPath);
  control.pending[0]!.resolve({ exitCode: 0, reason: "exit" });
  await waitFor(() => manager.list().jobs[0]?.state === "failed");
  assert.match(manager.list().jobs[0]?.summary ?? "", /page unavailable after coordinator exit/);
  await manager.close();
});

test("checks external hashes immediately before launch and contains missing targets per job", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  annotate(store, ".code/htmls/pages/a.html", "first batch");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  manager.start();
  manager.enqueue({ cli: "codex", max_parallel: 1 });
  await waitFor(() => control.pending.length === 1);
  const staleId = annotate(store, ".code/htmls/pages/b.html", "stale before launch");
  const queued = manager.enqueue({ cli: "codex", max_parallel: 1 });
  writeFileSync(path.join(root, ".code/htmls/pages/b.html"), "<h1>B external</h1>");
  control.pending[0]!.resolve({ exitCode: 1, reason: "exit" });
  await waitFor(() => manager.list().jobs.find(({ annotation_id }) => annotation_id === staleId)?.state === "skipped");
  assert.equal(control.pending.length, 1);
  assert.equal(manager.list().jobs.find(({ id }) => id === queued.jobs[0]!.id)?.state, "skipped");

  const missingId = annotate(store, ".code/htmls/pages/a.html", "missing before launch");
  const blocker = annotate(store, ".code/htmls/pages/b.html", "blocker");
  writeFileSync(path.join(root, ".code/htmls/pages/b.html"), "<h1>B external 2</h1>");
  const next = manager.enqueue({ cli: "opencode", max_parallel: 1 });
  assert.ok([missingId, blocker].some((id) => next.jobs.some((job) => job.annotation_id === id)));
  // Enqueue catches the stale blocker; removing A is caught as a launch-time per-job failure.
  unlinkSync(path.join(root, ".code/htmls/pages/a.html"));
  await waitFor(() => manager.list().jobs.find(({ annotation_id }) => annotation_id === missingId)?.state === "failed");
  await manager.close();
});

test("cancels queued jobs individually, running coordinator as a batch, and recovers restart state", async () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  const firstId = annotate(store, ".code/htmls/pages/a.html", "a");
  const secondId = annotate(store, ".code/htmls/pages/b.html", "b");
  const control = controlledExecutor();
  const manager = new JobManager(store, { executor: control.executor });
  manager.start();
  const jobs = manager.enqueue({ cli: "opencode", max_parallel: 1 }).jobs;
  await waitFor(() => control.pending.length === 1);
  const queuedId = annotate(store, ".code/htmls/pages/a.html", "queued later");
  const queuedJob = manager.enqueue({ cli: "claude", max_parallel: 1 }).jobs.find(({ annotation_id }) => annotation_id === queuedId)!;
  assert.equal(manager.cancel(queuedJob.id).state, "cancelled");
  manager.cancel(jobs[0]!.id);
  await waitFor(() => jobs.every((job) => manager.list().jobs.find(({ id }) => id === job.id)?.state === "cancelled"));
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
  restarted.start();
  assert.equal(restarted.list().jobs.find(({ id }) => id === "unknown")?.state, "failed");
  await waitFor(() => restartControl.pending.length === 1);
  assert.equal(restarted.list().jobs.find(({ id }) => id === "resume-queued")?.state, "running");
  await restarted.close();
});

test("marks source mismatch as skipped at enqueue time", () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  annotate(store, store.entryPath, "stale");
  writeFileSync(store.targetPath, "<h1>external</h1>");
  const manager = new JobManager(store, { executor: controlledExecutor().executor });
  manager.start();
  const result = manager.enqueue({ cli: "opencode", max_parallel: 1 });
  assert.equal(result.jobs[0]?.state, "skipped");
});

test("contains deleted, renamed, and unreadable targets as failed annotation jobs", async () => {
  for (const failure of ["deleted", "renamed", "permission"] as const) {
    const root = repository();
    const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
    annotate(store, store.entryPath, failure);
    const target = store.targetPath;
    if (failure === "deleted") unlinkSync(target);
    else if (failure === "renamed") renameSync(target, `${target}.moved`);
    else chmodSync(target, 0o000);
    try {
      const manager = new JobManager(store, { executor: controlledExecutor().executor });
      manager.start();
      const result = manager.enqueue({ cli: "opencode", max_parallel: 1 });
      assert.equal(result.jobs[0]?.state, "failed", failure);
      assert.match(result.jobs[0]?.summary ?? "", /page unavailable/, failure);
      await manager.close();
    } finally {
      if (failure === "permission") chmodSync(target, 0o600);
    }
  }
});

test("spawn executor enforces timeout, combined output limit, and cancellation", async () => {
  const run = (script: string, executor = createSpawnExecutor({ timeoutMs: 2_000, killGraceMs: 10 })) => executor({
    command: process.execPath as ReviewCli, args: ["-e", script], cwd: process.cwd(), env: { ...process.env },
  });
  const timeout = await run("setInterval(() => {}, 1000)", createSpawnExecutor({ timeoutMs: 20, killGraceMs: 10 }));
  assert.equal((await timeout.result).reason, "timeout");
  const output = await run("process.stdout.write('x'.repeat(100))", createSpawnExecutor({ outputLimit: 10, killGraceMs: 10 }));
  assert.equal((await output.result).reason, "output-limit");
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
  const id = annotate(store, store.entryPath, "fix");
  const reviewPath = path.relative(store.target.projectRoot, store.path).split(path.sep).join("/");
  const common = ["--project-root", root, "--review-path", reviewPath, "--annotation-id", id];
  await runAnnotationCli(["annotation", "add-message", ...common, "--actor", "ai", "--body-stdin"], "implemented\n");
  await runAnnotationCli(["annotation", "set-status", ...common, "--status", "addressed"]);
  const annotation = store.load().annotations.find((candidate) => candidate.id === id)!;
  assert.equal(annotation.status, "addressed");
  assert.equal(annotation.thread.at(-1)?.body, "implemented");
  assert.throws(() => parseAnnotationArguments(["annotation", "set-status", "--project-root", root, "--review-path", `./${reviewPath}`, "--annotation-id", id, "--status", "addressed"]), /canonical/);
});

test("job store rejects corrupt or data-bearing state instead of overwriting it", () => {
  const root = repository();
  const store = new ReviewStore(".code/htmls/pages/a.html", { projectRoot: root });
  store.load();
  const jobs = new JobStore(store.path);
  writeFileSync(jobs.path, JSON.stringify({ revision: 0, batches: [], jobs: [], prompt: "must not persist" }));
  assert.throws(() => jobs.load(), /invalid job-state\.json.*unknown field/);
});
