import type { PluginServerContextV1, PluginServerProviderV1 } from "../../../src/plugin-server.js";
import type { ProcessSupervisorPortV1 } from "./adapters.js";
import { createSupervisorExecutor } from "./adapters.js";
import { JobManager, type JobManagerOptions } from "./job-manager.js";
import { parseRunnerSelection, updateWorkflowSettings, workflowSettingsProjection } from "./settings.js";
import type { ReviewCapabilityV1, RunnerRegistryV1, WorkflowAnnotation, WorkflowTaskCapabilityV1, WorkflowTaskFilterV1, WorkflowTaskLabelV1, WorkflowTaskToneV1 } from "./workflow-types.js";

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

const TASK_TONES: ReadonlySet<WorkflowTaskToneV1> = new Set(["pending", "active", "ready", "done", "failed"]);

/** Validates an optional task-capability label override; any malformed or thrown result falls back to the workflow default label. */
function safeTaskLabel(capability: WorkflowTaskCapabilityV1 | undefined, annotation: WorkflowAnnotation): WorkflowTaskLabelV1 | null {
  let result: WorkflowTaskLabelV1 | null;
  try {
    result = capability?.label?.(annotation) ?? null;
  } catch {
    return null;
  }
  if (!result || typeof result !== "object") return null;
  if (typeof result.text !== "string" || !result.text.trim() || result.text.length > 32) return null;
  if (!TASK_TONES.has(result.tone)) return null;
  return result;
}

const WORKFLOW_STATUS_ORDER = ["open", "in_progress", "failed", "addressed", "resolved"] as const;
const TASK_FILTER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TASK_FILTERS = 16;

/**
 * Filter categories an optional task plugin owns. The workflow itself only knows its five
 * statuses; a task plugin may add its own chips so its annotations are not lumped under a status.
 */
function safeTaskFilters(capability: WorkflowTaskCapabilityV1 | undefined): WorkflowTaskFilterV1[] {
  let declared: readonly WorkflowTaskFilterV1[];
  try {
    declared = capability?.filters?.() ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(declared)) return [];
  const reserved = new Set<string>(WORKFLOW_STATUS_ORDER);
  const seen = new Set<string>();
  const accepted: WorkflowTaskFilterV1[] = [];
  for (const entry of declared) {
    if (accepted.length >= MAX_TASK_FILTERS) break;
    if (!entry || typeof entry !== "object") continue;
    const { id, label } = entry;
    if (typeof id !== "string" || !TASK_FILTER_ID.test(id) || reserved.has(id) || seen.has(id)) continue;
    if (typeof label !== "string" || !label.trim() || label.length > 32) continue;
    seen.add(id);
    accepted.push({ id, label });
  }
  return accepted;
}

/** The task filter category an annotation belongs to, or null when its status filter applies. */
function safeTaskFilter(capability: WorkflowTaskCapabilityV1 | undefined, annotation: WorkflowAnnotation, allowed: ReadonlySet<string>): string | null {
  let result: string | null;
  try {
    result = capability?.filter?.(annotation) ?? null;
  } catch {
    return null;
  }
  return typeof result === "string" && allowed.has(result) ? result : null;
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
        // `hidden` carries the unchecked filter ids, so a task plugin's new chip starts visible
        // for everyone instead of being silently filtered out by a persisted status allowlist.
        const hidden = new Set(Array.isArray(input.hidden) ? input.hidden.filter((item): item is string => typeof item === "string") : []);
        const kinds = Array.isArray(input.kinds) ? new Set(input.kinds.filter((item): item is string => typeof item === "string")) : null;
        const labels: Record<string, string> = { open: "未対応", in_progress: "AI対応中", failed: "失敗", addressed: "AI対応済み", resolved: "解決済み" };
        const taskFilters = safeTaskFilters(manager.taskCapability);
        const taskFilterIds = new Set(taskFilters.map(({ id }) => id));
        // The renderer's checkbox-group binds `value`/`label`, so chips are projected in that shape.
        const filters = [...WORKFLOW_STATUS_ORDER.map((id) => ({ value: id, label: labels[id]! })), ...taskFilters.map(({ id, label }) => ({ value: id, label }))];
        const items = aggregate.annotations
          .map((annotation) => ({ annotation, category: safeTaskFilter(manager.taskCapability, annotation as unknown as WorkflowAnnotation, taskFilterIds) }))
          .filter(({ annotation, category }) => !hidden.has(category ?? annotation.status) && (!kinds || kinds.has(String(annotation.kind))))
          .map(({ annotation, category }) => {
            const override = safeTaskLabel(manager.taskCapability, annotation as unknown as WorkflowAnnotation);
            return { ...annotation, status_label: override?.text ?? labels[annotation.status] ?? annotation.status, status_tone: override?.tone ?? null, filter_id: category ?? annotation.status, kind_label: annotation.kind === "dom" ? "ノード" : "範囲", thread: (Array.isArray(annotation.thread) ? annotation.thread : []).map((message) => ({ ...message, actor_label: message.actor === "ai" ? "AI" : "人間" })) };
          });
        return { ok: true, revision: `review:${aggregate.revision}`, data: { items, total: items.length, open_count: aggregate.annotations.filter(({ status }) => status === "open").length, filters } };
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
        const activeJobs = data.jobs.filter(({ state }) => state === "queued" || state === "running");
        const primaryJob = activeJobs.find(({ state }) => state === "running") ?? activeJobs[0];
        const active = primaryJob ? {
          job_id: primaryJob.id,
          started_at: activeJobs.map(({ started, created }) => started ?? created).sort()[0]!,
          latest_info: `${activeJobs.length}件のAI修正を実行中です`,
        } : null;
        return { ok: true, data: { revision: data.revision, batches: data.batches.map(({ custom_command: _legacy, ...batch }) => batch), jobs: data.jobs.map(({ custom_name: _legacy, ...job }) => job), ...(active ? { active } : {}), announcement: activeJobs.length ? `${activeJobs.length}件のAI修正を処理中です` : "AI修正は待機中です" } };
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
