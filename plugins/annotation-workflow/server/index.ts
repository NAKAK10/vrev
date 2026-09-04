import type { PluginServerContextV1, PluginServerProviderV1 } from "../../../src/plugin-server.js";
import { JobManager, type JobManagerOptions } from "./job-manager.js";
import { updateWorkflowSettings, workflowSettingsProjection } from "./settings.js";
import type { AiCapabilityV1, ReviewCapabilityV1 } from "./workflow-types.js";

export const ANNOTATION_WORKFLOW_CAPABILITY_ID = "annotation-workflow";
export const ANNOTATION_WORKFLOW_CAPABILITY_API_VERSION = 1;
export const REVIEW_CAPABILITY_ID = "review";
export const AI_CAPABILITY_ID = "ai";
export const AI_CAPABILITY_API_VERSION = 1;

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

const WORKFLOW_STATUS_ORDER = ["open", "in_progress", "failed", "addressed", "resolved"] as const;

interface BridgeReviewStore {
  readonly target: { projectRoot: string };
  load(): Promise<{ revision: number; annotations: Array<Record<string, unknown> & { id: string; status: string }>; events: Array<{ at: string; revision: number }> }>;
  loadActive(): Promise<unknown>;
  addMessage(annotationId: string, payload: { actor: "human"; body: string }): Promise<{ revision: number }>;
  setStatus(annotationId: string, payload: { actor: "human"; status: string }): Promise<{ revision: number }>;
}

/** Plugin-owned bridge projection; the host only routes envelopes to it. */
export function createAnnotationWorkflowBridgeAdapter(review: ReviewCapabilityV1, manager: JobManager, _ai?: AiCapabilityV1) {
  const store = review.store as unknown as BridgeReviewStore;
  return Object.freeze({
    async query(name: string, request: BridgeRequest): Promise<BridgeResult> {
      const { input } = request;
      if (name === "annotations.list") {
        const aggregate = await store.load();
        const hidden = new Set(Array.isArray(input.hidden) ? input.hidden.filter((item): item is string => typeof item === "string") : []);
        const kinds = Array.isArray(input.kinds) ? new Set(input.kinds.filter((item): item is string => typeof item === "string")) : null;
        const labels: Record<string, string> = { open: "未対応", in_progress: "AI対応中", failed: "失敗", addressed: "AI対応済み", resolved: "解決済み" };
        const filters = WORKFLOW_STATUS_ORDER.map((id) => ({ value: id, label: labels[id]! }));
        const items = aggregate.annotations
          .filter((annotation) => !hidden.has(annotation.status) && (!kinds || kinds.has(String(annotation.kind))))
          .map((annotation) => ({ ...annotation, status_label: labels[annotation.status] ?? annotation.status, status_tone: null, filter_id: annotation.status, kind_label: annotation.kind === "dom" ? "ノード" : "範囲", thread: (Array.isArray(annotation.thread) ? annotation.thread : []).map((message) => ({ ...message, actor_label: message.actor === "ai" ? "AI" : "人間" })) }));
        return { ok: true, revision: `review:${aggregate.revision}`, data: { items, total: items.length, open_count: aggregate.annotations.filter(({ status }) => status === "open").length, filters, revision: aggregate.revision } };
      }
      if (name === "history.list") {
        const aggregate = await store.load();
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
        return { ok: true, revision: `review:${aggregate.revision}`, data: { events: projected, total: events.length, remaining: Math.max(0, events.length - offset - limit), next_offset: offset + limit, latest_revision: events[0]?.revision ?? 0 } };
      }
      if (name === "jobs.list") {
        const data = await manager.list();
        const activeJobs = data.jobs.filter(({ state }) => state === "queued" || state === "running");
        const primaryJob = activeJobs.find(({ state }) => state === "running") ?? activeJobs[0];
        const active = primaryJob ? {
          job_id: primaryJob.id,
          started_at: activeJobs.map(({ started, created }) => started ?? created).sort()[0]!,
          latest_info: `${activeJobs.length}件のAI修正を実行中です`,
        } : null;
        return { ok: true, data: { revision: data.revision, batches: data.batches.map(({ custom_command: _legacy, ...batch }) => batch), jobs: data.jobs.map(({ custom_name: _legacy, ...job }) => job), ...(active ? { active } : {}), announcement: activeJobs.length ? `${activeJobs.length}件のAI修正を処理中です` : "AI修正は待機中です" } };
      }
      if (name === "workflow.settings") return { ok: true, data: workflowSettingsProjection(review.store.target.projectRoot) };
      return bridgeError(request, "NOT_FOUND", "query is not declared by the plugin");
    },
    async command(name: string, request: BridgeRequest): Promise<BridgeResult> {
      const { input } = request;
      if (name === "annotation.reply" && typeof input.annotation_id === "string" && typeof input.comment === "string" && input.comment.trim()) {
        const updated = await store.addMessage(input.annotation_id, { body: input.comment.trim(), actor: "human" });
        return { ok: true, revision: `review:${updated.revision}`, data: { annotation_id: input.annotation_id }, effects: [{ type: "resource.invalidate", resources: ["annotations", "history"] }] };
      }
      if (name === "annotation.status" && typeof input.annotation_id === "string" && typeof input.status === "string") {
        const updated = await store.setStatus(input.annotation_id, { status: input.status, actor: "human" });
        return { ok: true, revision: `review:${updated.revision}`, data: { annotation_id: input.annotation_id, status: input.status }, effects: [{ type: "resource.invalidate", resources: ["annotations", "history", "session"] }] };
      }
      if (name === "workflow.settings.update") return { ok: true, data: updateWorkflowSettings(review.store.target.projectRoot, input), effects: [{ type: "resource.invalidate", resources: ["workflow-settings"] }] };
      if (name === "jobs.cancel" && typeof input.job_id === "string") {
        await manager.cancel(input.job_id);
        return { ok: true, data: {}, effects: [{ type: "resource.invalidate", resources: ["jobs", "annotations"] }] };
      }
      if ((name === "jobs.enqueue" || name === "jobs.retry") && (name !== "jobs.retry" || typeof input.annotation_id === "string")) {
        const settings = workflowSettingsProjection(review.store.target.projectRoot);
        const enqueueInput = {
          max_parallel: Number.isInteger(input.max_parallel) ? input.max_parallel as number : settings.max_parallel,
          ...(name === "jobs.enqueue" && typeof input.annotation_id === "string" ? { annotation_ids: [input.annotation_id] } : {}),
        };
        const data = name === "jobs.retry" ? await manager.retry(input.annotation_id as string, enqueueInput) : await manager.enqueue(enqueueInput);
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
    const ai = context.capability<AiCapabilityV1>(AI_CAPABILITY_ID, AI_CAPABILITY_API_VERSION);
    const capability = createAnnotationWorkflowCapability(review, { ai });
    const unsupported = (_name: string, request: { request_id: string }) => Promise.resolve({
      ok: false as const,
      error: { code: "PLUGIN_PROTOCOL_ERROR" as const, message: "workflow operations are exposed through AnnotationWorkflowCapabilityV1", retryable: false as const, request_id: request.request_id },
    });
    return {
      start() { return capability.manager.start(); },
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
export * from "./runtime-snapshot.js";
export * from "./settings.js";
export type * from "./workflow-types.js";
