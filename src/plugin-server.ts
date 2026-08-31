import type {
  PluginBridgeContextV1,
  PluginBridgeResultV1,
  PluginCommandRequestV1,
  PluginInvalidationEventV1,
  PluginQueryRequestV1,
  PluginSubscriptionRequestV1,
} from "./plugin-bridge.js";

export interface PluginLoggerV1 {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface PluginServerContextV1 {
  plugin: Readonly<{ id: string; version: string; root: string }>;
  workspace: Readonly<{ root: string; id: string }>;
  target: Readonly<{ id: string; source: string }>;
  configuration: Readonly<Record<string, string | number | boolean>>;
  logger: PluginLoggerV1;
  shutdown: AbortSignal;
  capability<T>(id: string, apiVersion: 1): T;
}

export interface PluginServerCapabilityV1 {
  id: string;
  apiVersion: 1;
  implementation: unknown;
}

export interface PluginServerInstanceV1 {
  start(): void | Promise<void>;
  /** Capabilities become visible only after start succeeds and are removed on stop. */
  capabilities?(): readonly PluginServerCapabilityV1[];
  query(name: string, request: PluginQueryRequestV1, context: PluginBridgeContextV1): Promise<PluginBridgeResultV1>;
  command(name: string, request: PluginCommandRequestV1, context: PluginBridgeContextV1): Promise<PluginBridgeResultV1>;
  subscribe?(
    request: PluginSubscriptionRequestV1,
    emit: (event: PluginInvalidationEventV1) => void,
  ): void | (() => void) | Promise<void | (() => void)>;
  stop(reason: "shutdown" | "failure" | "reload"): void | Promise<void>;
}

export interface PluginServerProviderV1 {
  readonly apiVersion: 1;
  create(context: PluginServerContextV1): PluginServerInstanceV1 | Promise<PluginServerInstanceV1>;
}

export function assertPluginServerProviderV1(value: unknown): asserts value is PluginServerProviderV1 {
  if (typeof value !== "object" || value === null) throw new Error("plugin server export must be an object");
  const provider = value as Partial<PluginServerProviderV1>;
  if (provider.apiVersion !== 1) throw new Error("plugin server apiVersion must be 1");
  if (typeof provider.create !== "function") throw new Error("plugin server create must be a function");
}
