import { existsSync } from "node:fs";
import path from "node:path";

import { atomicWriteJson, readJson, withFileLock } from "./persistence.js";
import type { ReviewJob, ReviewJobBatch, ReviewJobState } from "./workflow-types.js";

const JOB_STATES = new Set(["queued", "running", "succeeded", "failed", "cancelled", "skipped"]);
const CLIS = new Set(["ai", "opencode", "claude", "codex", "copilot", "pi", "custom"]);

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSafeAttach(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function validateJob(value: unknown): asserts value is ReviewJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("job-state contains an invalid job");
  const job = value as Record<string, unknown>;
  const allowed = new Set(["id", "batch_id", "annotation_id", "page_path", "source_hash", "deferred_checkpoint", "cli", "custom_name", "session_id", "state", "created", "started", "finished", "exit_code", "summary"]);
  if (Object.keys(job).some((key) => !allowed.has(key))) throw new Error("job-state job contains an unknown field");
  for (const key of ["id", "batch_id", "annotation_id", "page_path", "source_hash", "created", "summary"] as const) {
    if (typeof job[key] !== "string") throw new Error(`job-state job.${key} must be a string`);
  }
  if (!("custom_name" in job)) job.custom_name = null;
  if (!("deferred_checkpoint" in job)) job.deferred_checkpoint = false;
  if (typeof job.deferred_checkpoint !== "boolean") throw new Error("job-state job.deferred_checkpoint must be a boolean");
  if (!CLIS.has(job.cli as string)) throw new Error("job-state job.cli is invalid");
  if (!isStringOrNull(job.custom_name)) throw new Error("job-state job.custom_name is invalid");
  if (!JOB_STATES.has(job.state as string)) throw new Error("job-state job.state is invalid");
  if (!isStringOrNull(job.session_id) || !isStringOrNull(job.started) || !isStringOrNull(job.finished)) {
    throw new Error("job-state job contains an invalid nullable string");
  }
  if (job.exit_code !== null && (!Number.isInteger(job.exit_code) || typeof job.exit_code !== "number")) {
    throw new Error("job-state job.exit_code is invalid");
  }
}

function validateBatch(value: unknown): asserts value is ReviewJobBatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("job-state contains an invalid batch");
  const batch = value as Record<string, unknown>;
  if (Object.keys(batch).some((key) => key !== "id" && key !== "max_parallel" && key !== "opencode_attach" && key !== "runner_id" && key !== "custom_command")) throw new Error("job-state batch contains an unknown field");
  if (!("custom_command" in batch)) batch.custom_command = null;
  if (!("runner_id" in batch)) batch.runner_id = null;
  if (typeof batch.id !== "string" || !Number.isInteger(batch.max_parallel) || (batch.max_parallel as number) < 1 || (batch.max_parallel as number) > 10 || !isSafeAttach(batch.opencode_attach) || !isStringOrNull(batch.runner_id) || !isStringOrNull(batch.custom_command)) {
    throw new Error("job-state contains an invalid batch");
  }
}

function validateState(value: unknown): ReviewJobState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("job-state.json must contain an object");
  const state = value as Record<string, unknown>;
  if (Object.keys(state).some((key) => key !== "revision" && key !== "batches" && key !== "jobs")) throw new Error("job-state.json contains an unknown field");
  if (!Number.isInteger(state.revision) || (state.revision as number) < 0 || !Array.isArray(state.batches) || !Array.isArray(state.jobs)) {
    throw new Error("job-state.json has an invalid schema");
  }
  state.batches.forEach(validateBatch);
  state.jobs.forEach(validateJob);
  const batches = state.batches as ReviewJobBatch[];
  const jobs = state.jobs as ReviewJob[];
  const batchIds = new Set(batches.map(({ id }) => id));
  if (jobs.some(({ batch_id }) => !batchIds.has(batch_id))) throw new Error("job-state job refers to an unknown batch");
  if (jobs.some((job) => {
    const batch = batches.find(({ id }) => id === job.batch_id);
    return job.cli === "custom" && !batch?.custom_command && !batch?.runner_id;
  })) throw new Error("job-state custom job has no runner");
  return state as unknown as ReviewJobState;
}

export class JobStore {
  readonly path: string;

  constructor(reviewPath: string) {
    this.path = path.join(path.dirname(reviewPath), "job-state.json");
  }

  private loadUnlocked(): ReviewJobState {
    if (!existsSync(this.path)) return { revision: 0, batches: [], jobs: [] };
    try {
      return validateState(readJson(this.path));
    } catch (error) {
      throw new Error(`invalid job-state.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  load(): ReviewJobState {
    return withFileLock(this.path, () => structuredClone(this.loadUnlocked()));
  }

  update(operation: (state: ReviewJobState) => void): ReviewJobState {
    return withFileLock(this.path, () => {
      const state = this.loadUnlocked();
      operation(state);
      state.revision += 1;
      atomicWriteJson(this.path, state);
      return structuredClone(state);
    });
  }

  recoverRunning(): ReviewJobState {
    const current = this.load();
    if (!current.jobs.some(({ state }) => state === "running")) return current;
    const timestamp = new Date().toISOString();
    return this.update((state) => {
      for (const job of state.jobs) {
        if (job.state !== "running") continue;
        job.state = "failed";
        job.finished = timestamp;
        job.exit_code = null;
        job.summary = "failed after restart: result unknown";
      }
    });
  }
}
