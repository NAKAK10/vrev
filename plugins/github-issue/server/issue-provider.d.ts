import type { GitHubIssueDraft } from "./draft-task.js";

export interface GitHubIssueResult { url: string }
export interface GitHubIssueProvider { createIssue(projectRoot: string, draft: GitHubIssueDraft): Promise<GitHubIssueResult> }
export declare class IssueCreationIndeterminateError extends Error { readonly indeterminate: true }
export declare const provider: GitHubIssueProvider;
export default provider;
