// Chooses, per workspace, which backend review data is read from and written to: local files, or
// a single enabled `storage_provider` plugin. This is the `ReviewDomainDependencies.createStorage`
// implementation wired in `src/review-capability.ts`.
//
// Structurally mirrors `ReviewDocumentKind`/`ReviewDocumentPaths`/`ReviewDocumentStorage` from
// `plugins/review/server/review-store.ts` — duplicated (not imported), same rationale as
// `src/review-storage-local.ts`.
import type { ResolvedTarget } from "./paths.js";
import { listPlugins } from "./plugin-registry.js";
import { loadWorkspaceStorageProviderV1 } from "./plugin-runtime.js";
import { effectivePluginSettings, pluginSettingsRevision, readPluginSettings } from "./plugin-settings.js";
import { createLocalReviewDocumentStorage } from "./review-storage-local.js";
import { createPluginReviewDocumentStorage } from "./review-storage-plugin.js";
import type { WorkspaceStorageProviderV1 } from "./storage-provider.js";

type ReviewDocumentKind = "active" | "resolved" | "transaction" | "legacy" | "context";
interface ReviewDocumentPaths {
  active: string;
  resolved: string;
  legacy: string;
  transaction: string;
  context: string;
}
interface ReviewDocumentStorage {
  readonly cacheReads?: boolean;
  read(kind: ReviewDocumentKind): Promise<unknown | null>;
  write(kind: ReviewDocumentKind, value: unknown): Promise<void>;
  remove(kind: ReviewDocumentKind): Promise<void>;
  withLock<T>(action: () => Promise<T>): Promise<T>;
}

type ResolvedBackend = { kind: "local" } | { kind: "plugin"; provider: WorkspaceStorageProviderV1 };

interface CacheEntry {
  revision: string;
  resolved: Promise<ResolvedBackend>;
}

// One cache entry per project root: several workspaces can share this process (tests, a long-lived
// server handling multiple targets). Invalidated whenever `.vreview/plugin-settings.json` changes.
const backendCache = new Map<string, CacheEntry>();

async function resolveEnabledStorageBackend(projectRoot: string): Promise<ResolvedBackend> {
  const candidates = listPlugins(projectRoot).filter((plugin) => {
    if (!plugin.manifest.storage_provider) return false;
    const effective = effectivePluginSettings(plugin.manifest, projectRoot);
    return effective.enabled && effective.missing.length === 0;
  });

  if (candidates.length === 0) return { kind: "local" };

  if (candidates.length > 1) {
    throw new Error(
      `multiple storage provider plugins are enabled at once (${candidates.map((plugin) => plugin.id).join(", ")}); `
      + "enable only one storage provider plugin at a time",
    );
  }

  const plugin = candidates[0]!;
  try {
    const { provider } = await loadWorkspaceStorageProviderV1(plugin.id, projectRoot);
    return { kind: "plugin", provider };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `storage provider plugin "${plugin.id}" could not be loaded: ${message} `
      + "(disable this plugin to fall back to local storage)",
    );
  }
}

/** Resolves (with caching, keyed by plugin settings revision) which backend a workspace's review data lives in. Never falls back to local on a load failure — fail closed so data cannot silently split across backends. */
function resolveBackend(projectRoot: string): Promise<ResolvedBackend> {
  const revision = pluginSettingsRevision(readPluginSettings(projectRoot));
  const cached = backendCache.get(projectRoot);
  if (cached && cached.revision === revision) return cached.resolved;

  const resolved = resolveEnabledStorageBackend(projectRoot);
  backendCache.set(projectRoot, { revision, resolved });
  // A failed resolution must not stick around forever once the underlying cause is fixed.
  resolved.catch(() => {
    if (backendCache.get(projectRoot)?.resolved === resolved) backendCache.delete(projectRoot);
  });
  return resolved;
}

/**
 * `ReviewDomainDependencies.createStorage` implementation: synchronously returns a
 * `ReviewDocumentStorage` whose methods resolve the active backend (local file system, or the one
 * enabled `storage_provider` plugin) lazily, on first use, and again whenever plugin settings
 * change. Backed by `resolveBackend`'s cache so the same plugin provider instance (and therefore
 * the same in-flight CAS version bookkeeping in `createPluginReviewDocumentStorage`) is reused
 * across calls within a workspace.
 */
export function createWorkspaceReviewDocumentStorage(target: ResolvedTarget, paths: ReviewDocumentPaths): ReviewDocumentStorage {
  let pluginProvider: WorkspaceStorageProviderV1 | null = null;
  let pluginStorage: ReviewDocumentStorage | null = null;

  async function delegate(): Promise<ReviewDocumentStorage> {
    const backend = await resolveBackend(target.projectRoot);
    if (backend.kind === "local") return createLocalReviewDocumentStorage(target, paths);
    if (pluginStorage === null || pluginProvider !== backend.provider) {
      pluginProvider = backend.provider;
      pluginStorage = createPluginReviewDocumentStorage(target, paths, backend.provider);
    }
    return pluginStorage;
  }

  return Object.freeze({
    get cacheReads(): boolean {
      return listPlugins(target.projectRoot).some((plugin) => {
        if (plugin.manifest.storage_provider === undefined) return false;
        const settings = effectivePluginSettings(plugin.manifest, target.projectRoot);
        return settings.enabled && settings.missing.length === 0;
      });
    },
    async read(kind: ReviewDocumentKind): Promise<unknown | null> {
      return (await delegate()).read(kind);
    },
    async write(kind: ReviewDocumentKind, value: unknown): Promise<void> {
      return (await delegate()).write(kind, value);
    },
    async remove(kind: ReviewDocumentKind): Promise<void> {
      return (await delegate()).remove(kind);
    },
    async withLock<T>(action: () => Promise<T>): Promise<T> {
      return (await delegate()).withLock(action);
    },
  });
}
