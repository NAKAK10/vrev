export interface ProcessSupervisorPortV1 {
  run(spec: CommandSpec): { result: Promise<{ exitCode: number | null; reason: CommandResult["reason"]; stdout: string; errorMessage?: string }>; cancel(): void };
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
  errorMessage?: string;
}

export interface RunningCommand {
  result: Promise<CommandResult>;
  cancel(): void;
}

export type CommandExecutor = (spec: CommandSpec) => RunningCommand;

export function createSupervisorExecutor(supervisor: ProcessSupervisorPortV1): CommandExecutor {
  return (spec) => {
    const running = supervisor.run(spec);
    return {
      cancel: () => running.cancel(),
      result: running.result.then(({ exitCode, reason, stdout, errorMessage }) => ({ exitCode, reason, output: stdout, ...(errorMessage ? { errorMessage } : {}) })),
    };
  };
}
