export type ReviewCli = "ai" | "opencode" | "claude" | "codex" | "copilot" | "pi" | "custom";
export type ReviewJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface ReviewJob {
  id: string;
  batch_id: string;
  annotation_id: string;
  page_path: string;
  source_hash: string;
  deferred_checkpoint?: boolean;
  cli: ReviewCli;
  custom_name: string | null;
  session_id: string | null;
  state: ReviewJobStatus;
  created: string;
  started: string | null;
  finished: string | null;
  exit_code: number | null;
  summary: string;
}

export interface ReviewJobBatch {
  id: string;
  max_parallel: number;
  opencode_attach: string | null;
  runner_id?: string | null;
  /** Legacy job-state only. New batches never persist raw command templates. */
  custom_command: string | null;
}

export interface ReviewJobState { revision: number; batches: ReviewJobBatch[]; jobs: ReviewJob[] }
export interface EnqueueJobsInput {
  max_parallel: number;
  annotation_ids?: string[] | null;
}

/** The subset of the versioned review capability required by workflow orchestration. */
export interface WorkflowAnnotation {
  id: string;
  page_path: string;
  source_hash: string;
  status: string;
  thread: Array<{ actor: string; body: string; at: string }>;
  [key: string]: unknown;
}
export interface WorkflowReviewDocument {
  annotations: WorkflowAnnotation[];
  [key: string]: unknown;
}
export interface WorkflowReviewContext {
  schema_version: 1;
  discovery_status: "pending" | "completed";
  primary_project: string;
  related_scopes: string[];
}
export interface WorkflowReviewStore {
  readonly path: string;
  readonly target: Readonly<{ projectRoot: string }>;
  sourceHash(pagePath?: string): string;
  load(): Promise<WorkflowReviewDocument>;
  loadActive(): Promise<WorkflowReviewDocument>;
  /** Optional only for legacy capability implementations; current ReviewCapability provides authoritative context. */
  loadContext?(): Promise<WorkflowReviewContext>;
  addMessage(annotationId: string, payload: { actor: "ai"; body: string }): Promise<unknown>;
  setStatus(annotationId: string, payload: { actor: "ai" | "human"; status: "open" | "in_progress" | "failed" | "addressed" }): Promise<unknown>;
}
export interface ReviewCapabilityV1 { readonly apiVersion: 1; readonly store: WorkflowReviewStore }

export interface RunnerCommandV1 { readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
/** @deprecated AI consumers should use AiCapabilityV1. */
export interface RunnerRegistryV1 {
  list(context: { workspaceRoot: string }): Promise<ReadonlyArray<{ runner_id: string; name: string; provider_id?: string; verified: boolean; profiles?: readonly string[]; integration_kind?: AiMethodV1["method_kind"] }>> | ReadonlyArray<{ runner_id: string; name: string; provider_id?: string; verified: boolean; profiles?: readonly string[]; integration_kind?: AiMethodV1["method_kind"] }>;
  resolve(runnerId: string, context: { workspaceRoot: string; prompt: string; options?: Readonly<Record<string, string | number | boolean | null>> }): Promise<RunnerCommandV1> | RunnerCommandV1;
}
export type AiModeV1 = "workspace-write" | "text-only";
export interface AiMethodV1 {
  readonly method_id: string;
  readonly name: string;
  readonly method_kind: "cli" | "external-command" | "api" | "sdk" | "remote" | "integration";
  readonly modes: readonly AiModeV1[];
}
export interface AiInvocationResultV1 {
  readonly status: "completed" | "failed" | "cancelled" | "timeout" | "output-limit";
  readonly output: string;
  readonly exit_code: number | null;
  readonly message?: string;
}
export interface AiCapabilityV1 {
  readonly apiVersion: 1;
  list(input?: { readonly mode?: AiModeV1 }): Promise<readonly AiMethodV1[]> | readonly AiMethodV1[];
  invoke(input: { readonly method_id?: string; readonly mode: AiModeV1; readonly prompt: string; readonly timeout_ms?: number; readonly output_limit_bytes?: number; readonly options?: Readonly<Record<string, string | number | boolean | null>> }): { readonly result: Promise<AiInvocationResultV1>; cancel(): void };
}
