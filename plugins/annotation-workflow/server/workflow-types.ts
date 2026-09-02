export type ReviewCli = "opencode" | "claude" | "codex" | "copilot" | "pi" | "custom";
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
  cli: ReviewCli;
  max_parallel: number;
  session_id?: string | null;
  opencode_attach?: string | null;
  runner_id?: string | null;
  annotation_ids?: string[] | null;
}

/** The subset of the versioned review capability required by workflow orchestration. */
export interface WorkflowAnnotation {
  id: string;
  page_path: string;
  source_hash: string;
  status: string;
  thread: Array<{ actor: string; body: string; at: string }>;
}
export interface WorkflowReviewStore {
  readonly path: string;
  readonly target: Readonly<{ projectRoot: string }>;
  sourceHash(pagePath?: string): string;
  load(): { annotations: WorkflowAnnotation[] };
  loadActive(): { annotations: WorkflowAnnotation[] };
  addMessage(annotationId: string, payload: { actor: "ai"; body: string }): unknown;
  setStatus(annotationId: string, payload: { actor: "ai" | "human"; status: "open" | "in_progress" | "failed" | "addressed" }): unknown;
}
export interface ReviewCapabilityV1 { readonly apiVersion: 1; readonly store: WorkflowReviewStore }

export interface RunnerCommandV1 { command: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }
export interface RunnerRegistryV1 {
  list(context: Readonly<{ workspaceRoot: string }>): readonly { runner_id: string; name: string; provider_id: string; verified: boolean }[] | Promise<readonly { runner_id: string; name: string; provider_id: string; verified: boolean }[]>;
  resolve(runnerId: string, context: Readonly<{ workspaceRoot: string; prompt: string }>): RunnerCommandV1 | Promise<RunnerCommandV1>;
}

export type WorkflowTaskToneV1 = "pending" | "active" | "ready" | "done" | "failed";
export interface WorkflowTaskLabelV1 { readonly text: string; readonly tone: WorkflowTaskToneV1 }

/** Structural port supplied by an optional task plugin; no plugin implementation import is required. */
export interface WorkflowTaskCapabilityV1 {
  coordinatorInstructions(): string;
  acceptCoordinatorOutput(output: string, allowedAnnotationIds: ReadonlySet<string>): readonly string[];
  state(annotation: WorkflowAnnotation): "none" | "pending" | "complete";
  /** Optional status-badge override for an annotation this task owns; null = use the workflow default label. */
  label?(annotation: WorkflowAnnotation): WorkflowTaskLabelV1 | null;
}
