import type { GitHubIssueProvider, GitHubIssueResult } from "./issue-provider.js";
export * from "./draft-task.js";
export { IssueCreationIndeterminateError } from "./issue-provider.js";
export type { GitHubIssueProvider, GitHubIssueResult, GitHubIssueTarget } from "./issue-provider.js";
export declare const ISSUE_TASK_CAPABILITY_ID = "issue-task";
export declare const ISSUE_TASK_CAPABILITY_API_VERSION = 1;
export declare const AI_CAPABILITY_ID = "ai";
export declare const AI_CAPABILITY_API_VERSION = 1;
export interface IssueProjectionAnnotationV1 { id: string; status: string; comment?: string; page_path?: string; anchor?: unknown; created_at?: string; issue_state?: string; issue_title?: string; issue_body?: string; issue_url?: string }
export interface IssueProjectionStoreV1 {
  readonly target: Readonly<{ projectRoot: string }>;
  load(): Promise<{ revision?: number; annotations: IssueProjectionAnnotationV1[] }>;
  loadActive(): Promise<{ revision?: number; annotations: IssueProjectionAnnotationV1[] }>;
  setIssueDraftReady(annotationId: string, title: string, body: string): Promise<unknown>;
  failIssueDraft(annotationId: string, message: string): Promise<unknown>;
  completeIssueDraft(annotationId: string, title: string, url: string): Promise<unknown>;
}
export interface IssueAnnotationCreateInputV1 {
  anchor: unknown;
  comment: string;
  expected_revision?: unknown;
  mode?: "annotation" | "issue-request";
}
export interface IssueAnnotationCreateResultV1 { review: unknown; annotation: IssueProjectionAnnotationV1 }
export interface IssueReviewCapabilityV1 {
  readonly apiVersion: 1;
  readonly store: IssueProjectionStoreV1;
  readonly annotations: { create(input: IssueAnnotationCreateInputV1): Promise<IssueAnnotationCreateResultV1> };
}
export type IssueTaskToneV1 = "pending" | "active" | "ready" | "done" | "failed";
export interface IssueTaskLabelV1 { readonly text: string; readonly tone: IssueTaskToneV1 }
export interface IssueTaskFilterV1 { readonly id: string; readonly label: string }
export interface IssueTaskCreateResultV1 extends GitHubIssueResult { readonly review?: unknown }
export interface IssueTaskCapabilityV1 {
  readonly apiVersion: 1;
  coordinatorInstructions(): string;
  acceptCoordinatorOutput(output: string, allowedAnnotationIds: ReadonlySet<string>): Promise<readonly string[]>;
  state(annotation: IssueProjectionAnnotationV1): "none" | "pending" | "complete";
  label(annotation: IssueProjectionAnnotationV1): IssueTaskLabelV1 | null;
  filters(): readonly IssueTaskFilterV1[];
  filter(annotation: IssueProjectionAnnotationV1): string | null;
  create(annotationId: string, rawDraft: unknown): Promise<IssueTaskCreateResultV1>;
}
export interface CreateIssueTaskOptions { provider?: GitHubIssueProvider; projectRoot?: string }
export declare function createIssueTaskCapability(review: IssueReviewCapabilityV1, options?: CreateIssueTaskOptions): IssueTaskCapabilityV1;
export interface IssueAiMethodV1 { readonly method_id: string; readonly name: string; readonly method_kind: "cli" | "external-command" | "api" | "sdk" | "remote" | "integration"; readonly modes: readonly ("workspace-write" | "text-only")[] }
export interface IssueAiCapabilityV1 {
  list(input?: { mode?: "workspace-write" | "text-only" }): Promise<readonly IssueAiMethodV1[]> | readonly IssueAiMethodV1[];
  invoke(input: any): { result: Promise<{ status: string; output: string; message?: string }>; cancel(): void };
}
export interface CreateIssueBridgeAdapterOptions { review: IssueReviewCapabilityV1; issueTask: IssueTaskCapabilityV1; provider?: GitHubIssueProvider; ai?: IssueAiCapabilityV1; projectRoot?: string; draftsEnabled?: boolean }
export declare function createIssueBridgeAdapter(options: CreateIssueBridgeAdapterOptions): {
  query(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
  command(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
  stop(): void;
};
/** @deprecated Use the structural options overload. */
export declare function createIssueBridgeAdapter(review: IssueReviewCapabilityV1, issueTask: IssueTaskCapabilityV1, options?: Omit<CreateIssueBridgeAdapterOptions, "review" | "issueTask">): {
  query(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
  command(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
  stop(): void;
};
declare const provider: Readonly<{ apiVersion: 1; create(context: unknown): unknown }>;
export default provider;
