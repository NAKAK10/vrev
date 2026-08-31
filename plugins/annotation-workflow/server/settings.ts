import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WorkflowSettings {
  schema_version: 1;
  /** Built-in runner ID or an opaque external selection prefixed with `custom:`. */
  runner: string;
  max_parallel: number;
  auto_run: boolean;
}

export interface ExternalRunnerOption {
  runner_id: string;
  name: string;
  provider_id: string;
  verified: boolean;
}

export const RUNNER_OPTIONS = Object.freeze([
  { value: "opencode", label: "OpenCode" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "pi", label: "Pi" },
] as const);

const builtInRunnerIds = new Set<string>(RUNNER_OPTIONS.map(({ value }) => value));
const externalSelectionPattern = /^custom:([0-9a-f]{8}-[0-9a-f-]{27,}|legacy-[0-9a-f]{32})$/;
const defaults: WorkflowSettings = { schema_version: 1, runner: "claude", max_parallel: 2, auto_run: false };

function settingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".vreview", "workflow-settings.json");
}

export function externalRunnerSelection(runnerId: string): string {
  return `custom:${runnerId}`;
}

export function parseRunnerSelection(value: string): { cli: "opencode" | "claude" | "codex" | "copilot" | "pi" | "custom"; runner_id?: string } {
  if (builtInRunnerIds.has(value)) return { cli: value as "opencode" | "claude" | "codex" | "copilot" | "pi" };
  const match = externalSelectionPattern.exec(value);
  if (!match?.[1]) throw new Error("selected AI runner is unavailable");
  return { cli: "custom", runner_id: match[1] };
}

export function readWorkflowSettings(workspaceRoot: string): WorkflowSettings {
  const filePath = settingsPath(workspaceRoot);
  if (!existsSync(filePath)) return { ...defaults };
  if (lstatSync(filePath).isSymbolicLink()) throw new Error("workflow settings must not be a symbolic link");
  const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<WorkflowSettings>;
  if (value.schema_version !== 1) return { ...defaults };
  const runner = typeof value.runner === "string" && (builtInRunnerIds.has(value.runner) || externalSelectionPattern.test(value.runner)) ? value.runner : defaults.runner;
  return {
    schema_version: 1,
    runner,
    max_parallel: Number.isInteger(value.max_parallel) && Number(value.max_parallel) >= 1 && Number(value.max_parallel) <= 10 ? Number(value.max_parallel) : defaults.max_parallel,
    auto_run: typeof value.auto_run === "boolean" ? value.auto_run : defaults.auto_run,
  };
}

export function updateWorkflowSettings(workspaceRoot: string, input: Record<string, unknown>, externalRunners: readonly ExternalRunnerOption[] = []): WorkflowSettings {
  const filePath = settingsPath(workspaceRoot);
  const current = readWorkflowSettings(workspaceRoot);
  const allowed = new Set([...builtInRunnerIds, ...externalRunners.map(({ runner_id }) => externalRunnerSelection(runner_id))]);
  const requested = typeof input.runner === "string" ? input.runner : current.runner;
  if (!allowed.has(requested)) throw new Error("selected AI runner is unavailable or has not passed verification");
  const maxParallel = Number(input.max_parallel ?? current.max_parallel);
  const autoRun = typeof input.auto_run === "boolean" ? input.auto_run : current.auto_run;
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) throw new Error("maximum parallel jobs must be an integer from 1 to 10");
  const next: WorkflowSettings = { schema_version: 1, runner: requested, max_parallel: maxParallel, auto_run: autoRun };
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
  return next;
}

export function workflowSettingsProjection(workspaceRoot: string, externalRunners: readonly ExternalRunnerOption[] = []): WorkflowSettings & { runner_options: { value: string; label: string }[]; parallel_options: number[] } {
  const settings = readWorkflowSettings(workspaceRoot);
  const externalOptions = externalRunners.map(({ runner_id, name, provider_id, verified }) => ({ value: externalRunnerSelection(runner_id), label: `${name}（${provider_id}${verified ? "" : "・未検証"}）` }));
  const runnerOptions = [...RUNNER_OPTIONS, ...externalOptions];
  const available = new Set(runnerOptions.map(({ value }) => value));
  return {
    ...settings,
    runner: available.has(settings.runner) ? settings.runner : defaults.runner,
    runner_options: runnerOptions,
    parallel_options: Array.from({ length: 10 }, (_, index) => index + 1),
  };
}
