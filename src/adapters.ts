import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import type { ReviewCli } from "./types.js";

export const MAX_COMMAND_OUTPUT = 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface CommandResult {
  exitCode: number | null;
  reason: "exit" | "cancelled" | "timeout" | "output-limit" | "spawn-error";
  output?: string;
}

export interface RunningCommand {
  result: Promise<CommandResult>;
  cancel(): void;
}

export type CommandExecutor = (spec: CommandSpec) => RunningCommand;

export interface AdapterInput {
  cli: ReviewCli;
  prompt: string;
  projectRoot: string;
  sessionId: string | null;
  opencodeAttach: string | null;
  customCommand?: string | null;
}

export function parseCustomCommand(value: string, prompt: string): { command: string; args: string[] } {
  if (!value.trim() || value.length > 2000 || /[\0\r\n]/.test(value)) throw new Error("custom command must be a single nonblank line up to 2000 characters");
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { parts.push(current); current = ""; }
      continue;
    }
    current += character;
  }
  if (escaped || quote !== null) throw new Error("custom command contains an unfinished escape or quote");
  if (current) parts.push(current);
  if (parts.length === 0) throw new Error("custom command must include an executable");
  if ((value.match(/\{prompt\}/g) ?? []).length !== 1) throw new Error("custom command must include {prompt} exactly once");
  const command = parts.shift()!;
  let replaced = false;
  const args = parts.map((part) => {
    if (!part.includes("{prompt}")) return part;
    replaced = true;
    return part.replaceAll("{prompt}", prompt);
  });
  return { command, args };
}

export function buildCommand(input: AdapterInput): CommandSpec {
  let args: string[];
  if (input.cli === "opencode") {
    args = ["run", "--format", "json"];
    if (input.sessionId !== null) args.push("--session", input.sessionId);
    if (input.opencodeAttach !== null) args.push("--attach", input.opencodeAttach);
    args.push(input.prompt);
  } else if (input.cli === "claude") {
    args = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits"];
    if (input.sessionId !== null) args.push("--resume", input.sessionId);
    args.push(input.prompt);
  } else if (input.cli === "codex" && input.sessionId === null) {
    args = ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", "--json", input.prompt];
  } else if (input.cli === "codex") {
    args = ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", "resume", "--json", input.sessionId!, input.prompt];
  } else if (input.cli === "copilot") {
    args = ["--prompt", input.prompt, "--allow-all-tools"];
  } else if (input.cli === "pi") {
    args = ["--print", "--mode", "json", "--no-session", "--approve", input.prompt];
  } else {
    const custom = parseCustomCommand(input.customCommand ?? "", input.prompt);
    return { command: custom.command, args: custom.args, cwd: input.projectRoot, env: { ...process.env } };
  }
  return { command: input.cli, args, cwd: input.projectRoot, env: { ...process.env } };
}

export interface SpawnExecutorOptions {
  timeoutMs?: number;
  outputLimit?: number;
  killGraceMs?: number;
  spawnProcess?: typeof spawn;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  platform?: NodeJS.Platform;
}

export function createSpawnExecutor(options: SpawnExecutorOptions = {}): CommandExecutor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? MAX_COMMAND_OUTPUT;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const spawnProcess = options.spawnProcess ?? spawn;
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const platform = options.platform ?? process.platform;
  return (spec) => {
    let child: ChildProcess & { stdout: Readable; stderr: Readable };
    let requestedReason: CommandResult["reason"] | undefined;
    let settled = false;
    let outputBytes = 0;
    const outputChunks: string[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let resolveResult!: (result: CommandResult) => void;
    const result = new Promise<CommandResult>((resolve) => { resolveResult = resolve; });

    const finish = (value: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolveResult({ ...value, output: outputChunks.join("") });
    };
    const terminate = (reason: CommandResult["reason"]): void => {
      if (settled || requestedReason !== undefined) return;
      requestedReason = reason;
      const signalTree = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        if (platform === "win32") {
          spawnProcess("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
            shell: false, stdio: "ignore",
          });
        } else {
          try { killProcess(-child.pid, signal); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      };
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), killGraceMs);
      killTimer.unref();
    };

    try {
      child = spawnProcess(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
      }) as ChildProcess & { stdout: Readable; stderr: Readable };
    } catch {
      finish({ exitCode: null, reason: "spawn-error" });
      return { result, cancel: () => undefined };
    }
    const countOutput = (chunk: Buffer | string): void => {
      outputChunks.push(chunk.toString());
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > outputLimit) terminate("output-limit");
    };
    child.stdout.on("data", countOutput);
    child.stderr.on("data", countOutput);
    child.once("error", () => finish({ exitCode: null, reason: requestedReason ?? "spawn-error" }));
    child.once("close", (code) => finish({ exitCode: code, reason: requestedReason ?? "exit" }));
    timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    timeoutTimer.unref();
    return { result, cancel: () => terminate("cancelled") };
  };
}
