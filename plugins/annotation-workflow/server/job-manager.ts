import { randomUUID } from "node:crypto";
import path from "node:path";

import type { CommandExecutor, CommandResult, RunningCommand } from "./adapters.js";
import { JobStore } from "./job-store.js";
import { createWorkflowRuntimeSnapshot, type WorkflowRuntimeSnapshot } from "./runtime-snapshot.js";
import type { AiCapabilityV1, EnqueueJobsInput, ReviewCapabilityV1, ReviewJob, ReviewJobState, WorkflowAnnotation } from "./workflow-types.js";

const ANNOTATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function now(): string { return new Date().toISOString(); }

export function validateEnqueueInput(value: Record<string, unknown>): { max_parallel: number; annotation_ids: string[] | null; cli?: undefined; runner_id?: undefined } {
  const allowed = new Set(["max_parallel", "annotation_ids"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("job batch contains an unknown field");
  if (!Number.isInteger(value.max_parallel) || (value.max_parallel as number) < 1 || (value.max_parallel as number) > 10) throw new Error("max_parallel must be an integer from 1 to 10");
  const annotationIds = value.annotation_ids === undefined ? null : value.annotation_ids;
  if (annotationIds !== null && (!Array.isArray(annotationIds) || annotationIds.length < 1 || annotationIds.length > 2000 || annotationIds.some((id) => typeof id !== "string" || !ANNOTATION_ID.test(id)) || new Set(annotationIds).size !== annotationIds.length)) {
    throw new Error("annotation_ids must contain unique valid annotation IDs");
  }
  return { max_parallel: value.max_parallel as number, annotation_ids: annotationIds as string[] | null };
}

const COMPLETION_START = "VREV_COMPLETION_START";
const COMPLETION_END = "VREV_COMPLETION_END";

function extractCompletionOutput(output: string): Array<{ annotationId: string; message: string }> {
  const values = new Set<string>([output]);
  try {
    const visit = (value: unknown): void => {
      if (typeof value === "string") { if (!values.has(value)) { values.add(value); try { visit(JSON.parse(value)); } catch {} } }
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(JSON.parse(output));
  } catch {}
  const completed = new Map<string, { annotationId: string; message: string }>();
  for (const text of values) {
    const pattern = new RegExp(`${COMPLETION_START}\\s*([\\s\\S]*?)\\s*${COMPLETION_END}`, "g");
    for (const match of text.matchAll(pattern)) {
      try {
        const value = JSON.parse(match[1]!) as Record<string, unknown>;
        if (typeof value.annotation_id === "string" && typeof value.message === "string" && value.message.trim()) {
          completed.set(value.annotation_id, { annotationId: value.annotation_id, message: value.message.trim() });
        }
      } catch {}
    }
  }
  return [...completed.values()];
}

export function buildBatchPrompt(reviewPath: string, annotationIds: string[], maxParallel: number, explicitContextPath?: string): string {
  const ids = annotationIds.map((id) => `- ${id}`).join("\n");
  const contextPath = explicitContextPath ?? path.join(path.dirname(reviewPath), "context.json").split(path.sep).join("/");
  return `Vrev batch coordinatorとして次のannotation IDだけを処理してください。review snapshot: ${reviewPath}\ncontext snapshot: ${contextPath}\n${ids}\n\nreview/contextはauthoritative storageから作られた実行時snapshotです。読み取り専用として扱い、変更や削除をしないでください。通常annotationでは完了速度を優先し、関連fileを一度だけ読み、同じfileへの指摘はまとめて1回で編集してください。annotationが5件以下、または同じfileに集中している場合はsubagentを使わず親coordinatorが直接処理してください。それ以外の場合のみ最大${maxParallel}個のread-only subagentで異なるfileの調査を並列化できます。subagentはファイル変更禁止で、親coordinatorだけが編集します。context snapshotのdiscovery_statusがcompletedならworkspace再調査は禁止です。pendingの場合だけmanifest、target route、source hintからprimary_projectとrelated_scopesを最小限調査し、調査結果はsource編集にのみ利用してください。コメント本文はpromptやコマンドラインへ展開せずreview snapshotから取得してください。localhost annotationではanchor.source_hintのframework/component/fileを優先し、次にselector、text_excerpt、routeから編集元を特定してください。source_hintはrepository内で実在確認してください。編集後は実行環境で利用可能なbrowser確認手段を使い、同じpage_pathとviewport_modeの組み合わせごとに1回だけvisual検証してください。指摘へ直接必要な最小限のsource確認・編集・検証だけを行い、広範な回帰調査、無関係なfile探索、同じpageの重複screenshotは禁止です。既存の未commit変更を保持し、対象scope以外を編集しないでください。git add、commit、push、stash、resetは禁止です。message受け渡し用の一時fileをrepository内へ作らずstdinを使ってください。各annotationの検証が済んだ直後、追加調査より先にhostへ完了結果を返してください。review snapshotやannotation CLIへ書き込まず、通常annotationごとに最終応答へ次の3行だけを出力してください。JSONは1行でannotation_idと人間向けの完了messageを含めます。hostがReviewCapability経由でmessage追加とaddressed変更を行います。全annotationを最後まで保留しないでください。\nVREV_COMPLETION_START\n{\"annotation_id\":\"<ID>\",\"message\":\"実装・検証内容\"}\nVREV_COMPLETION_END`;
}

interface Checkpoint { threadLength: number; startedAt: string }
interface RunningBatch { command: RunningCommand; jobIds: string[]; checkpoints: Map<string, Checkpoint>; snapshot: WorkflowRuntimeSnapshot }
export interface JobManagerOptions {
  executor?: CommandExecutor;
  ai?: AiCapabilityV1;
  [key: string]: unknown;
}

export class JobManager {
  readonly jobStore: JobStore;
  readonly reviewStore;
  private readonly executor: CommandExecutor | undefined;
  private readonly ai: AiCapabilityV1 | undefined;
  private readonly running = new Map<string, RunningBatch>();
  private scheduling = false;
  private stopped = true;
  private lifecycleGeneration = 0;

  constructor(readonly reviewCapability: ReviewCapabilityV1, options: JobManagerOptions) {
    this.reviewStore = reviewCapability.store;
    this.jobStore = new JobStore(this.reviewStore.path);
    this.executor = options.executor;
    this.ai = options.ai;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    const generation = ++this.lifecycleGeneration;
    this.jobStore.recoverRunning();
    await this.reconcileLateCompletionMessages();
    if (generation !== this.lifecycleGeneration) return;
    await this.reconcileInProgressAnnotations();
    if (generation !== this.lifecycleGeneration) return;
    this.stopped = false;
    this.schedule();
  }
  async list(): Promise<ReviewJobState> {
    await this.reconcileLateCompletionMessages();
    return this.jobStore.load();
  }

  async enqueue(rawInput: Record<string, unknown>): Promise<{ batch_id: string; jobs: ReviewJob[] }> {
    const input = validateEnqueueInput(rawInput);
    const review = await this.reviewStore.loadActive();
    const jobSnapshot = this.jobStore.load();
    const activeJobs = jobSnapshot.jobs.filter(({ state }) => state === "queued" || state === "running");
    const activeIds = new Set(activeJobs.map(({ annotation_id }) => annotation_id));
    const activePages = new Set(activeJobs.map(({ page_path }) => page_path));
    const selectedIds = input.annotation_ids ? new Set(input.annotation_ids) : null;
    const annotations = review.annotations.filter((annotation) => annotation.status === "open" && !activeIds.has(annotation.id) && (!selectedIds || selectedIds.has(annotation.id)));
    const batchId = randomUUID();
    const created = now();
    const candidates = annotations.map((annotation): ReviewJob => {
      let state: ReviewJob["state"] = "queued";
      let summary = "queued";
      let sourceHash = annotation.source_hash;
      try {
        sourceHash = this.pageHash(annotation);
      } catch (error) {
        state = "failed"; summary = `failed: page unavailable before enqueue (${this.errorMessage(error)})`;
      }
      return { id: randomUUID(), batch_id: batchId, annotation_id: annotation.id, page_path: annotation.page_path, source_hash: sourceHash, deferred_checkpoint: state === "queued" && activePages.has(annotation.page_path), cli: "ai", custom_name: null, session_id: null, state, created, started: null, finished: state === "queued" ? null : created, exit_code: null, summary };
    });
    const jobs: ReviewJob[] = [];
    if (candidates.length > 0) {
      this.jobStore.update((state) => {
        const claimed = new Set(state.jobs.filter(({ state: jobState }) => jobState === "queued" || jobState === "running").map(({ annotation_id }) => annotation_id));
        jobs.push(...candidates.filter(({ annotation_id }) => !claimed.has(annotation_id)));
        if (!jobs.length) return;
        state.batches.push({ id: batchId, max_parallel: input.max_parallel, opencode_attach: null, runner_id: null, custom_command: null });
        state.jobs.push(...jobs);
      });
      for (const job of jobs) {
        if (job.state === "queued") await this.reviewStore.setStatus(job.annotation_id, { actor: "ai", status: "in_progress" });
        else if (job.state === "failed" || job.state === "skipped") await this.markAnnotationFailed(job.annotation_id, job.summary);
      }
    }
    this.schedule();
    return { batch_id: batchId, jobs };
  }

  async retry(annotationId: string, rawInput: Record<string, unknown>): Promise<{ batch_id: string; jobs: ReviewJob[] }> {
    const active0 = await this.reviewStore.loadActive();
    const annotation = active0.annotations.find(({ id }) => id === annotationId);
    if (!annotation || annotation.status !== "failed") throw new Error("再実行できる失敗状態の注釈が見つかりません。");
    const active = this.jobStore.load().jobs.some((job) => job.annotation_id === annotationId && (job.state === "queued" || job.state === "running"));
    if (active) throw new Error("この注釈のAI修正はすでに実行中です。");
    validateEnqueueInput({ ...rawInput, annotation_ids: [annotationId] });
    await this.reviewStore.setStatus(annotationId, { actor: "human", status: "open" });
    try {
      const result = await this.enqueue({ ...rawInput, annotation_ids: [annotationId] });
      if (result.jobs.length !== 1) throw new Error("再実行するAIジョブを開始できませんでした。");
      return result;
    } catch (error) {
      const currentActive = await this.reviewStore.loadActive();
      const current = currentActive.annotations.find(({ id }) => id === annotationId);
      if (current?.status === "open") await this.reviewStore.setStatus(annotationId, { actor: "ai", status: "failed" });
      throw error;
    }
  }

  async cancel(id: string): Promise<ReviewJob> {
    const existing = this.jobStore.load().jobs.find((job) => job.id === id);
    if (!existing) throw new Error(`job not found: ${id}`);
    if (existing.state === "queued") {
      const timestamp = now();
      const state = this.jobStore.update((stored) => {
        const job = stored.jobs.find((candidate) => candidate.id === id);
        if (job?.state === "queued") { job.state = "cancelled"; job.finished = timestamp; job.summary = "cancelled before start"; }
      });
      await this.reopenInProgressAnnotation(existing.annotation_id);
      this.schedule();
      return state.jobs.find((job) => job.id === id)!;
    }
    if (existing.state === "running") this.running.get(existing.batch_id)?.command.cancel();
    return this.jobStore.load().jobs.find((job) => job.id === id)!;
  }

  async close(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.stopped = true;
    const batches = [...this.running.values()];
    batches.forEach(({ command }) => command.cancel());
    await Promise.allSettled(batches.map(({ command }) => command.result));
    await Promise.allSettled(batches.map(({ snapshot }) => snapshot.cleanup()));
  }

  private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private failureDescription(summary: string): string {
    if (summary.includes("postcondition not met")) return "AIコマンドは終了しましたが、修正完了メッセージまたは状態更新を確認できませんでした。";
    if (summary.includes("timed out")) return "AI処理がタイムアウトしました。";
    if (summary.includes("output exceeded")) return "AIコマンドの出力上限を超えました。";
    if (summary.includes("could not start") || summary.includes("spawn")) return "AIコマンドを起動できませんでした。";
    if (summary.includes("source changed")) return "AI開始前に対象ページが更新されたため、安全のため処理を停止しました。";
    if (summary.includes("page unavailable")) return "対象ページを確認できなかったため、AI修正を完了できませんでした。";
    if (summary.includes("review unavailable")) return "reviewデータを読み込めなかったため、AI修正を完了できませんでした。";
    if (summary.includes("annotation missing")) return "対象の注釈が見つからなかったため、AI修正を完了できませんでした。";
    const exit = summary.match(/coordinator exit ([^ )]+)/)?.[1];
    if (exit) return `AIコマンドが終了コード${exit}で失敗しました。`;
    return "AI修正を完了できませんでした。";
  }
  private async markAnnotationFailed(annotationId: string, summary: string): Promise<void> {
    try {
      const active = await this.reviewStore.loadActive();
      const annotation = active.annotations.find(({ id }) => id === annotationId);
      if (!annotation || !["open", "in_progress"].includes(annotation.status)) return;
      await this.reviewStore.addMessage(annotationId, { actor: "ai", body: `AI修正に失敗しました。${this.failureDescription(summary)}` });
      await this.reviewStore.setStatus(annotationId, { actor: "ai", status: "failed" });
    } catch { /* annotation already changed or review unavailable */ }
  }
  private async markAnnotationAddressed(annotationId: string): Promise<void> {
    try {
      const active = await this.reviewStore.loadActive();
      const annotation = active.annotations.find(({ id }) => id === annotationId);
      if (annotation && ["open", "in_progress", "failed"].includes(annotation.status)) {
        await this.reviewStore.setStatus(annotationId, { actor: "ai", status: "addressed" });
      }
    } catch { /* annotation already changed or review unavailable */ }
  }
  private isCompletionMessage(message: WorkflowAnnotation["thread"][number], startedAt: string): boolean {
    return message.actor === "ai" && message.at >= startedAt && !message.body.startsWith("AI修正に失敗しました。");
  }
  private async reconcileLateCompletionMessages(): Promise<void> {
    let annotations: WorkflowAnnotation[];
    try { annotations = (await this.reviewStore.loadActive()).annotations; } catch { return; }
    const snapshot = this.jobStore.load();
    const latest = new Map<string, ReviewJob>();
    for (const job of snapshot.jobs) latest.set(job.annotation_id, job);
    const completed = [...latest.values()].filter((job) =>
      job.state === "failed"
      && job.exit_code === 0
      && job.summary.includes("annotation postcondition not met")
      && Boolean(job.started),
    );
    if (completed.length === 0) return;
    const ids = new Set(completed.map(({ id }) => id));
    const completionMessageIds = new Set(completed.filter((job) => {
      const annotation = annotations.find(({ id }) => id === job.annotation_id);
      return annotation?.thread.some((message) => this.isCompletionMessage(message, job.started!)) === true;
    }).map(({ id }) => id));
    this.jobStore.update((state) => {
      for (const job of state.jobs) if (ids.has(job.id) && job.state === "failed") {
        job.state = "succeeded";
        job.summary = completionMessageIds.has(job.id)
          ? "succeeded: AI completion message received"
          : "succeeded: coordinator exited normally; human verification required";
      }
    });
    for (const job of completed) {
      const annotation = annotations.find(({ id }) => id === job.annotation_id);
      const hasCompletionMessage = annotation?.thread.some((message) => this.isCompletionMessage(message, job.started!)) === true;
      if (annotation && !hasCompletionMessage) {
        try { await this.reviewStore.addMessage(job.annotation_id, { actor: "ai", body: "AI処理が完了しました。変更内容は人間による確認が必要です。" }); } catch { /* archived or already changed */ }
      }
      await this.markAnnotationAddressed(job.annotation_id);
    }
  }
  private async reopenInProgressAnnotation(annotationId: string): Promise<void> {
    try { await this.reviewStore.setStatus(annotationId, { actor: "ai", status: "open" }); } catch { /* status already changed or review unavailable */ }
  }
  private async reconcileInProgressAnnotations(): Promise<void> {
    const active = new Set(this.jobStore.load().jobs.filter(({ state }) => state === "queued" || state === "running").map(({ annotation_id }) => annotation_id));
    const currentActive = await this.reviewStore.loadActive();
    for (const annotation of currentActive.annotations) {
      if (annotation.status === "in_progress" && !active.has(annotation.id)) await this.reopenInProgressAnnotation(annotation.id);
    }
  }
  private pageHash(annotation: Pick<WorkflowAnnotation, "page_path">): string {
    return this.reviewStore.sourceHash(annotation.page_path);
  }
  private schedule(): void {
    if (this.stopped || this.scheduling) return;
    this.scheduling = true;
    // A macrotask boundary lets the enqueue caller finish immediate workspace changes before the
    // launch checkpoint is evaluated; the checkpoint remains the authoritative pre-launch guard.
    setImmediate(() => { void this.dispatchAvailable().catch(() => undefined).finally(() => {
      this.scheduling = false;
      if (!this.stopped && this.running.size === 0 && this.jobStore.load().jobs.some(({ state }) => state === "queued")) this.schedule();
    }); });
  }

  private async dispatchAvailable(): Promise<void> {
    if (this.stopped || this.running.size > 0) return;
    const generation = this.lifecycleGeneration;
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
        const currentHash = this.pageHash(job);
        if (job.deferred_checkpoint) {
          job.source_hash = currentHash;
          job.deferred_checkpoint = false;
          this.jobStore.update((state) => {
            const stored = state.jobs.find(({ id }) => id === job.id);
            if (stored?.state === "queued") {
              stored.source_hash = currentHash;
              stored.deferred_checkpoint = false;
            }
          });
          launchable.push(job);
        } else if (currentHash === job.source_hash) launchable.push(job);
        else await this.finishBeforeLaunch(job.id, "skipped", "skipped: source changed before coordinator launch", timestamp);
      } catch (error) {
        await this.finishBeforeLaunch(job.id, "failed", `failed: page unavailable before coordinator launch (${this.errorMessage(error)})`, timestamp);
      }
    }
    if (launchable.length === 0) { queueMicrotask(() => this.schedule()); return; }
    let review;
    try {
      review = await this.reviewStore.loadActive();
    } catch (error) {
      for (const job of launchable) {
        await this.finishBeforeLaunch(job.id, "failed", `failed: review unavailable before coordinator launch (${this.errorMessage(error)})`, timestamp);
      }
      queueMicrotask(() => this.schedule());
      return;
    }
    if (this.stopped || generation !== this.lifecycleGeneration) return;
    const checkpoints = new Map<string, Checkpoint>();
    for (const job of launchable) {
      const annotation = review.annotations.find(({ id }) => id === job.annotation_id);
      if (!annotation) {
        await this.finishBeforeLaunch(job.id, "failed", "failed: annotation missing before coordinator launch", timestamp);
      } else checkpoints.set(job.id, { threadLength: annotation.thread.length, startedAt: timestamp });
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
    let runtimeSnapshot: WorkflowRuntimeSnapshot;
    try {
      runtimeSnapshot = await createWorkflowRuntimeSnapshot(this.reviewStore, claimed.map(({ annotation_id }) => annotation_id), review);
    } catch {
      await this.finishBatch(batch.id, { exitCode: null, reason: "spawn-error" }, claimed.map(({ id }) => id), checkpoints);
      return;
    }
    if (this.stopped || generation !== this.lifecycleGeneration) {
      await runtimeSnapshot.cleanup();
      await this.finishBatch(batch.id, { exitCode: null, reason: "cancelled" }, claimed.map(({ id }) => id), checkpoints);
      return;
    }
    const prompt = buildBatchPrompt(
      runtimeSnapshot.reviewPath,
      claimed.map(({ annotation_id }) => annotation_id),
      batch.max_parallel,
      runtimeSnapshot.contextPath,
    );
    let command: RunningCommand;
    try {
      if (this.ai) {
        const invocation = await this.ai.invoke({
          mode: "workspace-write",
          prompt,
          timeout_ms: 10 * 60 * 1000,
          output_limit_bytes: 64 * 1024,
        });
        command = {
          cancel: () => invocation.cancel(),
          result: invocation.result.then((result) => ({
            exitCode: result.exit_code,
            reason: result.status === "completed" ? "exit" : result.status === "failed" ? "spawn-error" : result.status,
            output: result.output,
          })),
        };
      } else {
        if (!this.executor) throw new Error("AI package is unavailable");
        command = this.executor({ command: "vrev-ai", args: [prompt], cwd: this.reviewStore.target.projectRoot, env: { ...process.env } });
      }
      if (this.stopped || generation !== this.lifecycleGeneration) {
        command.cancel();
        await runtimeSnapshot.cleanup();
        await this.finishBatch(batch.id, { exitCode: null, reason: "cancelled" }, claimed.map(({ id }) => id), checkpoints);
        return;
      }
    } catch (error) {
      await runtimeSnapshot.cleanup();
      await this.finishBatch(batch.id, { exitCode: null, reason: "spawn-error" }, claimed.map(({ id }) => id), checkpoints);
      return;
    }
    this.running.set(batch.id, { command, jobIds: claimed.map(({ id }) => id), checkpoints, snapshot: runtimeSnapshot });
    void command.result.then((result) => this.finishBatch(batch.id, result, claimed.map(({ id }) => id), checkpoints, runtimeSnapshot), () => this.finishBatch(batch.id, { exitCode: null, reason: "spawn-error" }, claimed.map(({ id }) => id), checkpoints, runtimeSnapshot));
  }

  private async finishBeforeLaunch(id: string, stateValue: "failed" | "skipped", summary: string, timestamp: string): Promise<void> {
    const state = this.jobStore.update((stored) => {
      const job = stored.jobs.find((candidate) => candidate.id === id);
      if (job?.state === "queued") { job.state = stateValue; job.finished = timestamp; job.summary = summary; }
    });
    const job = state.jobs.find((candidate) => candidate.id === id);
    if (job) await this.markAnnotationFailed(job.annotation_id, job.summary);
  }

  private async finishBatch(batchId: string, result: CommandResult, jobIds: string[], checkpoints: Map<string, Checkpoint>, runtimeSnapshot?: WorkflowRuntimeSnapshot): Promise<void> {
    if (runtimeSnapshot) await runtimeSnapshot.cleanup().catch(() => undefined);
    this.running.delete(batchId);
    if (result.output) {
      const jobs = this.jobStore.load().jobs.filter(({ id }) => jobIds.includes(id));
      const allowedAnnotationIds = new Set(jobs.map(({ annotation_id }) => annotation_id));
      for (const completion of extractCompletionOutput(result.output)) {
        if (!allowedAnnotationIds.has(completion.annotationId)) continue;
        try { await this.reviewStore.addMessage(completion.annotationId, { actor: "ai", body: completion.message }); } catch {}
      }
    }
    const timestamp = now();
    let annotations: WorkflowAnnotation[] = [];
    let reviewError: unknown;
    try { annotations = (await this.reviewStore.loadActive()).annotations; } catch (error) { reviewError = error; }
    let resolvedAnnotations: WorkflowAnnotation[] = [];
    if (!reviewError && jobIds.some((id) => {
      const job = this.jobStore.load().jobs.find((candidate) => candidate.id === id);
      return job && !annotations.some(({ id: annotationId }) => annotationId === job.annotation_id);
    })) {
      try { resolvedAnnotations = (await this.reviewStore.load()).annotations.filter(({ status }) => status === "resolved"); } catch { /* handled as a missing annotation below */ }
    }
    const needsVerificationMessage = new Set<string>();
    const finalState = this.jobStore.update((state) => {
      for (const job of state.jobs) {
        if (!jobIds.includes(job.id) || job.state !== "running") continue;
        job.finished = timestamp; job.exit_code = result.exitCode;
        const annotation = annotations.find(({ id }) => id === job.annotation_id) ?? resolvedAnnotations.find(({ id }) => id === job.annotation_id);
        const checkpoint = checkpoints.get(job.id);
        const hasNewAiMessage = Boolean(annotation && checkpoint && annotation.thread.slice(checkpoint.threadLength).some((message) => this.isCompletionMessage(message, checkpoint.startedAt)));
        const hasDurableCompletion = hasNewAiMessage;
        let completionPageAvailable = true;
        try { this.pageHash(job); } catch { completionPageAvailable = false; }
        const processFailed = result.reason !== "exit" || result.exitCode !== 0;
        if (hasDurableCompletion && (processFailed || completionPageAvailable)) {
          job.state = "succeeded";
          job.summary = result.reason === "exit" && result.exitCode === 0
            ? "succeeded: AI completion message received"
            : `succeeded: completion persisted before coordinator ${result.reason}`;
          continue;
        }
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
        if (reviewError) {
          job.state = "failed";
          job.summary = `failed: could not verify annotation (${this.errorMessage(reviewError)})`;
          continue;
        }
        if (!annotation) {
          job.state = "failed";
          job.summary = "failed: annotation missing after coordinator exit";
          continue;
        }
        job.state = "succeeded";
        if (hasNewAiMessage) job.summary = "succeeded: AI completion message received";
        else {
          job.summary = "succeeded: coordinator exited normally; human verification required";
          needsVerificationMessage.add(job.id);
        }
      }
    });
    for (const job of finalState.jobs) {
      if (!jobIds.includes(job.id)) continue;
      if (job.state === "succeeded") {
        if (needsVerificationMessage.has(job.id)) {
          try {
            await this.reviewStore.addMessage(job.annotation_id, { actor: "ai", body: "AI処理が完了しました。変更内容は人間による確認が必要です。" });
          } catch { /* annotation already changed or review unavailable */ }
        }
        await this.markAnnotationAddressed(job.annotation_id);
      } else if (job.state === "cancelled") await this.reopenInProgressAnnotation(job.annotation_id);
      else await this.markAnnotationFailed(job.annotation_id, job.summary);
    }
    this.schedule();
  }
}
