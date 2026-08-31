import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_PROCESS_STDOUT_LIMIT = 1024 * 1024;

export interface ProcessSpecV1 {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ProcessResultV1 {
  readonly exitCode: number | null;
  readonly reason: "exit" | "cancelled" | "timeout" | "output-limit" | "spawn-error";
  readonly stdout: string;
}

export interface RunningProcessV1 {
  readonly result: Promise<ProcessResultV1>;
  cancel(): void;
}

export interface ProcessSupervisorV1 {
  run(spec: ProcessSpecV1): RunningProcessV1;
}

export interface ProcessSupervisorOptions {
  timeoutMs?: number;
  stdoutLimit?: number;
  killGraceMs?: number;
  spawnProcess?: typeof spawn;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
}

/** Creates a shell-free supervisor that retains only recent stdout and supports process-tree shutdown. */
export function createProcessSupervisor(options: ProcessSupervisorOptions = {}): ProcessSupervisorV1 {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const stdoutLimit = options.stdoutLimit ?? DEFAULT_PROCESS_STDOUT_LIMIT;
  const killGraceMs = options.killGraceMs ?? 2_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be non-negative");
  if (!Number.isSafeInteger(stdoutLimit) || stdoutLimit < 0) throw new Error("stdoutLimit must be a non-negative integer");
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0) throw new Error("killGraceMs must be non-negative");

  const spawnProcess = options.spawnProcess ?? spawn;
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const platform = options.platform ?? process.platform;

  return {
    run(spec): RunningProcessV1 {
      let child: ChildProcess & { stdout: Readable; stderr: Readable };
      let requestedReason: ProcessResultV1["reason"] | undefined;
      let settled = false;
      let stdoutBytes = 0;
      const stdoutChunks: Buffer[] = [];
      let killTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let resolveResult!: (result: ProcessResultV1) => void;
      const result = new Promise<ProcessResultV1>((resolve) => { resolveResult = resolve; });

      const finish = (exitCode: number | null, reason: ProcessResultV1["reason"]): void => {
        if (settled) return;
        settled = true;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolveResult({ exitCode, reason, stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8") });
      };
      const signalTree = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        if (platform === "win32") {
          spawnProcess("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
            shell: false,
            stdio: "ignore",
          });
          return;
        }
        try {
          killProcess(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      const terminate = (reason: ProcessResultV1["reason"]): void => {
        if (settled || requestedReason !== undefined) return;
        requestedReason = reason;
        signalTree("SIGTERM");
        killTimer = setTimeout(() => signalTree("SIGKILL"), killGraceMs);
        killTimer.unref();
      };

      try {
        child = spawnProcess(spec.command, [...spec.args], {
          cwd: spec.cwd,
          env: spec.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          detached: platform !== "win32",
        }) as ChildProcess & { stdout: Readable; stderr: Readable };
      } catch {
        finish(null, "spawn-error");
        return { result, cancel: () => undefined };
      }

      child.stdout.on("data", (value: Buffer | string) => {
        if (stdoutLimit === 0) return;
        const chunk = Buffer.from(value);
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
        while (stdoutBytes > stdoutLimit && stdoutChunks.length > 0) {
          const overflow = stdoutBytes - stdoutLimit;
          const oldest = stdoutChunks[0]!;
          if (oldest.length <= overflow) {
            stdoutChunks.shift();
            stdoutBytes -= oldest.length;
          } else {
            stdoutChunks[0] = Buffer.from(oldest.subarray(overflow));
            stdoutBytes -= overflow;
          }
        }
      });
      child.stderr.resume();
      child.once("error", () => finish(null, requestedReason ?? "spawn-error"));
      child.once("close", (code) => finish(code, requestedReason ?? "exit"));
      timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
      timeoutTimer.unref();
      return { result, cancel: () => terminate("cancelled") };
    },
  };
}
