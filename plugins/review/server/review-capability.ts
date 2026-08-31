import {
  createReviewDomain,
  type ReviewDomainDependencies,
  type ReviewStoreContract,
  type ReviewStoreOptions,
} from "./review-store.js";

export const REVIEW_CAPABILITY_ID = "review";
export const REVIEW_CAPABILITY_API_VERSION = 1;
export const REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID = "host.review-domain";

export interface ReviewCapabilityV1 {
  readonly apiVersion: 1;
  readonly store: ReviewStoreContract;
}

export interface ReviewBridgePresentationV1 {
  allowScripts: boolean;
  aiJobsEnabled: boolean;
  pluginManagementVisible: boolean;
}

export interface ReviewBridgeRequestV1 {
  request_id: string;
  expected_revision?: unknown;
  input: Record<string, unknown>;
}

export type ReviewBridgeResultV1 =
  | { ok: true; revision?: string; data: unknown; effects?: unknown[] }
  | { ok: false; error: { code: string; message: string; retryable: boolean; request_id: string } };

interface ProviderContext {
  target: Readonly<{ source: string }>;
  workspace: Readonly<{ root: string }>;
  capability<T>(id: string, apiVersion: 1): T;
}

interface BridgeRequest { request_id: string }
interface BridgeResult {
  ok: false;
  error: { code: "PLUGIN_PROTOCOL_ERROR"; message: string; retryable: false; request_id: string };
}

/** Creates the capability used by compatibility transports and dependent plugins. */
export function createReviewCapability(
  dependencies: ReviewDomainDependencies,
  target: string,
  options: ReviewStoreOptions,
): ReviewCapabilityV1 {
  const domain = createReviewDomain(dependencies);
  return Object.freeze({ apiVersion: 1 as const, store: new domain.ReviewStore(target, options) });
}

function bridgeError(request: ReviewBridgeRequestV1, code: string, message: string): ReviewBridgeResultV1 {
  return { ok: false, error: { code, message, retryable: false, request_id: request.request_id } };
}

/** Plugin-owned transport projection used by the one-beta HTTP compatibility host. */
export function createReviewBridgeAdapter(store: ReviewStoreContract, presentation: ReviewBridgePresentationV1) {
  return Object.freeze({
    async query(name: string, request: ReviewBridgeRequestV1): Promise<ReviewBridgeResultV1> {
      if (name !== "session.get") return bridgeError(request, "NOT_FOUND", "query is not declared by the plugin");
      const review = store.load();
      return {
        ok: true,
        revision: `review:${review.revision}`,
        data: {
          target: {
            entry_path: store.entryPath,
            kind: store.target.kind,
            sha256: store.sourceHash(),
            allow_scripts: presentation.allowScripts,
            trust_mode: store.target.urlMode === "public" ? "public" : presentation.allowScripts ? "trusted" : "safe",
            ai_jobs_enabled: presentation.aiJobsEnabled,
            live_url: store.target.liveUrl ?? null,
            url_mode: store.target.urlMode ?? null,
            url: store.target.liveUrl
              ? `/live${new URL(store.target.liveUrl).pathname}${new URL(store.target.liveUrl).search}`
              : `/target/${store.entryPath.split("/").map(encodeURIComponent).join("/")}`,
          },
          review: store.loadActive(),
          features: { plugin_management: presentation.pluginManagementVisible },
        },
      };
    },
    async command(name: string, request: ReviewBridgeRequestV1): Promise<ReviewBridgeResultV1> {
      if (name !== "annotation.create") return bridgeError(request, "NOT_FOUND", "command is not declared by the plugin");
      const currentRevision = store.load().revision;
      if (request.expected_revision !== undefined && request.expected_revision !== null
        && request.expected_revision !== currentRevision && request.expected_revision !== `review:${currentRevision}`) {
        return bridgeError(request, "CONFLICT", "review revision conflict");
      }
      const { input } = request;
      if (typeof input.comment !== "string" || !input.comment.trim() || typeof input.anchor !== "object"
        || input.anchor === null || Array.isArray(input.anchor)) return bridgeError(request, "VALIDATION_FAILED", "annotation input is invalid");
      const anchor = input.anchor as Record<string, unknown>;
      const pagePath = typeof anchor.page_path === "string" ? anchor.page_path : store.entryPath;
      const kind = anchor.kind === "dom" ? "dom" : "region";
      const { kind: _kind, page_path: _pagePath, ...persistedAnchor } = anchor;
      store.createAnnotation({
        kind,
        page_path: pagePath,
        source_hash: store.sourceHash(pagePath),
        anchor: persistedAnchor,
        comment: input.comment.trim(),
        actor: "human",
      });
      const active = store.loadActive();
      return { ok: true, revision: `review:${active.revision}`, data: active, effects: [{ type: "resource.invalidate", resources: ["session", "annotations", "history"] }] };
    },
  });
}

/** Bundled schema-v4 server provider. Review behavior is exposed as a capability. */
export default Object.freeze({
  apiVersion: 1 as const,
  create(context: ProviderContext) {
    const dependencies = context.capability<ReviewDomainDependencies>(REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID, 1);
    const capability = createReviewCapability(dependencies, context.target.source, { projectRoot: context.workspace.root });
    const unsupported = (_name: string, request: BridgeRequest): Promise<BridgeResult> => Promise.resolve({
      ok: false,
      error: {
        code: "PLUGIN_PROTOCOL_ERROR",
        message: "review operations are exposed through ReviewCapabilityV1",
        retryable: false,
        request_id: request.request_id,
      },
    });
    return {
      start() {},
      query: unsupported,
      command: unsupported,
      capabilities() { return [{ id: REVIEW_CAPABILITY_ID, apiVersion: 1 as const, implementation: capability }]; },
      stop() {},
    };
  },
});
