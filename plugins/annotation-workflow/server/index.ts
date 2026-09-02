import type { PluginServerContextV1, PluginServerProviderV1 } from "../../../src/plugin-server.js";
import type { ProcessSupervisorPortV1 } from "./adapters.js";
import { createSupervisorExecutor } from "./adapters.js";
import { JobManager, type JobManagerOptions } from "./job-manager.js";
import { parseRunnerSelection, updateWorkflowSettings, workflowSettingsProjection } from "./settings.js";
import type { ReviewCapabilityV1, RunnerRegistryV1, WorkflowTaskCapabilityV1 } from "./workflow-types.js";

export const ANNOTATION_WORKFLOW_CAPABILITY_ID = "annotation-workflow";
export const ANNOTATION_WORKFLOW_CAPABILITY_API_VERSION = 1;
export const REVIEW_CAPABILITY_ID = "review";
export const PROCESS_SUPERVISOR_CAPABILITY_ID = "host.process-supervisor";
export const RUNNER_REGISTRY_CAPABILITY_ID = "runner-registry";
export const ISSUE_TASK_CAPABILITY_ID = "issue-task";

export interface AnnotationWorkflowCapabilityV1 {
  readonly apiVersion: 1;
  readonly manager: JobManager;
}

export function createAnnotationWorkflowCapability(
  review: ReviewCapabilityV1,
  options: JobManagerOptions,
): AnnotationWorkflowCapabilityV1 {
  return Object.freeze({ apiVersion: 1 as const, manager: new JobManager(review, options) });
}

type BridgeRequest = { request_id: string; input: Record<string, unknown> };
type BridgeResult =
  | { ok: true; revision?: string; data: unknown; effects?: unknown[] }
  | { ok: false; error: { code: string; message: string; retryable: boolean; request_id: string } };

function bridgeError(request: BridgeRequest, code: string, message: string): BridgeResult {
  return { ok: false, error: { code, message, retryable: false, request_id: request.request_id } };
}

interface BridgeReviewStore {
  readonly target: { projectRoot: string };
  load(): { revision: number; annotations: Array<Record<string, unknown> & { id: string; status: string }>; events: Array<{ at: string; revision: number }> };
  loadActive(): unknown;
  addMessage(annotationId: string, payload: { actor: "human"; body: string }): unknown;
  setStatus(annotationId: string, payload: { actor: "human"; status: string }): unknown;
}

/** Plugin-owned bridge projection; the host only routes envelopes to it. */
export function createAnnotationWorkflowBridgeAdapter(review: ReviewCapabilityV1, manager: JobManager, runnerRegistry?: RunnerRegistryV1) {
  const store = review.store as unknown as BridgeReviewStore;
  const externalRunners = async () => runnerRegistry ? await runnerRegistry.list({ workspaceRoot: review.store.target.projectRoot }) : [];
  return Object.freeze({
    async query(name: string, request: BridgeRequest): Promise<BridgeResult> {
      const { input } = request;
      if (name === "annotations.list") {
        const aggregate = store.load();
        const statuses = Array.isArray(input.statuses) ? new Set(input.statuses.filter((item): item is string => typeof item === "string")) : null;
        const kinds = Array.isArray(input.kinds) ? new Set(input.kinds.filter((item): item is string => typeof item === "string")) : null;
        const labels: Record<string, string> = { open: "未対応", in_progress: "AI対応中", failed: "失敗", addressed: "AI対応済み", resolved: "解決済み" };
        const items = aggregate.annotations.filter((annotation) => (!statuses || statuses.has(annotation.status)) && (!kinds || kinds.has(String(annotation.kind))))
          .map((annotation) => ({ ...annotation, status_label: labels[annotation.status] ?? annotation.status, kind_label: annotation.kind === "dom" ? "ノード" : "範囲", thread: (Array.isArray(annotation.thread) ? annotation.thread : []).map((message) => ({ ...message, actor_label: message.actor === "ai" ? "AI" : "人間" })) }));
        return { ok: true, revision: `review:${aggregate.revision}`, data: { items, total: items.length, open_count: aggregate.annotations.filter(({ status }) => status === "open").length } };
      }
      if (name === "history.list") {
        const aggregate = store.load();
        const offset = Number.isSafeInteger(input.offset) ? input.offset as number : 0;
        const limit = Number.isSafeInteger(input.limit) ? input.limit as number : 24;
        const events = [...aggregate.events].sort((left, right) => Date.parse(right.at) - Date.parse(left.at) || right.revision - left.revision);
        const actorLabel = (actor: unknown): string => actor === "ai" ? "AI" : actor === "human" ? "人間" : "システム";
        const statusLabels: Record<string, string> = { open: "未対応", in_progress: "AI対応中", failed: "失敗", addressed: "AI対応済み", resolved: "解決済み" };
        const projected = events.slice(offset, offset + limit).map((event) => {
          const projectedEvent = event as unknown as { type?: string; actor?: unknown; details?: Record<string, unknown> };
          const details = projectedEvent.details ?? {};
          const summary = projectedEvent.type === "status_changed" ? `${actorLabel(projectedEvent.actor)}が状態を「${statusLabels[String(details.from)] ?? String(details.from ?? "不明")}」から「${statusLabels[String(details.to)] ?? String(details.to ?? "不明")}」に変更しました` : projectedEvent.type === "message_added" ? `${actorLabel(projectedEvent.actor)}が返信しました` : `${actorLabel(projectedEvent.actor)}が注釈を作成しました`;
          return { ...event, summary };
        });
        return { ok: true, revision: `review:${aggregate.revision}`, data: { events: projected, total: events.length, remaining: Math.max(0, events.length - offset - limit), next_offset: offset + limit } };
      }
      if (name === "jobs.list") {
        const data = manager.list();
        const runningJobs = data.jobs.filter(({ state }) => state === "running");
        const queued = data.jobs.filter(({ state }) => state === "queued").length;
        const active = runningJobs[0] ? {
          job_id: runningJobs[0].id,
          started_at: runningJobs.map(({ started, created }) => started ?? created).sort()[0]!,
          latest_info: `${runningJobs.length}件のAI修正を実行中です`,
        } : null;
        const running = runningJobs.length + queued;
        return { ok: true, data: { revision: data.revision, batches: data.batches.map(({ custom_command: _legacy, ...batch }) => batch), jobs: data.jobs.map(({ custom_name: _legacy, ...job }) => job), ...(active ? { active } : {}), announcement: running ? `${running}件のAI修正を処理中です` : "AI修正は待機中です" } };
      }
      if (name === "workflow.settings") return { ok: true, data: workflowSettingsProjection(review.store.target.projectRoot, await externalRunners()) };
      return bridgeError(request, "NOT_FOUND", "query is not declared by the plugin");
    },
    async command(name: string, request: BridgeRequest): Promise<BridgeResult> {
      const { input } = request;
      if (name === "annotation.reply" && typeof input.annotation_id === "string" && typeof input.comment === "string" && input.comment.trim()) {
        store.addMessage(input.annotation_id, { body: input.comment.trim(), actor: "human" });
        return { ok: true, revision: `review:${store.load().revision}`, data: store.loadActive(), effects: [{ type: "resource.invalidate", resources: ["annotations", "history"] }] };
      }
      if (name === "annotation.status" && typeof input.annotation_id === "string" && typeof input.status === "string") {
        store.setStatus(input.annotation_id, { status: input.status, actor: "human" });
        return { ok: true, revision: `review:${store.load().revision}`, data: store.loadActive(), effects: [{ type: "resource.invalidate", resources: ["annotations", "history", "session"] }] };
      }
      if (name === "workflow.settings.update") return { ok: true, data: updateWorkflowSettings(review.store.target.projectRoot, input, await externalRunners()), effects: [{ type: "resource.invalidate", resources: ["workflow-settings"] }] };
      if (name === "jobs.cancel" && typeof input.job_id === "string") {
        manager.cancel(input.job_id);
        return { ok: true, data: {}, effects: [{ type: "resource.invalidate", resources: ["jobs", "annotations"] }] };
      }
      if ((name === "jobs.enqueue" || name === "jobs.retry") && (name !== "jobs.retry" || typeof input.annotation_id === "string")) {
        const runners = await externalRunners();
        const settings = workflowSettingsProjection(review.store.target.projectRoot, runners);
        const selected = parseRunnerSelection(typeof input.runner === "string" ? input.runner : settings.runner);
        if (selected.runner_id && !runners.some(({ runner_id, verified }) => runner_id === selected.runner_id && verified)) throw new Error("選択した外部AIコマンドは未検証です。外部AIコマンド設定でテストを完了してください。");
        const enqueueInput = {
          ...selected,
          max_parallel: Number.isInteger(input.max_parallel) ? input.max_parallel as number : settings.max_parallel,
          ...(name === "jobs.enqueue" && typeof input.annotation_id === "string" ? { annotation_ids: [input.annotation_id] } : {}),
        };
        const data = name === "jobs.retry" ? manager.retry(input.annotation_id as string, enqueueInput) : manager.enqueue(enqueueInput);
        if (name === "jobs.enqueue" && typeof input.annotation_id === "string" && data.jobs.length !== 1) {
          return bridgeError(request, "CONFLICT", "この注釈はすでにAI修正中か、未対応ではありません。");
        }
        return { ok: true, data, effects: [{ type: "resource.invalidate", resources: ["jobs", "annotations"] }] };
      }
      return bridgeError(request, "NOT_FOUND", "command is not declared by the plugin");
    },
  });
}

const provider: PluginServerProviderV1 = Object.freeze({
  apiVersion: 1 as const,
  create(context: PluginServerContextV1) {
    const review = context.capability<ReviewCapabilityV1>(REVIEW_CAPABILITY_ID, 1);
    const supervisor = context.capability<ProcessSupervisorPortV1>(PROCESS_SUPERVISOR_CAPABILITY_ID, 1);
    let runnerRegistry: RunnerRegistryV1 | undefined;
    try { runnerRegistry = context.capability<RunnerRegistryV1>(RUNNER_REGISTRY_CAPABILITY_ID, 1); } catch { /* optional provider */ }
    let taskCapability: WorkflowTaskCapabilityV1 | undefined;
    try { taskCapability = context.capability<WorkflowTaskCapabilityV1>(ISSUE_TASK_CAPABILITY_ID, 1); } catch { /* optional provider */ }
    const capability = createAnnotationWorkflowCapability(review, {
      executor: createSupervisorExecutor(supervisor),
      ...(runnerRegistry ? { runnerRegistry } : {}),
      ...(taskCapability ? { taskCapability } : {}),
    });
    const unsupported = (_name: string, request: { request_id: string }) => Promise.resolve({
      ok: false as const,
      error: { code: "PLUGIN_PROTOCOL_ERROR" as const, message: "workflow operations are exposed through AnnotationWorkflowCapabilityV1", retryable: false as const, request_id: request.request_id },
    });
    return {
      start() { capability.manager.start(); },
      query: unsupported,
      command: unsupported,
      capabilities() { return [{ id: ANNOTATION_WORKFLOW_CAPABILITY_ID, apiVersion: 1 as const, implementation: capability }]; },
      stop() { return capability.manager.close(); },
    };
  },
});

export default provider;
export * from "./adapters.js";
export * from "./job-manager.js";
export * from "./job-store.js";
export * from "./settings.js";
export type * from "./workflow-types.js";
