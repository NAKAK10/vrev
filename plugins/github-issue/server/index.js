import { randomUUID } from "node:crypto";
import { buildIssueCoordinatorInstructions, buildStandaloneIssueDraftPrompt, extractIssueDraftOutput, extractStandaloneIssueDraft, normalizeGitHubIssueDraft, validateStandaloneDraft } from "./draft-task.js";
import defaultIssueProvider, { IssueCreationIndeterminateError } from "./issue-provider.js";

export const ISSUE_TASK_CAPABILITY_ID = "issue-task";
export const ISSUE_TASK_CAPABILITY_API_VERSION = 1;
const REVIEW_CAPABILITY_ID = "review";
export const AI_CAPABILITY_ID = "ai";
export const AI_CAPABILITY_API_VERSION = 1;
const DRAFT_TIMEOUT_MS = 120_000;

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

/** Collapses the five fine-grained categories above into the four groups the sidebar list shows. */
const ISSUE_LIST_GROUPS = Object.freeze({
  "issue-requested": Object.freeze({ id: "creating", label: "作成中", tone: "pending" }),
  "issue-drafting": Object.freeze({ id: "creating", label: "作成中", tone: "pending" }),
  "issue-draft-failed": Object.freeze({ id: "retry", label: "再作成", tone: "failed" }),
  "issue-ready": Object.freeze({ id: "drafted", label: "作成済み", tone: "ready" }),
  "issue-created": Object.freeze({ id: "resolved", label: "解決済み", tone: "done" }),
});

const ISSUE_LIST_FILTERS = Object.freeze([
  Object.freeze({ value: "creating", label: "作成中" }),
  Object.freeze({ value: "retry", label: "再作成" }),
  Object.freeze({ value: "drafted", label: "作成済み" }),
  Object.freeze({ value: "resolved", label: "解決済み" }),
]);
const RESOLVED_ISSUE_LIST_GROUP = Object.freeze({ id: "resolved", label: "解決済み", tone: "done" });

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
  const blockedCreations = new Map();
  return Object.freeze({
    apiVersion: 1,
    coordinatorInstructions: buildIssueCoordinatorInstructions,
    async acceptCoordinatorOutput(output, allowedAnnotationIds) {
      const persisted = [];
      for (const draft of extractIssueDraftOutput(output, allowedAnnotationIds)) {
        try {
          const annotation = (await store.loadActive()).annotations.find(({ id }) => id === draft.annotationId);
          if (annotation?.issue_state && annotation.issue_state !== "ready" && annotation.issue_state !== "created") {
            const normalized = validateStandaloneDraft(draft.annotationId, draft);
            await store.setIssueDraftReady(draft.annotationId, normalized.title, normalized.body);
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
    async create(annotationId, rawDraft) {
      const draft = validateStandaloneDraft(annotationId, rawDraft);
      const annotation = (await store.load()).annotations.find(({ id }) => id === annotationId);
      if (!annotation) throw new Error(`annotation not found: ${annotationId}`);
      if (annotation.issue_state === "created" && annotation.issue_url) return { url: annotation.issue_url };
      if (annotation.issue_state !== "ready" || annotation.status !== "addressed") throw new Error("Issue draft is not ready for creation");
      const blocked = blockedCreations.get(annotationId);
      if (blocked) throw blocked;
      const existing = creations.get(annotationId);
      if (existing) return existing;
      const creation = provider.createIssue(projectRoot, draft).then(async (result) => {
        let completedReview;
        try { completedReview = await store.completeIssueDraft(annotationId, draft.title, result.url); }
        catch {
          const error = new IssueCreationIndeterminateError(`GitHub Issueは作成されましたがreviewへの保存に失敗しました: ${result.url}。重複防止のため再試行しません`);
          blockedCreations.set(annotationId, error);
          throw error;
        }
        return { ...result, review: completedReview };
      }).catch((error) => {
        if (error?.indeterminate === true) blockedCreations.set(annotationId, error);
        throw error;
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
export function createIssueBridgeAdapter(reviewOrOptions, legacyIssueTask, legacyOptions = {}) {
  // The structural form is the public composition API. Positional arguments remain compatible
  // with older bundled cores while they migrate their wiring.
  const structural = reviewOrOptions && typeof reviewOrOptions === "object" && "review" in reviewOrOptions;
  const options = structural ? reviewOrOptions : { ...legacyOptions, review: reviewOrOptions, issueTask: legacyIssueTask };
  const { review, issueTask, ai } = options;
  if (!review?.store || !issueTask) throw new Error("review and issueTask are required");
  const store = review.store;
  const provider = options.provider ?? defaultIssueProvider;
  const projectRoot = options.projectRoot ?? store.target.projectRoot;
  const draftsEnabled = options.draftsEnabled !== false;
  const activeDraftsByAnnotation = new Map();
  const activeInvocations = new Set();
  let stopped = false;

  const assertRunning = () => {
    if (stopped) throw new Error("AI Issue draft service is stopped");
  };

  const resolveTarget = async () => {
    let target = { repo: null, account: null };
    try { target = (await provider.resolveTarget?.(projectRoot)) ?? target; } catch {}
    return {
      repo: typeof target.repo === "string" && target.repo ? target.repo : null,
      account: typeof target.account === "string" && target.account ? target.account : null,
    };
  };

  /**
   * Generates a draft for an already-persisted "requested" annotation and writes the outcome back
   * onto it (ready on success, failed on failure) so the sidebar list reflects progress without the
   * caller having to poll. Single-flight per annotation: a retry click while one is already running
   * just joins the in-flight attempt instead of starting a second AI invocation.
   */
  const runDraftGeneration = (annotationId, request, anchor) => {
    const existing = activeDraftsByAnnotation.get(annotationId);
    if (existing) return existing;
    const promise = (async () => {
      const resolvedTarget = await resolveTarget();
      assertRunning();
      const nonce = randomUUID();
      const prompt = buildStandaloneIssueDraftPrompt(request, anchor, nonce, resolvedTarget);
      const invocation = await ai.invoke({
        mode: "text-only",
        prompt,
        timeout_ms: DRAFT_TIMEOUT_MS,
        output_limit_bytes: 128 * 1024,
        options: { operation: "github-issue-draft" },
      });
      assertRunning();
      activeInvocations.add(invocation);
      let result;
      try { result = await invocation.result; }
      finally { activeInvocations.delete(invocation); }
      if (result.status !== "completed") throw new Error(result.message || `AI Issue draft failed: ${result.status}`);
      const draft = extractStandaloneIssueDraft(result.output, nonce);
      await store.setIssueDraftReady(annotationId, draft.title, draft.body);
      return { annotation_id: annotationId, title: draft.title, body: draft.body };
    })().catch(async (error) => {
      const message = error instanceof Error ? error.message : "AI Issue draft failed";
      try { await store.failIssueDraft(annotationId, message); } catch {}
      throw error;
    });
    activeDraftsByAnnotation.set(annotationId, promise);
    return promise.finally(() => { if (activeDraftsByAnnotation.get(annotationId) === promise) activeDraftsByAnnotation.delete(annotationId); });
  };

  return Object.freeze({
    async query(name, request) {
      if (name === "issue.target") {
        const target = await resolveTarget();
        return { ok: true, data: { repo: target.repo ?? "利用できません", account: target.account ?? "利用できません" } };
      }
      if (name === "issues.list") {
        const hidden = new Set(Array.isArray(request.input?.hidden) ? request.input.hidden.filter((value) => typeof value === "string") : []);
        const reviewDocument = await store.load();
        const items = reviewDocument.annotations
          .map((annotation) => {
            const category = issueTaskCategory(annotation);
            const group = annotation.status === "resolved" ? RESOLVED_ISSUE_LIST_GROUP : category ? ISSUE_LIST_GROUPS[category.id] : null;
            return group ? { annotation, group } : null;
          })
          .filter((entry) => entry && !hidden.has(entry.group.id))
          .map(({ annotation, group }) => ({
            id: annotation.id,
            request: annotation.comment,
            title: annotation.issue_title || annotation.comment,
            body: annotation.issue_body || "",
            url: annotation.issue_url || "",
            page_path: annotation.page_path,
            anchor: annotation.anchor,
            created_at: annotation.created_at,
            status_label: group.label,
            status_tone: group.tone,
            filter_id: group.id,
          }));
        return { ok: true, revision: `review:${reviewDocument.revision}`, data: { items, total: items.length, latest_id: items.at(-1)?.id ?? "", filters: ISSUE_LIST_FILTERS } };
      }
      return bridgeError(request, "NOT_FOUND", "query is not declared by the plugin");
    },
    async command(name, request) {
      if ((name === "issue.draft" || name === "issue.draft.retry" || name === "issue.create") && !draftsEnabled) {
        return bridgeError(request, "CONFLICT", "AI Issue drafts are disabled while target scripts are enabled");
      }
      if (name === "issue.draft") {
        const input = request.input;
        try {
          assertRunning();
          if (!ai) throw new Error("AI is unavailable");
          if (typeof input.anchor !== "object" || input.anchor === null || Array.isArray(input.anchor)) throw new Error("anchor must be an object");
          const requestText = typeof input.request === "string" ? input.request.trim() : "";
          if (!requestText || requestText.length > 1000) throw new Error("request must be nonblank and at most 1000 characters");
          const { annotation } = await review.annotations.create({ anchor: input.anchor, comment: requestText, mode: "issue-request" });
          const data = await runDraftGeneration(annotation.id, requestText, input.anchor);
          return { ok: true, data };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Issue draft could not be generated";
          const validation = /must|nonblank|unavailable|unverified|at most/i.test(message);
          return bridgeError(request, validation ? "VALIDATION_FAILED" : "CONFLICT", message);
        }
      }
      if (name === "issue.draft.retry") {
        const input = request.input;
        try {
          assertRunning();
          if (!ai) throw new Error("AI is unavailable");
          if (typeof input.annotation_id !== "string" || !input.annotation_id) throw new Error("annotation_id must be nonblank");
          const annotation = (await store.load()).annotations.find(({ id }) => id === input.annotation_id);
          if (!annotation) throw new Error("annotation not found");
          if (annotation.issue_state !== "requested") throw new Error("Issue draft is not retryable in its current state");
          const data = await runDraftGeneration(annotation.id, annotation.comment, annotation.anchor);
          return { ok: true, data };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Issue draft could not be generated";
          const validation = /must|nonblank|not found|not retryable/i.test(message);
          return bridgeError(request, validation ? "VALIDATION_FAILED" : "CONFLICT", message);
        }
      }
      if (name === "issue.resolve") {
        const input = request.input;
        try {
          if (typeof input.annotation_id !== "string" || !input.annotation_id) throw new Error("annotation_id must be nonblank");
          const annotation = (await store.load()).annotations.find(({ id }) => id === input.annotation_id);
          if (!annotation || !annotation.issue_state) throw new Error("Issue annotation not found");
          if (typeof store.setStatus !== "function") throw new Error("Issue resolution is unavailable");
          const updated = await store.setStatus(input.annotation_id, { actor: "human", status: "resolved" });
          return {
            ok: true,
            revision: typeof updated?.revision === "number" ? `review:${updated.revision}` : undefined,
            data: { annotation_id: input.annotation_id, status: "resolved" },
            effects: [{ type: "resource.invalidate", resources: ["session", "issues", "history"] }],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Issue could not be resolved";
          const validation = /must|not found/i.test(message);
          return bridgeError(request, validation ? "VALIDATION_FAILED" : "CONFLICT", message);
        }
      }
      if (name !== "issue.create") return bridgeError(request, "NOT_FOUND", "command is not declared by the plugin");
      const input = request.input;
      try {
        const draft = normalizeGitHubIssueDraft(input);
        if (typeof input.annotation_id !== "string" || !input.annotation_id) throw new Error("annotation_id must be nonblank");
        const result = await issueTask.create(input.annotation_id, draft);
        return {
          ok: true,
          data: { annotation_id: input.annotation_id, url: result.url },
          effects: [{ type: "resource.invalidate", resources: ["session", "issues", "history"] }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Issue could not be created";
        const validation = /must|required|invalid|nonblank|anchor/i.test(message);
        return bridgeError(request, validation ? "VALIDATION_FAILED" : "CONFLICT", message);
      }
    },
    stop() {
      stopped = true;
      for (const invocation of activeInvocations) invocation.cancel();
      activeInvocations.clear();
      activeDraftsByAnnotation.clear();
    },
  });
}

const serverProvider = Object.freeze({
  apiVersion: 1,
  create(context) {
    const review = context.capability(REVIEW_CAPABILITY_ID, 1);
    const ai = context.capability(AI_CAPABILITY_ID, AI_CAPABILITY_API_VERSION);
    const capability = createIssueTaskCapability(review, { projectRoot: context.workspace.root });
    const bridge = createIssueBridgeAdapter({ review, issueTask: capability, ai, projectRoot: context.workspace.root });
    return {
      start() {},
      query(name, request) { return bridge.query(name, request); },
      command(name, request) { return bridge.command(name, request); },
      capabilities() { return [{ id: ISSUE_TASK_CAPABILITY_ID, apiVersion: 1, implementation: capability }]; },
      stop() { bridge.stop(); },
    };
  },
});

export default serverProvider;
export * from "./draft-task.js";
export { IssueCreationIndeterminateError } from "./issue-provider.js";
