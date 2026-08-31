import { CapabilityRegistry } from "./capability-registry.js";
import type { PluginBridgeContractV1, PluginBridgeOperationContractV1 } from "./plugin-bridge-contract.js";
import {
  PLUGIN_BRIDGE_PROTOCOL_V1,
  type PluginBridgeContextV1,
  type PluginBridgeErrorCodeV1,
  type PluginBridgeResultV1,
  type PluginBridgeTransportV1,
  type PluginCommandRequestV1,
  type PluginInvalidationEventV1,
  type PluginPrincipalV1,
  type PluginQueryRequestV1,
} from "./plugin-bridge.js";
import { listPlugins } from "./plugin-registry.js";
import { loadPluginServerProvider } from "./plugin-runtime.js";
import type { PluginLoggerV1, PluginServerInstanceV1 } from "./plugin-server.js";
import { effectivePluginSettings } from "./plugin-settings.js";

export interface PluginHostRuntimeOptions {
  workspaceRoot: string;
  workspaceId: string;
  target: Readonly<{ id: string; source: string }>;
  capabilities?: CapabilityRegistry;
  principal?: PluginPrincipalV1;
  logger?: PluginLoggerV1;
}

export type PluginServerRuntimeState = "unavailable" | "loading" | "starting" | "ready" | "failed" | "stopped";

export interface PluginServerRuntimeStatus {
  pluginId: string;
  state: PluginServerRuntimeState;
  message?: string;
}

interface RuntimeEntry {
  id: string;
  state: PluginServerRuntimeState;
  message?: string;
  contract?: PluginBridgeContractV1;
  instance?: PluginServerInstanceV1;
  capabilityCleanups: Array<() => void>;
  stopped: boolean;
}

const ERROR_CODES = new Set<PluginBridgeErrorCodeV1>([
  "BAD_REQUEST", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "VALIDATION_FAILED", "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED", "PLUGIN_PROTOCOL_ERROR", "PLUGIN_UNAVAILABLE", "TIMEOUT", "RESYNC_REQUIRED",
]);

const silentLogger: PluginLoggerV1 = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Owns generic v4 server contributions and exposes an in-memory bridge. It does
 * not read UI documents or know any review-domain operation.
 */
export class PluginHostRuntime implements PluginBridgeTransportV1 {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly subscriptions = new Set<() => void>();
  private readonly capabilities: CapabilityRegistry;
  private readonly logger: PluginLoggerV1;
  private readonly shutdownController = new AbortController();
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: PluginHostRuntimeOptions) {
    this.capabilities = options.capabilities ?? new CapabilityRegistry();
    this.logger = options.logger ?? silentLogger;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.closed) return Promise.resolve();
    this.startPromise = this.startPlugins();
    return this.startPromise;
  }

  status(pluginId: string): PluginServerRuntimeStatus {
    const entry = this.entries.get(pluginId);
    return entry
      ? { pluginId, state: entry.state, ...(entry.message === undefined ? {} : { message: entry.message }) }
      : { pluginId, state: "unavailable", message: "plugin server is unavailable" };
  }

  async query(pluginId: string, name: string, request: PluginQueryRequestV1): Promise<PluginBridgeResultV1> {
    return this.dispatch(pluginId, "query", name, request);
  }

  async sendAction(pluginId: string, name: string, request: PluginCommandRequestV1): Promise<PluginBridgeResultV1> {
    return this.dispatch(pluginId, "command", name, request);
  }

  subscribe(pluginId: string, listener: (event: PluginInvalidationEventV1) => void): () => void {
    const entry = this.entries.get(pluginId);
    if (this.closed || entry?.state !== "ready" || !entry.instance?.subscribe) return () => undefined;

    let active = true;
    let pluginCleanup: (() => void) | undefined;
    const cleanup = (): void => {
      if (!active) return;
      active = false;
      this.subscriptions.delete(cleanup);
      try { pluginCleanup?.(); } catch { this.logger.warn("plugin subscription cleanup failed", { pluginId }); }
    };
    this.subscriptions.add(cleanup);
    void Promise.resolve(entry.instance.subscribe(
      { protocol: PLUGIN_BRIDGE_PROTOCOL_V1 },
      (event) => {
        if (!active) return;
        if (!validEvent(event, pluginId)) {
          this.logger.warn("plugin emitted an invalid bridge event", { pluginId });
          return;
        }
        listener(event);
      },
    )).then((resolvedCleanup) => {
      if (typeof resolvedCleanup === "function") {
        if (active) pluginCleanup = once(resolvedCleanup);
        else resolvedCleanup();
      }
    }, () => {
      this.logger.warn("plugin subscription failed", { pluginId });
      cleanup();
    });
    return cleanup;
  }

  close(): void {
    void this.stop("shutdown").catch((error: unknown) => {
      this.logger.error("plugin host shutdown failed", { error: safeMessage(error) });
    });
  }

  stop(reason: "shutdown" | "reload" = "shutdown"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.stopPromise = this.stopPlugins(reason);
    return this.stopPromise;
  }

  private async startPlugins(): Promise<void> {
    for (const plugin of listPlugins(this.options.workspaceRoot)) {
      if (plugin.manifest.schema_version !== 4 || !plugin.manifest.server) continue;
      const entry: RuntimeEntry = { id: plugin.id, state: "unavailable", capabilityCleanups: [], stopped: false };
      this.entries.set(plugin.id, entry);
      const settings = effectivePluginSettings(plugin.manifest, this.options.workspaceRoot);
      if (!settings.enabled) {
        entry.message = "plugin is disabled";
        continue;
      }
      if (settings.missing.length > 0) {
        entry.message = "plugin configuration is incomplete";
        continue;
      }
      const missing = (plugin.manifest.requires ?? []).filter((requirement) =>
        !requirement.optional && !this.capabilities.has(requirement.capability, requirement.api_version));
      if (missing.length > 0) {
        entry.message = `required capability is unavailable: ${missing[0]!.capability}`;
        continue;
      }

      try {
        entry.state = "loading";
        const loaded = await loadPluginServerProvider(plugin.id, this.options.workspaceRoot);
        entry.contract = loaded.contract;
        const declaredCapabilities = new Set((plugin.manifest.requires ?? []).map(({ capability, api_version }) => `${capability}/${api_version}`));
        const context = Object.freeze({
          plugin: Object.freeze({ id: plugin.id, version: plugin.version, root: loaded.pluginDirectory }),
          workspace: Object.freeze({ root: this.options.workspaceRoot, id: this.options.workspaceId }),
          target: Object.freeze({ ...this.options.target }),
          configuration: Object.freeze({ ...settings.configuration }),
          logger: this.logger,
          shutdown: this.shutdownController.signal,
          capability: <T>(id: string, apiVersion: 1): T => {
            if (!declaredCapabilities.has(`${id}/${apiVersion}`)) throw new Error(`plugin did not declare capability ${id} API version ${apiVersion}`);
            return this.capabilities.resolve<T>(id, apiVersion);
          },
        });
        entry.instance = await loaded.provider.create(context);
        assertInstance(entry.instance);
        entry.state = "starting";
        await entry.instance.start();
        const declaredProvides = new Set((plugin.manifest.provides ?? []).map(({ capability, api_version }) => `${capability}/${api_version}`));
        const contributions = entry.instance.capabilities?.() ?? [];
        const contributedKeys = new Set<string>();
        for (const contribution of contributions) {
          const key = `${contribution.id}/${contribution.apiVersion}`;
          if (!declaredProvides.has(key)) throw new Error(`plugin did not declare provided capability ${key}`);
          if (contributedKeys.has(key)) throw new Error(`plugin provided duplicate capability ${key}`);
          contributedKeys.add(key);
          entry.capabilityCleanups.push(this.capabilities.register(contribution.id, contribution.apiVersion, contribution.implementation));
        }
        for (const declared of declaredProvides) {
          if (!contributedKeys.has(declared)) throw new Error(`plugin did not provide declared capability ${declared}`);
        }
        entry.state = "ready";
      } catch (error) {
        entry.state = "failed";
        entry.message = "plugin server failed to start";
        this.logger.error("plugin server failed to start", { pluginId: plugin.id, error: safeMessage(error) });
        await this.stopEntry(entry, "failure");
      }
    }
  }

  private async dispatch(
    pluginId: string,
    kind: "query" | "command",
    name: string,
    request: PluginQueryRequestV1 | PluginCommandRequestV1,
  ): Promise<PluginBridgeResultV1> {
    const requestId = typeof request?.request_id === "string" ? request.request_id : "unknown";
    const entry = this.entries.get(pluginId);
    if (this.closed || entry?.state !== "ready" || !entry.instance || !entry.contract) {
      return bridgeError("PLUGIN_UNAVAILABLE", "plugin server is unavailable", requestId, true);
    }
    const operations = kind === "query" ? entry.contract.queries : entry.contract.commands;
    const operation = operations.find((candidate) => candidate.name === name);
    if (!operation) return bridgeError("PLUGIN_PROTOCOL_ERROR", "operation is not declared by the plugin bridge contract", requestId, false);
    if (!validRequest(request, kind) || !matchesSchema(request.input, operation.input_schema)) {
      return bridgeError("BAD_REQUEST", "request does not match the plugin bridge contract", requestId, false);
    }

    const context: PluginBridgeContextV1 = {
      principal: this.options.principal ?? "system",
      workspaceId: this.options.workspaceId,
      targetId: this.options.target.id,
      requestId,
      ...(kind === "command" ? { idempotencyKey: (request as PluginCommandRequestV1).idempotency_key } : {}),
      signal: this.shutdownController.signal,
    };
    let result: PluginBridgeResultV1;
    try {
      result = kind === "query"
        ? await entry.instance.query(name, request as PluginQueryRequestV1, context)
        : await entry.instance.command(name, request as PluginCommandRequestV1, context);
    } catch (error) {
      this.logger.error("plugin bridge operation failed", { pluginId, operation: name, error: safeMessage(error) });
      return bridgeError("PLUGIN_UNAVAILABLE", "plugin server operation failed", requestId, true);
    }
    if (!validResult(result, requestId) || (result.ok && !matchesSchema(result.data, operation.output_schema))) {
      return bridgeError("PLUGIN_PROTOCOL_ERROR", "plugin returned an invalid bridge result", requestId, false);
    }
    return result;
  }

  private async stopPlugins(reason: "shutdown" | "reload"): Promise<void> {
    await this.startPromise;
    for (const cleanup of [...this.subscriptions]) cleanup();
    this.shutdownController.abort();
    for (const entry of [...this.entries.values()].reverse()) await this.stopEntry(entry, reason);
  }

  private async stopEntry(entry: RuntimeEntry, reason: "shutdown" | "failure" | "reload"): Promise<void> {
    if (!entry.instance || entry.stopped) return;
    entry.stopped = true;
    for (const cleanup of entry.capabilityCleanups.splice(0).reverse()) cleanup();
    try { await entry.instance.stop(reason); }
    catch (error) { this.logger.error("plugin server failed to stop", { pluginId: entry.id, error: safeMessage(error) }); }
    if (reason !== "failure") entry.state = "stopped";
  }
}

export function createPluginHostRuntime(options: PluginHostRuntimeOptions): PluginHostRuntime {
  return new PluginHostRuntime(options);
}

function assertInstance(value: unknown): asserts value is PluginServerInstanceV1 {
  if (typeof value !== "object" || value === null) throw new Error("plugin server instance must be an object");
  const instance = value as Partial<PluginServerInstanceV1>;
  if (typeof instance.start !== "function" || typeof instance.query !== "function" || typeof instance.command !== "function" || typeof instance.stop !== "function") {
    throw new Error("plugin server instance is invalid");
  }
  if (instance.subscribe !== undefined && typeof instance.subscribe !== "function") throw new Error("plugin server subscribe is invalid");
  if (instance.capabilities !== undefined && typeof instance.capabilities !== "function") throw new Error("plugin server capabilities is invalid");
}

function bridgeError(code: PluginBridgeErrorCodeV1, message: string, requestId: string, retryable: boolean): PluginBridgeResultV1 {
  return { ok: false, error: { code, message, retryable, request_id: requestId } };
}

function validRequest(request: PluginQueryRequestV1 | PluginCommandRequestV1, kind: "query" | "command"): boolean {
  if (typeof request !== "object" || request === null || request.protocol !== PLUGIN_BRIDGE_PROTOCOL_V1 || typeof request.request_id !== "string" || !request.request_id) return false;
  if (typeof request.input !== "object" || request.input === null || Array.isArray(request.input)) return false;
  return kind === "query" || (typeof (request as PluginCommandRequestV1).idempotency_key === "string" && Boolean((request as PluginCommandRequestV1).idempotency_key));
}

function validResult(value: unknown, requestId: string): value is PluginBridgeResultV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Partial<PluginBridgeResultV1>;
  if (result.ok === true) return "data" in result;
  if (result.ok !== false || typeof result.error !== "object" || result.error === null) return false;
  const error = result.error as { code?: unknown; message?: unknown; retryable?: unknown; request_id?: unknown; fields?: unknown };
  return typeof error.code === "string" && ERROR_CODES.has(error.code as PluginBridgeErrorCodeV1)
    && typeof error.message === "string" && typeof error.retryable === "boolean" && error.request_id === requestId
    && (error.fields === undefined || (typeof error.fields === "object" && error.fields !== null && !Array.isArray(error.fields)));
}

function validEvent(value: unknown, pluginId: string): value is PluginInvalidationEventV1 {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<PluginInvalidationEventV1>;
  return event.protocol === PLUGIN_BRIDGE_PROTOCOL_V1 && event.plugin_id === pluginId && typeof event.event_id === "string"
    && Number.isSafeInteger(event.seq) && (event.seq ?? 0) >= 0
    && (event.type === "resources.invalidated" || event.type === "resync.required")
    && Array.isArray(event.resources) && event.resources.every((resource) => typeof resource === "string");
}

function matchesSchema(value: unknown, schema: Readonly<Record<string, unknown>>): boolean {
  if (schema.enum !== undefined && !(schema.enum as unknown[]).some((candidate) => Object.is(candidate, value))) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "string": return typeof value === "string" && lengthWithin(value.length, schema.minLength, schema.maxLength);
    case "number": return typeof value === "number" && Number.isFinite(value) && rangeWithin(value, schema.minimum, schema.maximum);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) && rangeWithin(value, schema.minimum, schema.maximum);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value) && lengthWithin(value.length, schema.minItems, schema.maxItems)
      && value.every((item) => matchesSchema(item, schema.items as Readonly<Record<string, unknown>>));
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const properties = (schema.properties ?? {}) as Record<string, Readonly<Record<string, unknown>>>;
      const object = value as Record<string, unknown>;
      if (Object.keys(object).some((key) => !(key in properties))) return false;
      if ((schema.required as string[] | undefined)?.some((key) => !(key in object))) return false;
      return Object.entries(object).every(([key, item]) => matchesSchema(item, properties[key]!));
    }
    default: return false;
  }
}

function lengthWithin(length: number, minimum: unknown, maximum: unknown): boolean {
  return (minimum === undefined || length >= (minimum as number)) && (maximum === undefined || length <= (maximum as number));
}

function rangeWithin(value: number, minimum: unknown, maximum: unknown): boolean {
  return (minimum === undefined || value >= (minimum as number)) && (maximum === undefined || value <= (maximum as number));
}

function once(cleanup: () => void): () => void {
  let active = true;
  return () => { if (active) { active = false; cleanup(); } };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
