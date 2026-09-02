import { spawn } from "node:child_process";

const GH_OUTPUT_LIMIT = 64 * 1024;
const GH_TIMEOUT_MS = 30_000;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;

export class IssueCreationIndeterminateError extends Error {
  constructor(message) {
    super(message);
    this.name = "IssueCreationIndeterminateError";
    this.indeterminate = true;
  }
}

/**
 * Failures GitHub reports before accepting the mutation. The Issue definitively does not exist,
 * so telling the reviewer the outcome is unknown would be wrong: the cause is theirs to fix
 * (wrong account, missing scope, no access to the repository).
 */
const REJECTED_BEFORE_CREATE = [
  /Could not resolve to a Repository/i,
  /Resource not accessible by/i,
  /HTTP 40[13]\b/,
  /gh auth login/i,
  /must be authenticated/i,
  /no git remotes found/i,
  /not a git repository/i,
];

function rejectedBeforeCreate(stderr) {
  return REJECTED_BEFORE_CREATE.some((pattern) => pattern.test(stderr));
}

/** Authoritative provider invocation. It never retries an external side effect. */
export const provider = Object.freeze({
  async createIssue(projectRoot, draft) {
    return new Promise((resolve, reject) => {
      const child = spawn("gh", ["issue", "create", "--title", draft.title, "--body-file", "-"], {
        cwd: projectRoot,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let outputSize = 0;
      let settled = false;
      let started = false;
      let killTimer;
      const signalTree = (signal) => {
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, signal); } catch (error) {
            if (error?.code === "ESRCH") return;
            child.kill(signal);
          }
        } else child.kill(signal);
      };
      const terminate = () => {
        signalTree("SIGTERM");
        killTimer = setTimeout(() => signalTree("SIGKILL"), 2_000);
        killTimer.unref();
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        terminate();
        finish(new IssueCreationIndeterminateError("GitHub Issue作成結果を確認できませんでした（タイムアウト）。自動再試行は行いません"));
      }, GH_TIMEOUT_MS);
      const collect = (target, chunk) => {
        outputSize += chunk.byteLength;
        if (outputSize > GH_OUTPUT_LIMIT) {
          terminate();
          finish(new IssueCreationIndeterminateError("gh output exceeded the safety limit; Issue作成結果は不明なため自動再試行しません"));
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk) => collect("stdout", chunk));
      child.stderr.on("data", (chunk) => collect("stderr", chunk));
      child.once("spawn", () => { started = true; });
      child.once("error", (error) => finish(new Error(`GitHub CLIを起動できませんでした: ${error.message}`)));
      child.once("close", (code) => {
        if (killTimer) clearTimeout(killTimer);
        if (settled) return;
        if (code !== 0) {
          const detail = stderr.trim() || `gh issue create failed with exit code ${code}`;
          if (!started || rejectedBeforeCreate(detail)) return finish(new Error(detail));
          return finish(new IssueCreationIndeterminateError(`${detail} (Issue作成結果は不明なため自動再試行しません)`));
        }
        const url = stdout.trim().split(/\s+/).reverse().find((value) => ISSUE_URL_PATTERN.test(value));
        if (!url) return finish(new IssueCreationIndeterminateError("GitHub Issue URLを取得できず作成結果が不明です。自動再試行は行いません"));
        finish(undefined, { url });
      });
      child.stdin.end(draft.body);
    });
  },
});

export default provider;
