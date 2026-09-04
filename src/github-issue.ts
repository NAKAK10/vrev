import {
  createIssueTaskCapability,
  normalizeGitHubIssueDraft,
  type GitHubIssueDraft,
  type GitHubIssueResult,
} from "../plugins/github-issue/server/index.js";
import { loadPluginIssueProvider } from "./plugin-runtime.js";

/** @deprecated Import from @visual-review/github-issue or use IssueTaskCapabilityV1. */
export { createIssueTaskCapability, normalizeGitHubIssueDraft };
/** @deprecated Import the plugin-owned types from @visual-review/github-issue. */
export type { GitHubIssueDraft, GitHubIssueResult };

/** @deprecated Install the github-issue plugin and use its IssueTaskCapabilityV1. */
export async function createGitHubIssue(projectRoot: string, rawDraft: unknown): Promise<GitHubIssueResult> {
  const draft = normalizeGitHubIssueDraft(rawDraft);
  const { provider } = await loadPluginIssueProvider("github-issue", projectRoot);
  return provider.createIssue(projectRoot, draft);
}
