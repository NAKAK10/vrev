import { buildIssueCoordinatorInstructions, extractIssueDraftOutput, validateStandaloneDraft } from "./draft-task.js";
import defaultIssueProvider from "./issue-provider.js";

export const ISSUE_TASK_CAPABILITY_ID = "issue-task";
export const ISSUE_TASK_CAPABILITY_API_VERSION = 1;
const REVIEW_CAPABILITY_ID = "review";

/**
 * One table drives both the annotation card badge and the sidebar filter chip, so the two can
 * never drift: every category here is a chip, and an annotation resolved to it wears that label.
 */
const ISSUE_TASK_CATEGORIES = Object.freeze([
  Object.freeze({ id: "issue-requested", label: "Issueラフ作成中", tone: "pending", issueState: "requested", status: "open" }),
  Object.freeze({ id: "issue-drafting", label: "AI Issueラフ作成中", tone: "active", issueState: "requested", status: "in_progress" }),
  Object.freeze({ id: "issue-draft-failed", label: "Issueラフ作成失敗", tone: "failed", issueState: "requested", status: "failed" }),
  Object.freeze({ id: "issue-ready", label: "Issueラフ確認待ち", tone: "ready", issueState: "ready", status: null }),
  Object.freeze({ id: "issue-created", label: "Issue作成済み", tone: "done", issueState: "created", status: null }),
]);

const ISSUE_TASK_FILTERS = Object.freeze(ISSUE_TASK_CATEGORIES.map(({ id, label }) => Object.freeze({ id, label })));

/** The category an annotation belongs to, or null when its workflow status applies instead. */
function issueTaskCategory(annotation) {
  if (!annotation || typeof annotation !== "object") return null;
  const { issue_state: issueState, status } = annotation;
  if (typeof issueState !== "string") return null;
  return ISSUE_TASK_CATEGORIES.find((category) => category.issueState === issueState && (category.status === null || category.status === status)) ?? null;
}

export function createIssueTaskCapability(review, options = {}) {
  const store = review.store;
  const provider = options.provider ?? defaultIssueProvider;
  const projectRoot = options.projectRoot ?? store.target.projectRoot;
  const creations = new Map();
  return Object.freeze({
    apiVersion: 1,
    coordinatorInstructions: buildIssueCoordinatorInstructions,
    acceptCoordinatorOutput(output, allowedAnnotationIds) {
      const persisted = [];
      for (const draft of extractIssueDraftOutput(output, allowedAnnotationIds)) {
        try {
          const annotation = store.loadActive().annotations.find(({ id }) => id === draft.annotationId);
          if (annotation?.issue_state && annotation.issue_state !== "ready" && annotation.issue_state !== "created") {
            const normalized = validateStandaloneDraft(draft.annotationId, draft);
            store.setIssueDraftReady(draft.annotationId, normalized.title, normalized.body);
            persisted.push(draft.annotationId);
          }
        } catch {}
      }
      return persisted;
    },
    state(annotation) {
      if (!annotation.issue_state) return "none";
      return annotation.issue_state === "ready" || annotation.issue_state === "created" ? "complete" : "pending";
    },
    label(annotation) {
      const category = issueTaskCategory(annotation);
      return category ? Object.freeze({ text: category.label, tone: category.tone }) : null;
    },
    filters() {
      return ISSUE_TASK_FILTERS;
    },
    filter(annotation) {
      return issueTaskCategory(annotation)?.id ?? null;
    },
    create(annotationId, rawDraft) {
      const draft = validateStandaloneDraft(annotationId, rawDraft);
      const annotation = store.load().annotations.find(({ id }) => id === annotationId);
      if (!annotation) throw new Error(`annotation not found: ${annotationId}`);
      if (annotation.issue_state === "created" && annotation.issue_url) return Promise.resolve({ url: annotation.issue_url });
      if (annotation.issue_state !== "ready" || annotation.status !== "addressed") throw new Error("Issue draft is not ready for creation");
      const existing = creations.get(annotationId);
      if (existing) return existing;
      const creation = provider.createIssue(projectRoot, draft).then((result) => {
        store.completeIssueDraft(annotationId, draft.title, result.url);
        return result;
      }).finally(() => creations.delete(annotationId));
      creations.set(annotationId, creation);
      return creation;
    },
  });
}

function bridgeError(request, code, message) {
  return { ok: false, error: { code, message, retryable: false, request_id: request.request_id } };
}

/** Plugin-owned bridge projection; the host only routes envelopes to it. */
export function createIssueBridgeAdapter(review, issueTask) {
  const store = review.store;
  return Object.freeze({
    async query(_name, request) { return bridgeError(request, "NOT_FOUND", "query is not declared by the plugin"); },
    async command(name, request) {
      const input = request.input;
      if (name === "issue.draft" && typeof input.annotation_id === "string") {
        const annotation = store.load().annotations.find(({ id }) => id === input.annotation_id);
        if (!annotation) return bridgeError(request, "NOT_FOUND", "annotation not found");
        if (annotation.issue_state !== "ready" || !annotation.issue_title || !annotation.issue_body) return bridgeError(request, "CONFLICT", "Issue draft is not ready");
        return { ok: true, data: { title: annotation.issue_title, body: annotation.issue_body } };
      }
      if (name === "issue.create" && typeof input.annotation_id === "string") {
        return { ok: true, data: await issueTask.create(input.annotation_id, input), effects: [{ type: "resource.invalidate", resources: ["session", "annotations"] }] };
      }
      if (name === "issue.request") {
        try {
          const { annotation } = review.annotations.create({ anchor: input.anchor, comment: input.comment, mode: "issue-request" });
          return { ok: true, data: { annotation_id: annotation.id }, effects: [{ type: "resource.invalidate", resources: ["session", "annotations", "history"] }] };
        } catch (error) {
          return bridgeError(request, "VALIDATION_FAILED", error instanceof Error ? error.message : "Issue request is invalid");
        }
      }
      return bridgeError(request, "NOT_FOUND", "command is not declared by the plugin");
    },
  });
}

const serverProvider = Object.freeze({
  apiVersion: 1,
  create(context) {
    const review = context.capability(REVIEW_CAPABILITY_ID, 1);
    const capability = createIssueTaskCapability(review, { projectRoot: context.workspace.root });
    const unsupported = (_name, request) => Promise.resolve({
      ok: false,
      error: { code: "PLUGIN_PROTOCOL_ERROR", message: "Issue operations are exposed through IssueTaskCapabilityV1", retryable: false, request_id: request.request_id },
    });
    return {
      start() {}, query: unsupported, command: unsupported,
      capabilities() { return [{ id: ISSUE_TASK_CAPABILITY_ID, apiVersion: 1, implementation: capability }]; },
      stop() {},
    };
  },
});

export default serverProvider;
export * from "./draft-task.js";
export { IssueCreationIndeterminateError } from "./issue-provider.js";
