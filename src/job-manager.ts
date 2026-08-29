import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCommand, createSpawnExecutor, parseCustomCommand, type CommandExecutor, type CommandResult, type RunningCommand } from "./adapters.js";
import { JobStore } from "./job-store.js";
import { ReviewStore } from "./review-store.js";
import type { Annotation, EnqueueJobsInput, ReviewJob, ReviewJobState } from "./types.js";

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function now(): string { return new Date().toISOString(); }

function validateAttach(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("opencode_attach must be a loopback HTTP URL"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("opencode_attach must be a loopback HTTP URL without credentials, query, or fragment");
  }
  return value;
}

export function validateEnqueueInput(value: Record<string, unknown>): Required<EnqueueJobsInput> {
  const allowed = new Set(["cli", "max_parallel", "session_id", "opencode_attach", "custom_name", "custom_command"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("job batch contains an unknown field");
  if (!["opencode", "claude", "codex", "copilot", "pi", "custom"].includes(String(value.cli))) throw new Error("cli is unsupported");
  if (!Number.isInteger(value.max_parallel) || (value.max_parallel as number) < 1 || (value.max_parallel as number) > 10) throw new Error("max_parallel must be an integer from 1 to 10");
  const sessionId = value.session_id === undefined ? null : value.session_id;
  if (sessionId !== null && (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))) throw new Error("session_id is invalid");
  if (sessionId !== null && value.cli !== "opencode" && value.cli !== "claude" && value.cli !== "codex") throw new Error("session_id is not available for this CLI");
  const attach = value.opencode_attach === undefined ? null : value.opencode_attach;
  if (attach !== null && typeof attach !== "string") throw new Error("opencode_attach must be a string or null");
  if (attach !== null && value.cli !== "opencode") throw new Error("opencode_attach is only valid for opencode");
  const customName = value.custom_name === undefined ? null : value.custom_name;
  const customCommand = value.custom_command === undefined ? null : value.custom_command;
  if (value.cli === "custom") {
    if (typeof customName !== "string" || !customName.trim() || customName.length > 80) throw new Error("custom_name must be 1 to 80 characters");
    if (typeof customCommand !== "string" || !customCommand.trim() || customCommand.length > 2000 || /[\0\r\n]/.test(customCommand)) throw new Error("custom_command must be a single nonblank line up to 2000 characters");
    parseCustomCommand(customCommand, "validation-prompt");
  } else if (customName !== null || customCommand !== null) throw new Error("custom command fields require cli=custom");
  return { cli: value.cli as Required<EnqueueJobsInput>["cli"], max_parallel: value.max_parallel as number, session_id: sessionId, opencode_attach: attach === null ? null : validateAttach(attach), custom_name: customName, custom_command: customCommand };
}

function shellDisplay(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export function buildBatchPrompt(reviewPath: string, annotationIds: string[], maxParallel: number, cliPath = "dist/src/cli.js"): string {
  const ids = annotationIds.map((id) => `- ${id}`).join("\n");
  const cli = `node ${shellDisplay(cliPath)} annotation`;
  const contextPath = path.posix.join(path.posix.dirname(reviewPath), "context.json");
  return `Visual review batch coordinatorとして次のannotation IDだけを処理してください。review file: ${reviewPath}\ncontext file: ${contextPath}\n${ids}\n\n完了速度を優先し、関連fileを一度だけ読み、同じfileへの指摘はまとめて1回で編集してください。annotationが5件以下、または同じfileに集中している場合はsubagentを使わず親coordinatorが直接処理してください。それ以外の場合のみ最大${maxParallel}個のread-only subagentで異なるfileの調査を並列化できます。subagentはファイル変更禁止で、親coordinatorだけが編集します。context fileのdiscovery_statusがcompletedならworkspace再調査は禁止です。pendingの場合だけmanifest、target route、source hintからprimary_projectとrelated_scopesを最小限調査し、repository相対pathでcompletedへ更新してください。コメント本文はpromptやコマンドラインへ展開せずreview fileから取得してください。localhost annotationではanchor.source_hintのframework/component/fileを優先し、次にselector、text_excerpt、routeから編集元を特定してください。source_hintはrepository内で実在確認してください。編集後は実行環境で利用可能なbrowser確認手段を使い、同じpage_pathとviewport_modeの組み合わせごとに1回だけvisual検証してください。指摘へ直接必要な最小限のsource確認・編集・検証だけを行い、広範な回帰調査、無関係なfile探索、同じpageの重複screenshotは禁止です。既存の未commit変更を保持し、対象scope以外を編集しないでください。git add、commit、push、stash、resetは禁止です。message受け渡し用の一時fileをrepository内へ作らずstdinを使ってください。各annotationの検証が済んだ直後、追加調査より先にAI message追加とaddressed変更を実行してください。全annotationを最後まで保留しないでください。\n${cli} add-message --project-root . --review-path ${shellDisplay(reviewPath)} --annotation-id <ID> --actor ai --body-stdin\n${cli} set-status --project-root . --review-path ${shellDisplay(reviewPath)} --annotation-id <ID> --status addressed`;
}

interface Checkpoint { threadLength: number; updatedAt: string; startedAt: string }
interface RunningBatch { command: RunningCommand; jobIds: string[]; checkpoints: Map<string, Checkpoint> }
export interface JobManagerOptions { executor?: CommandExecutor }

export class JobManager {
  readonly jobStore: JobStore;
  private readonly executor: CommandExecutor;
  private readonly reviewPath: string;
  private readonly running = new Map<string, RunningBatch>();
  private scheduling = false;
  private stopped = true;

  constructor(readonly reviewStore: ReviewStore, options: JobManagerOptions = {}) {
    this.jobStore = new JobStore(reviewStore.path);
    this.executor = options.executor ?? createSpawnExecutor();
    this.reviewPath = path.relative(reviewStore.target.projectRoot, reviewStore.path).split(path.sep).join("/");
  }

  start(): void {
    if (!this.stopped) return;
    this.jobStore.recoverRunning();
    this.reconcileInProgressAnnotations();
    this.stopped = false;
    this.schedule();
  }
  list(): ReviewJobState { return this.jobStore.load(); }

  enqueue(rawInput: Record<string, unknown>): { batch_id: string; jobs: ReviewJob[] } {
    const input = validateEnqueueInput(rawInput);
    const review = this.reviewStore.load();
    const activeIds = new Set(this.jobStore.load().jobs.filter(({ state }) => state === "queued" || state === "running").map(({ annotation_id }) => annotation_id));
    const annotations = review.annotations.filter(({ status, id }) => status === "open" && !activeIds.has(id));
    const batchId = randomUUID();
    const created = now();
    const jobs = annotations.map((annotation): ReviewJob => {
      let state: ReviewJob["state"] = "queued";
      let summary = "queued";
      try {
        if (this.pageHash(annotation) !== annotation.source_hash) { state = "skipped"; summary = "skipped: source changed before enqueue"; }
      } catch (error) {
        state = "failed"; summary = `failed: page unavailable before enqueue (${this.errorMessage(error)})`;
      }
      return { id: randomUUID(), batch_id: batchId, annotation_id: annotation.id, page_path: annotation.page_path, source_hash: annotation.source_hash, cli: input.cli, custom_name: input.custom_name, session_id: input.session_id, state, created, started: null, finished: state === "queued" ? null : created, exit_code: null, summary };
    });
    if (jobs.length > 0) {
      this.jobStore.update((state) => {
        state.batches.push({ id: batchId, max_parallel: input.max_parallel, opencode_attach: input.opencode_attach, custom_command: input.custom_command });
        state.jobs.push(...jobs);
      });
      for (const job of jobs) if (job.state === "queued") this.reviewStore.setStatus(job.annotation_id, { actor: "ai", status: "in_progress" });
    }
    this.schedule();
    return { batch_id: batchId, jobs };
  }

  cancel(id: string): ReviewJob {
    const existing = this.jobStore.load().jobs.find((job) => job.id === id);
    if (!existing) throw new Error(`job not found: ${id}`);
    if (existing.state === "queued") {
      const timestamp = now();
      const state = this.jobStore.update((stored) => {
        const job = stored.jobs.find((candidate) => candidate.id === id);
        if (job?.state === "queued") { job.state = "cancelled"; job.finished = timestamp; job.summary = "cancelled before start"; }
      });
      this.reopenInProgressAnnotation(existing.annotation_id);
      this.schedule();
      return state.jobs.find((job) => job.id === id)!;
    }
    if (existing.state === "running") this.running.get(existing.batch_id)?.command.cancel();
    return this.jobStore.load().jobs.find((job) => job.id === id)!;
  }

  async close(): Promise<void> {
    this.stopped = true;
    const batches = [...this.running.values()];
    batches.forEach(({ command }) => command.cancel());
    await Promise.allSettled(batches.map(({ command }) => command.result));
  }

  private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private reopenInProgressAnnotation(annotationId: string): void {
    try { this.reviewStore.setStatus(annotationId, { actor: "ai", status: "open" }); } catch { /* status already changed or review unavailable */ }
  }
  private reconcileInProgressAnnotations(): void {
    const active = new Set(this.jobStore.load().jobs.filter(({ state }) => state === "queued" || state === "running").map(({ annotation_id }) => annotation_id));
    for (const annotation of this.reviewStore.load().annotations) {
      if (annotation.status === "in_progress" && !active.has(annotation.id)) this.reopenInProgressAnnotation(annotation.id);
    }
  }
  private pageHash(annotation: Pick<Annotation, "page_path">): string {
    return this.reviewStore.sourceHash(annotation.page_path);
  }
  private schedule(): void {
    if (this.stopped || this.scheduling) return;
    this.scheduling = true;
    queueMicrotask(() => { try { this.dispatchAvailable(); } catch { /* a job error must not stop future scheduling */ } finally { this.scheduling = false; } });
  }

  private dispatchAvailable(): void {
    if (this.stopped || this.running.size > 0) return;
    const snapshot = this.jobStore.load();
    const candidate = snapshot.jobs.find(({ state }) => state === "queued");
    if (!candidate) return;
    const batch = snapshot.batches.find(({ id }) => id === candidate.batch_id);
    if (!batch) return;
    const candidates = snapshot.jobs.filter(({ batch_id, state }) => batch_id === batch.id && state === "queued");
    const launchable: ReviewJob[] = [];
    const timestamp = now();
    for (const job of candidates) {
      try {
        if (this.pageHash(job) === job.source_hash) launchable.push(job);
        else this.finishBeforeLaunch(job.id, "skipped", "skipped: source changed before coordinator launch", timestamp);
      } catch (error) {
        this.finishBeforeLaunch(job.id, "failed", `failed: page unavailable before coordinator launch (${this.errorMessage(error)})`, timestamp);
      }
    }
    if (launchable.length === 0) { queueMicrotask(() => this.schedule()); return; }
    let review;
    try {
      review = this.reviewStore.load();
    } catch (error) {
      for (const job of launchable) {
        this.finishBeforeLaunch(job.id, "failed", `failed: review unavailable before coordinator launch (${this.errorMessage(error)})`, timestamp);
      }
      queueMicrotask(() => this.schedule());
      return;
    }
    const checkpoints = new Map<string, Checkpoint>();
    for (const job of launchable) {
      const annotation = review.annotations.find(({ id }) => id === job.annotation_id);
      if (!annotation) {
        this.finishBeforeLaunch(job.id, "failed", "failed: annotation missing before coordinator launch", timestamp);
      } else checkpoints.set(job.id, { threadLength: annotation.thread.length, updatedAt: annotation.updated_at, startedAt: timestamp });
    }
    const claimIds = new Set(checkpoints.keys());
    if (claimIds.size === 0) { queueMicrotask(() => this.schedule()); return; }
    const claimed: ReviewJob[] = [];
    this.jobStore.update((state) => {
      for (const job of state.jobs) if (claimIds.has(job.id) && job.state === "queued") {
        job.state = "running"; job.started = timestamp; job.summary = "running in batch coordinator"; claimed.push(structuredClone(job));
      }
    });
    if (claimed.length === 0) { queueMicrotask(() => this.schedule()); return; }
    const prompt = buildBatchPrompt(this.reviewPath, claimed.map(({ annotation_id }) => annotation_id), batch.max_parallel, fileURLToPath(new URL("./cli.js", import.meta.url)));
    let command: RunningCommand;
    try {
      command = this.executor(buildCommand({ cli: claimed[0]!.cli, prompt, projectRoot: this.reviewStore.target.projectRoot, sessionId: claimed[0]!.session_id, opencodeAttach: batch.opencode_attach, customCommand: batch.custom_command }));
    } catch (error) {
      this.finishBatch(batch.id, { exitCode: null, reason: "spawn-error" }, claimed.map(({ id }) => id), checkpoints);
      return;
    }
    this.running.set(batch.id, { command, jobIds: claimed.map(({ id }) => id), checkpoints });
    void command.result.then((result) => this.finishBatch(batch.id, result, claimed.map(({ id }) => id), checkpoints), () => this.finishBatch(batch.id, { exitCode: null, reason: "spawn-error" }, claimed.map(({ id }) => id), checkpoints));
  }

  private finishBeforeLaunch(id: string, stateValue: "failed" | "skipped", summary: string, timestamp: string): void {
    const state = this.jobStore.update((stored) => {
      const job = stored.jobs.find((candidate) => candidate.id === id);
      if (job?.state === "queued") { job.state = stateValue; job.finished = timestamp; job.summary = summary; }
    });
    const job = state.jobs.find((candidate) => candidate.id === id);
    if (job) this.reopenInProgressAnnotation(job.annotation_id);
  }

  private finishBatch(batchId: string, result: CommandResult, jobIds: string[], checkpoints: Map<string, Checkpoint>): void {
    this.running.delete(batchId);
    const timestamp = now();
    let annotations: Annotation[] = [];
    let reviewError: unknown;
    try { annotations = this.reviewStore.load().annotations; } catch (error) { reviewError = error; }
    const finalState = this.jobStore.update((state) => {
      for (const job of state.jobs) {
        if (!jobIds.includes(job.id) || job.state !== "running") continue;
        job.finished = timestamp; job.exit_code = result.exitCode;
        if (result.reason === "cancelled") { job.state = "cancelled"; job.summary = "cancelled: batch coordinator stopped"; continue; }
        if (result.reason !== "exit" || result.exitCode !== 0) {
          job.state = "failed";
          job.summary = result.reason === "timeout" ? "failed: coordinator timed out" : result.reason === "output-limit" ? "failed: coordinator output exceeded limit" : result.reason === "spawn-error" ? "failed: coordinator could not start" : `failed: coordinator exit ${result.exitCode ?? "unknown"}`;
          continue;
        }
        try {
          this.pageHash(job);
        } catch (error) {
          job.state = "failed";
          job.summary = `failed: page unavailable after coordinator exit (${this.errorMessage(error)})`;
          continue;
        }
        const checkpoint = checkpoints.get(job.id)!;
        const annotation = annotations.find(({ id }) => id === job.annotation_id);
        const hasNewAiMessage = annotation?.thread.slice(checkpoint.threadLength).some((message) => message.actor === "ai" && message.at >= checkpoint.startedAt) === true;
        if (annotation?.status === "addressed" && annotation.updated_at !== checkpoint.updatedAt && hasNewAiMessage) {
          job.state = "succeeded"; job.summary = "succeeded: addressed with a new AI message";
        } else {
          job.state = "failed";
          job.summary = reviewError ? `failed: could not verify annotation (${this.errorMessage(reviewError)})` : "failed: annotation postcondition not met";
        }
      }
    });
    for (const job of finalState.jobs) {
      if (jobIds.includes(job.id) && job.state !== "succeeded") this.reopenInProgressAnnotation(job.annotation_id);
    }
    this.schedule();
  }
}
