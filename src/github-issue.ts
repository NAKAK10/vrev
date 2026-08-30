import { spawn } from "node:child_process";

export interface GitHubIssueDraft {
  title: string;
  body: string;
}

export interface GitHubIssueResult {
  url: string;
}

const GH_OUTPUT_LIMIT = 64 * 1024;
const GH_TIMEOUT_MS = 30_000;

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

export async function createGitHubIssue(projectRoot: string, rawDraft: unknown): Promise<GitHubIssueResult> {
  const draft = normalizeGitHubIssueDraft(rawDraft);
  return new Promise<GitHubIssueResult>((resolve, reject) => {
    const child = spawn("gh", ["issue", "create", "--title", draft.title, "--body-file", "-"], {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputSize = 0;
    let settled = false;
    const finish = (error?: Error, result?: GitHubIssueResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputSize += chunk.byteLength;
      if (outputSize > GH_OUTPUT_LIMIT) {
        child.kill("SIGTERM");
        finish(new Error("gh output exceeded the safety limit"));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error) => finish(new Error(`GitHub CLIを起動できませんでした: ${error.message}`)));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error(stderr.trim() || `gh issue create failed with exit code ${code}`));
      const url = stdout.trim().split(/\s+/).reverse().find((value: string) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(value));
      if (!url) return finish(new Error("GitHub Issue URLを取得できませんでした"));
      finish(undefined, { url });
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("GitHub Issue作成がタイムアウトしました"));
    }, GH_TIMEOUT_MS);
    child.stdin.end(draft.body);
  });
}
