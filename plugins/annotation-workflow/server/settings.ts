import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WorkflowSettings {
  schema_version: 1;
  max_parallel: number;
  auto_run: boolean;
}

const defaults: WorkflowSettings = { schema_version: 1, max_parallel: 2, auto_run: false };

function settingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".vrev", "workflow-settings.json");
}

export function readWorkflowSettings(workspaceRoot: string): WorkflowSettings {
  const filePath = settingsPath(workspaceRoot);
  if (!existsSync(filePath)) return { ...defaults };
  if (lstatSync(filePath).isSymbolicLink()) throw new Error("workflow settings must not be a symbolic link");
  const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<WorkflowSettings>;
  if (value.schema_version !== 1) return { ...defaults };
  return {
    schema_version: 1,
    max_parallel: Number.isInteger(value.max_parallel) && Number(value.max_parallel) >= 1 && Number(value.max_parallel) <= 10 ? Number(value.max_parallel) : defaults.max_parallel,
    auto_run: typeof value.auto_run === "boolean" ? value.auto_run : defaults.auto_run,
  };
}

export function updateWorkflowSettings(workspaceRoot: string, input: Record<string, unknown>): WorkflowSettings {
  const filePath = settingsPath(workspaceRoot);
  const current = readWorkflowSettings(workspaceRoot);
  const maxParallel = Number(input.max_parallel ?? current.max_parallel);
  const autoRun = typeof input.auto_run === "boolean" ? input.auto_run : current.auto_run;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) throw new Error("maximum parallel jobs must be an integer from 1 to 10");
  const next: WorkflowSettings = { schema_version: 1, max_parallel: maxParallel, auto_run: autoRun };
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
  return next;
}

export function workflowSettingsProjection(workspaceRoot: string): WorkflowSettings & { parallel_options: number[] } {
  return { ...readWorkflowSettings(workspaceRoot), parallel_options: Array.from({ length: 10 }, (_, index) => index + 1) };
}
