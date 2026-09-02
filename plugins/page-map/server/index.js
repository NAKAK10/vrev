import { analyzeSite, createAnalysisCache } from "./analyze.js";

export const PAGE_MAP_CAPABILITY_ID = "page-map";
export const PAGE_MAP_CAPABILITY_API_VERSION = 1;
const REVIEW_CAPABILITY_ID = "review";

const EMPTY_RESULT_TEMPLATE = Object.freeze({
  generated_at: "",
  scan_root: "",
  entry_path: "",
  truncated: false,
  warnings: [],
  stats: { files: 0, pages: 0, edges: 0, unknown: 0, duration_ms: 0 },
  pages: [],
  edges: [],
  unknown: [],
  externals: [],
});

function emptyResult(warning) {
  return {
    ...EMPTY_RESULT_TEMPLATE,
    generated_at: new Date().toISOString(),
    warnings: [warning],
    stats: { ...EMPTY_RESULT_TEMPLATE.stats },
  };
}

function bridgeError(request, code, message) {
  return { ok: false, error: { code, message, retryable: false, request_id: request.request_id } };
}

/**
 * Plugin-owned bridge projection. `targetDescriptor` is `ReviewCapabilityV1["store"]["target"]`
 * (the resolved review target): `{ projectRoot, entryPath, kind, liveUrl?, urlMode? }`.
 */
export function createPageMapBridgeAdapter(targetDescriptor, options = {}) {
  const cache = options.cache ?? createAnalysisCache();
  const limits = options.limits;
  const supported = targetDescriptor.kind === "html" && !targetDescriptor.liveUrl;

  const run = () => {
    if (!supported) return emptyResult("静的HTML以外の対象は未対応です");
    return analyzeSite({
      projectRoot: targetDescriptor.projectRoot,
      entryPath: targetDescriptor.entryPath,
      ...(limits ? { limits } : {}),
      cache,
    });
  };

  return Object.freeze({
    async query(name, request) {
      if (name !== "page-map.get") return bridgeError(request, "NOT_FOUND", "query is not declared by the plugin");
      return { ok: true, data: run() };
    },
    async command(name, request) {
      if (name !== "page-map.refresh") return bridgeError(request, "NOT_FOUND", "command is not declared by the plugin");
      cache.clear();
      return { ok: true, data: {}, effects: [{ type: "resource.invalidate", resources: ["page-map"] }] };
    },
    cache,
  });
}

/** Bundled schema-v4 server provider. */
const serverProvider = Object.freeze({
  apiVersion: 1,
  create(context) {
    let adapter = null;
    return {
      start() {
        const review = context.capability(REVIEW_CAPABILITY_ID, 1);
        adapter = createPageMapBridgeAdapter(review.store.target);
      },
      async query(name, request) {
        if (!adapter) {
          return { ok: false, error: { code: "PLUGIN_UNAVAILABLE", message: "page-map is not started", retryable: true, request_id: request.request_id } };
        }
        return adapter.query(name, request);
      },
      async command(name, request) {
        if (!adapter) {
          return { ok: false, error: { code: "PLUGIN_UNAVAILABLE", message: "page-map is not started", retryable: true, request_id: request.request_id } };
        }
        return adapter.command(name, request);
      },
      capabilities() {
        return [];
      },
      stop() {
        adapter = null;
      },
    };
  },
});

export default serverProvider;
