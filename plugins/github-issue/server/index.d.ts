import type { GitHubIssueProvider, GitHubIssueResult } from "./issue-provider.js";
export * from "./draft-task.js";
export { IssueCreationIndeterminateError } from "./issue-provider.js";
export type { GitHubIssueProvider, GitHubIssueResult } from "./issue-provider.js";
export declare const ISSUE_TASK_CAPABILITY_ID = "issue-task";
export declare const ISSUE_TASK_CAPABILITY_API_VERSION = 1;
export interface IssueProjectionAnnotationV1 { id: string; status: string; issue_state?: string; issue_url?: string }
export interface IssueProjectionStoreV1 {
  readonly target: Readonly<{ projectRoot: string }>;
  load(): { annotations: IssueProjectionAnnotationV1[] };
  loadActive(): { annotations: IssueProjectionAnnotationV1[] };
  setIssueDraftReady(annotationId: string, title: string, body: string): unknown;
  completeIssueDraft(annotationId: string, title: string, url: string): unknown;
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
  readonly annotations: { create(input: IssueAnnotationCreateInputV1): IssueAnnotationCreateResultV1 };
}
export type IssueTaskToneV1 = "pending" | "active" | "ready" | "done" | "failed";
export interface IssueTaskLabelV1 { readonly text: string; readonly tone: IssueTaskToneV1 }
export interface IssueTaskCapabilityV1 {
  readonly apiVersion: 1;
  coordinatorInstructions(): string;
  acceptCoordinatorOutput(output: string, allowedAnnotationIds: ReadonlySet<string>): readonly string[];
  state(annotation: IssueProjectionAnnotationV1): "none" | "pending" | "complete";
  label(annotation: IssueProjectionAnnotationV1): IssueTaskLabelV1 | null;
  create(annotationId: string, rawDraft: unknown): Promise<GitHubIssueResult>;
}
export interface CreateIssueTaskOptions { provider?: GitHubIssueProvider; projectRoot?: string }
export declare function createIssueTaskCapability(review: IssueReviewCapabilityV1, options?: CreateIssueTaskOptions): IssueTaskCapabilityV1;
export declare function createIssueBridgeAdapter(review: IssueReviewCapabilityV1, issueTask: IssueTaskCapabilityV1): {
  query(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
  command(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
};
declare const provider: Readonly<{ apiVersion: 1; create(context: unknown): unknown }>;
export default provider;
