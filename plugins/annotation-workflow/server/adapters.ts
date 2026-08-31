import type { ReviewCli, RunnerCommandV1 } from "./workflow-types.js";

export interface ProcessSupervisorPortV1 {
  run(spec: CommandSpec): { result: Promise<{ exitCode: number | null; reason: CommandResult["reason"]; stdout: string }>; cancel(): void };
}

export const MAX_COMMAND_OUTPUT = 64 * 1024;
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
  /** @deprecated Compatibility-only raw template support. */
  customCommand?: string | null;
  customSpec?: RunnerCommandV1;
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
    args = ["run"];
    if (input.sessionId !== null) args.push("--session", input.sessionId);
    if (input.opencodeAttach !== null) args.push("--attach", input.opencodeAttach);
    args.push(input.prompt);
  } else if (input.cli === "claude") {
    args = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits"];
    if (input.sessionId !== null) args.push("--resume", input.sessionId);
    args.push(input.prompt);
  } else if (input.cli === "codex" && input.sessionId === null) {
    args = ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", input.prompt];
  } else if (input.cli === "codex") {
    args = ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", "resume", input.sessionId!, input.prompt];
  } else if (input.cli === "copilot") {
    args = ["--prompt", input.prompt, "--allow-all-tools"];
  } else if (input.cli === "pi") {
    args = ["--print", "--no-session", "--approve", "--", input.prompt];
  } else {
    if (input.customSpec) return {
      command: input.customSpec.command,
      args: [...input.customSpec.args],
      cwd: input.customSpec.cwd ?? input.projectRoot,
      env: input.customSpec.env ?? { ...process.env },
    };
    const custom = parseCustomCommand(input.customCommand ?? "", input.prompt);
    return { command: custom.command, args: custom.args, cwd: input.projectRoot, env: { ...process.env } };
  }
  return { command: input.cli, args, cwd: input.projectRoot, env: { ...process.env } };
}

export function createSupervisorExecutor(supervisor: ProcessSupervisorPortV1): CommandExecutor {
  return (spec) => {
    const running = supervisor.run(spec);
    return {
      cancel: () => running.cancel(),
      result: running.result.then(({ exitCode, reason, stdout }) => ({ exitCode, reason, output: stdout })),
    };
  };
}
