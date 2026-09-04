export declare const VISUAL_REVIEW_PACKAGE_API_VERSION = 1;
export declare const PLUGIN_BRIDGE_PROTOCOL_V1 = "plugin-bridge/1";
export declare const RUNNER_REGISTRY_CAPABILITY_ID = "host.runner-registry";
export declare const RUNNER_REGISTRY_CAPABILITY_API_VERSION = 1;
export declare const AI_CAPABILITY_ID = "ai";
export declare const AI_CAPABILITY_API_VERSION = 1;
export declare const AI_INTEGRATION_REGISTRY_CAPABILITY_ID = "ai.integration-registry";
export declare const AI_INTEGRATION_REGISTRY_CAPABILITY_API_VERSION = 1;

export interface VrevPackageMetadataV1 {
  apiVersion: 1;
  /** Canonical `./`-prefixed path to the manifest within this package. */
  manifest: string;
}

export interface PluginModuleReferenceV1 {
  module: string;
  export?: string;
}

export interface PluginServerManifestV1 extends PluginModuleReferenceV1 {
  api_version: 1;
  bridge_api_version: 1;
  contract: string;
}

export interface PluginCapabilityRequirementV1 {
  capability: string;
  api_version: 1;
  optional: boolean;
}

export interface PluginCapabilityProvisionV1 {
  capability: string;
  api_version: 1;
}

export interface PluginUiContributionV1 {
  id: string;
  slot: string;
  document: string;
  browser_module?: string;
  order: number;
  title?: string;
}

export interface PluginUiManifestV1 {
  renderer_api_version: 1;
  bridge_api_version: 1;
  contributions: PluginUiContributionV1[];
  extension_points?: ReadonlyArray<{
    id: string;
    title: string;
    description?: string;
    context_schema: Readonly<Record<string, unknown>>;
    form_fields?: string[];
    events?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    max_contributions?: number;
  }>;
}

export interface PluginUiDocumentV1 {
  schema_version: 1;
  local_state?: unknown[];
  resources?: unknown[];
  root: Readonly<Record<string, unknown>>;
}

export type PluginUiSurfaceExtensionPointV1 = PluginUiContributionV1;

export interface PluginBridgeContractV1 {
  schema_version: 1;
  queries: ReadonlyArray<Readonly<Record<string, unknown>>>;
  commands: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface VrevPluginManifestV1 {
  schema_version: 4;
  id: string;
  version: string;
  display: { title: string; summary: string; readme: string };
  configuration: ReadonlyArray<Readonly<Record<string, unknown>>>;
  server?: PluginServerManifestV1;
  ui?: PluginUiManifestV1;
  requires?: PluginCapabilityRequirementV1[];
  provides?: PluginCapabilityProvisionV1[];
  commands?: ReadonlyArray<{ name: string; module: string; export?: string }>;
  storage_provider?: PluginModuleReferenceV1 & { api_version?: 1 };
  issue_provider?: PluginModuleReferenceV1;
  annotation_flow_provider?: PluginModuleReferenceV1 & { api_version: 1 };
  custom_command_provider?: PluginModuleReferenceV1 & { api_version: 1 };
}

export type VrevPluginManifest = VrevPluginManifestV1;

export type PluginPrincipalV1 = "human-ui" | "local-cli" | "system";

export interface PluginQueryRequestV1 {
  protocol: "plugin-bridge/1";
  request_id: string;
  input: Record<string, unknown>;
}

export interface PluginCommandRequestV1 extends PluginQueryRequestV1 {
  idempotency_key: string;
  expected_revision?: unknown;
}

export type PluginBridgeResultV1<T = unknown> =
  | { ok: true; revision?: string; data: T; effects?: ReadonlyArray<Readonly<Record<string, unknown>>> }
  | { ok: false; revision?: string; error: { code: string; message: string; retryable: boolean; request_id: string; fields?: Record<string, string> } };

export interface PluginServerContextV1 {
  readonly plugin: Readonly<{ id: string; version: string; root: string }>;
  readonly workspace: Readonly<{ root: string; id: string }>;
  readonly target: Readonly<{ id: string; source: string }>;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly logger: {
    debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
    info(message: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
    error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  };
  readonly shutdown: AbortSignal;
  capability<T>(id: string, apiVersion: 1): T;
}

export interface PluginServerInstanceV1 {
  start(): void | Promise<void>;
  query(name: string, request: PluginQueryRequestV1, context?: unknown): PluginBridgeResultV1 | Promise<PluginBridgeResultV1>;
  command(name: string, request: PluginCommandRequestV1, context?: unknown): PluginBridgeResultV1 | Promise<PluginBridgeResultV1>;
  subscribe?(request: { protocol: "plugin-bridge/1" }, emit: (event: unknown) => void): void | (() => void) | Promise<void | (() => void)>;
  capabilities?(): ReadonlyArray<{ id: string; apiVersion: 1; implementation: unknown }>;
  stop(reason: "shutdown" | "failure" | "reload"): void | Promise<void>;
}

export interface PluginServerProviderV1 {
  readonly apiVersion: 1;
  create(context: PluginServerContextV1): PluginServerInstanceV1 | Promise<PluginServerInstanceV1>;
}

export interface RunnerDescriptorV1 {
  readonly runner_id: string;
  readonly name: string;
  readonly provider_id: string;
  readonly verified: boolean;
  /** Host-enforced execution profiles supported by this runner. */
  readonly profiles?: readonly string[];
  readonly integration_kind?: "cli" | "external-command" | "api" | "sdk" | "remote" | "integration";
}

export interface RunnerExecutionSpecV1 {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface RunnerProviderV1 {
  list(context: { readonly workspaceRoot: string }): ReadonlyArray<Omit<RunnerDescriptorV1, "provider_id">> | Promise<ReadonlyArray<Omit<RunnerDescriptorV1, "provider_id">>>;
  resolve(runnerId: string, context: { readonly workspaceRoot: string; readonly prompt: string; readonly options?: Readonly<Record<string, string | number | boolean | null>> }): RunnerExecutionSpecV1 | Promise<RunnerExecutionSpecV1>;
}

export interface RunnerRegistryV1 {
  readonly apiVersion: 1;
  register(providerId: string, provider: RunnerProviderV1): () => void;
  unregister(providerId: string): void;
  list(context?: { readonly workspaceRoot: string }): ReadonlyArray<RunnerDescriptorV1> | Promise<ReadonlyArray<RunnerDescriptorV1>>;
  resolve(runnerId: string, context: { readonly workspaceRoot: string; readonly prompt: string; readonly options?: Readonly<Record<string, string | number | boolean | null>> }): RunnerExecutionSpecV1 | Promise<RunnerExecutionSpecV1>;
}

export type AiModeV1 = "workspace-write" | "text-only";
export type AiMethodKindV1 = "cli" | "external-command" | "api" | "sdk" | "remote" | "integration";
export interface AiMethodDescriptorV1 {
  readonly method_id: string;
  readonly name: string;
  readonly method_kind: AiMethodKindV1;
  readonly modes: readonly AiModeV1[];
}
export interface AiInvocationRequestV1 {
  /** Optional for feature packages. When omitted, the AI package uses its workspace selection. */
  readonly method_id?: string;
  readonly mode: AiModeV1;
  readonly prompt: string;
  readonly timeout_ms?: number;
  readonly output_limit_bytes?: number;
  readonly options?: Readonly<Record<string, string | number | boolean | null>>;
}
export type AiInvocationResultV1 =
  | { readonly status: "completed"; readonly output: string; readonly exit_code: 0 }
  | { readonly status: "failed" | "cancelled" | "timeout" | "output-limit"; readonly output: string; readonly exit_code: number | null; readonly message: string; readonly retryable: boolean };
export interface AiInvocationV1 { readonly result: Promise<AiInvocationResultV1>; cancel(): void }
export interface AiCapabilityV1 {
  readonly apiVersion: 1;
  list(input?: { readonly mode?: AiModeV1 }): Promise<readonly AiMethodDescriptorV1[]>;
  invoke(request: AiInvocationRequestV1): AiInvocationV1;
}
export interface AiIntegrationProviderV1 {
  list(context: { readonly workspaceRoot: string }): Promise<readonly AiMethodDescriptorV1[]> | readonly AiMethodDescriptorV1[];
  invoke(methodId: string, request: Omit<AiInvocationRequestV1, "method_id"> & { readonly workspaceRoot: string; readonly signal: AbortSignal }): Promise<AiInvocationV1> | AiInvocationV1;
}
export interface AiIntegrationRegistryV1 {
  readonly apiVersion: 1;
  register(providerId: string, provider: AiIntegrationProviderV1): () => void;
  list(context: { readonly workspaceRoot: string }): Promise<readonly AiMethodDescriptorV1[]>;
  has(methodId: string): boolean;
  invoke(methodId: string, request: Omit<AiInvocationRequestV1, "method_id"> & { readonly workspaceRoot: string; readonly signal: AbortSignal }): Promise<AiInvocationV1>;
}

export interface WorkspaceStorageProviderV1 {
  readonly apiVersion: 1;
  list(prefix: string): Promise<readonly string[]>;
  read(key: string): Promise<{ value: unknown; version: string } | null>;
  compareAndSwap(key: string, expectedVersion: string | null, value: unknown): Promise<{ version: string }>;
  delete(key: string, expectedVersion: string): Promise<void>;
}
