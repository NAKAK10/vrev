import { spawn } from "node:child_process";

const GH_OUTPUT_LIMIT = 64 * 1024;
const GH_TIMEOUT_MS = 30_000;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;

const provider = {
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
      const timer = setTimeout(() => {
        terminate();
        finish(new Error("GitHub Issue作成がタイムアウトしました"));
      }, GH_TIMEOUT_MS);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const collect = (target, chunk) => {
        outputSize += chunk.byteLength;
        if (outputSize > GH_OUTPUT_LIMIT) {
          terminate();
          finish(new Error("gh output exceeded the safety limit"));
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk) => collect("stdout", chunk));
      child.stderr.on("data", (chunk) => collect("stderr", chunk));
      child.once("error", (error) => finish(new Error(`GitHub CLIを起動できませんでした: ${error.message}`)));
      child.once("close", (code) => {
        if (killTimer) clearTimeout(killTimer);
        if (settled) return;
        if (code !== 0) return finish(new Error(stderr.trim() || `gh issue create failed with exit code ${code}`));
        const url = stdout.trim().split(/\s+/).reverse().find((value) => ISSUE_URL_PATTERN.test(value));
        if (!url) return finish(new Error("GitHub Issue URLを取得できませんでした"));
        finish(undefined, { url });
      });
      child.stdin.end(draft.body);
    });
  },
};

export default provider;
