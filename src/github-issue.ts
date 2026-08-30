import { loadPluginIssueProvider } from "./plugin-runtime.js";

export interface GitHubIssueDraft {
  title: string;
  body: string;
}

export interface GitHubIssueResult {
  url: string;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be nonblank`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${field} is too long`);
  return text;
}

export function normalizeGitHubIssueDraft(value: unknown): GitHubIssueDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("issue draft must be an object");
  const draft = value as Record<string, unknown>;
  return {
    title: requiredText(draft.title, "title", 256),
    body: requiredText(draft.body, "body", 65_536),
  };
}

/** @deprecated Install the github-issue plugin and use loadPluginIssueProvider instead. */
export async function createGitHubIssue(projectRoot: string, rawDraft: unknown): Promise<GitHubIssueResult> {
  const draft = normalizeGitHubIssueDraft(rawDraft);
  const { provider } = await loadPluginIssueProvider("github-issue", projectRoot);
  return provider.createIssue(projectRoot, draft);
}
