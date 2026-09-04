export declare const AI_CAPABILITY_ID: "ai";
export declare const AI_CAPABILITY_API_VERSION: 1;
export declare const AI_INTEGRATION_REGISTRY_CAPABILITY_ID: "ai.integration-registry";
export declare const AI_INTEGRATION_REGISTRY_CAPABILITY_API_VERSION: 1;
export declare const RUNNER_REGISTRY_CAPABILITY_ID: "host.runner-registry";
export declare const PROCESS_SUPERVISOR_CAPABILITY_ID: "host.process-supervisor";
export type AiModeV1 = "workspace-write" | "text-only";
export type AiMethodKindV1 = "cli" | "external-command" | "api" | "sdk" | "remote" | "integration";
export interface AiMethodDescriptorV1 {
  readonly method_id: string;
  readonly name: string;
  readonly method_kind: AiMethodKindV1;
  readonly modes: readonly AiModeV1[];
}
export interface AiInvocationRequestV1 {
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
export interface AiRuntimeV1 extends AiCapabilityV1 { stop(): void }
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
export declare function createAiIntegrationRegistry(): AiIntegrationRegistryV1;
export interface CreateAiCapabilityOptions {
  workspaceRoot: string;
  runnerRegistry: {
    list(context: { workspaceRoot: string }): Promise<readonly unknown[]> | readonly unknown[];
    resolve(methodId: string, context: { workspaceRoot: string; prompt: string; options?: Readonly<Record<string, string | number | boolean | null>> }): Promise<{ command: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }> | { command: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv };
  };
  processSupervisor: { run(spec: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; stdoutLimit?: number }): { result: Promise<{ exitCode: number | null; reason: "exit" | "cancelled" | "timeout" | "output-limit" | "spawn-error"; stdout: string; errorMessage?: string }>; cancel(): void } };
  integrationRegistry?: AiIntegrationRegistryV1;
}
export declare function createAiCapability(options: CreateAiCapabilityOptions): AiRuntimeV1;
export declare function createAiBridgeAdapter(workspaceRoot: string, listMethods: AiCapabilityV1["list"], commandProvider?: unknown): {
  query(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
  command(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
};
declare const provider: { readonly apiVersion: 1; create(context: any): any };
export default provider;
