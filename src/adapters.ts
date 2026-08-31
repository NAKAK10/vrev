import type { spawn } from "node:child_process";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT,
  createSupervisorExecutor,
  type CommandExecutor,
} from "../plugins/annotation-workflow/server/adapters.js";
import { createProcessSupervisor, type ProcessSupervisorOptions } from "./process-supervisor.js";

export interface SpawnExecutorOptions extends Omit<ProcessSupervisorOptions, "stdoutLimit" | "spawnProcess"> {
  outputLimit?: number;
  spawnProcess?: typeof spawn;
}

/** @deprecated Process execution is supervised by Core; runner adapters live in annotation-workflow. */
export function createSpawnExecutor(options: SpawnExecutorOptions = {}): CommandExecutor {
  return createSupervisorExecutor(createProcessSupervisor({
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.outputLimit === undefined ? {} : { stdoutLimit: options.outputLimit }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
    ...(options.killProcess === undefined ? {} : { killProcess: options.killProcess }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    stdoutLimit: options.outputLimit ?? MAX_COMMAND_OUTPUT,
  }));
}

/** @deprecated Workflow command adapters are owned by the annotation-workflow plugin. */
export * from "../plugins/annotation-workflow/server/adapters.js";
