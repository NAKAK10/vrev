import { spawn } from "node:child_process";

const GH_OUTPUT_LIMIT = 64 * 1024;
const GH_TIMEOUT_MS = 30_000;
const GH_READ_TIMEOUT_MS = 5_000;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ACCOUNT_LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

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

function signalTree(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error?.code === "ESRCH") return;
      child.kill(signal);
    }
  } else child.kill(signal);
}

/**
 * Read-only gh invocation for the dialog's target hint. Hardened the same way as `createIssue`
 * (no shell, output cap, tree kill on timeout) but with a short timeout since it blocks a dialog,
 * and it never rejects — any failure just means the caller falls back to "unknown".
 */
function runGhReadOnly(projectRoot, args) {
  return new Promise((resolve) => {
    const child = spawn("gh", args, {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let outputSize = 0;
    let settled = false;
    let killTimer;
    const terminate = () => {
      signalTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
      killTimer.unref();
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(value);
    };
    const timer = setTimeout(() => { terminate(); finish(null); }, GH_READ_TIMEOUT_MS);
    const collect = (chunk) => {
      outputSize += chunk.byteLength;
      if (outputSize > GH_OUTPUT_LIMIT) { terminate(); finish(null); return; }
      stdout += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", (chunk) => { outputSize += chunk.byteLength; if (outputSize > GH_OUTPUT_LIMIT) { terminate(); finish(null); } });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      if (code !== 0) return finish(null);
      finish(stdout.trim());
    });
  });
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
      const terminate = () => {
        signalTree(child, "SIGTERM");
        killTimer = setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
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

  /**
   * Best-effort lookup of the repository and account `gh` would use if createIssue ran right now.
   * The dialog shows this so a credential/remote mismatch is visible before the reviewer submits,
   * instead of surfacing only as "Could not resolve to a Repository" after the fact. Never throws.
   */
  async resolveTarget(projectRoot) {
    const [repoRaw, accountRaw] = await Promise.all([
      runGhReadOnly(projectRoot, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]),
      runGhReadOnly(projectRoot, ["api", "user", "--jq", ".login"]),
    ]);
    const repo = repoRaw && REPO_NAME_PATTERN.test(repoRaw) ? repoRaw : null;
    const account = accountRaw && ACCOUNT_LOGIN_PATTERN.test(accountRaw) ? accountRaw : null;
    return { repo, account };
  },
});

export default provider;
