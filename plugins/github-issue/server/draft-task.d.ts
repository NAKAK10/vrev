export interface GitHubIssueDraft { title: string; body: string }
export interface GitHubIssueResult { url: string }
export interface IssueDraftOutput extends GitHubIssueDraft { annotationId: string }
export declare const ISSUE_DRAFT_START: string;
export declare const ISSUE_DRAFT_END: string;
export declare function normalizeGitHubIssueDraft(value: unknown): GitHubIssueDraft;
export declare function validateStandaloneDraft(annotationId: string, value: unknown): GitHubIssueDraft;
export declare function extractIssueDraftOutput(output: string, allowedAnnotationIds?: ReadonlySet<string>): IssueDraftOutput[];
export declare function buildIssueCoordinatorInstructions(): string;
