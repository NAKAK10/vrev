import type { GitHubIssueDraft } from "./draft-task.js";

export interface GitHubIssueResult { url: string }
export interface GitHubIssueTarget { repo: string | null; account: string | null }
export interface GitHubIssueProvider {
  createIssue(projectRoot: string, draft: GitHubIssueDraft): Promise<GitHubIssueResult>;
  resolveTarget?(projectRoot: string): Promise<GitHubIssueTarget>;
}
export declare class IssueCreationIndeterminateError extends Error { readonly indeterminate: true }
export declare const provider: GitHubIssueProvider;
export default provider;
