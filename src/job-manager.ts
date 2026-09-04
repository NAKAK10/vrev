import type { CommandExecutor } from "../plugins/annotation-workflow/server/adapters.js";
import { parseCommandTemplate } from "../plugins/ai/server/custom-command.js";
import { createSpawnExecutor } from "./adapters.js";
import {
  JobManager as PluginJobManager,
  buildBatchPrompt as buildWorkflowBatchPrompt,
  validateEnqueueInput,
} from "../plugins/annotation-workflow/server/job-manager.js";
import {
  buildIssueCoordinatorInstructions,
  createIssueTaskCapability,
  extractIssueDraftOutput,
  type IssueDraftOutput,
} from "../plugins/github-issue/server/index.js";
import { createReviewAnnotationsV1 } from "../plugins/review/server/review-capability.js";
import type { AiCapabilityV1, ReviewCapabilityV1, RunnerRegistryV1, WorkflowReviewStore } from "../plugins/annotation-workflow/server/workflow-types.js";
import type { ReviewStoreContract } from "../plugins/review/server/review-store.js";

/** @deprecated Construct workflow jobs through the annotation-workflow capability. */
export interface JobManagerOptions {
  executor?: CommandExecutor;
  customCommandResolver?: (runnerId: string) => { template: string } | Promise<{ template: string }>;
  runnerRegistry?: RunnerRegistryV1;
  ai?: AiCapabilityV1;
}

/** @deprecated Authoritative orchestration lives in plugins/annotation-workflow/server. */
export class JobManager extends PluginJobManager {
  constructor(store: ReviewStoreContract, options: JobManagerOptions = {}) {
    let runnerRegistry = options.runnerRegistry;
    if (!runnerRegistry && options.customCommandResolver) {
      const resolveTemplate = options.customCommandResolver;
      runnerRegistry = {
        list() { return []; },
        async resolve(runnerId, { workspaceRoot, prompt }) {
          const { command, args } = parseCommandTemplate((await resolveTemplate(runnerId)).template, prompt);
          return { command, args, cwd: workspaceRoot, env: { ...process.env } };
        },
      };
    }
    const executor = options.executor ?? createSpawnExecutor();
    const ai = options.ai ?? (runnerRegistry ? {
      apiVersion: 1 as const,
      async list() {
        const descriptors = await runnerRegistry.list({ workspaceRoot: store.target.projectRoot });
        return descriptors.filter(({ verified }) => verified).map(({ runner_id, name, integration_kind, profiles }) => ({
          method_id: runner_id,
          name,
          method_kind: integration_kind ?? "integration" as const,
          modes: ["workspace-write" as const, ...(profiles?.includes("text-only") ? ["text-only" as const] : [])],
        }));
      },
      invoke(request) {
        let running: ReturnType<CommandExecutor> | undefined;
        let cancelled = false;
        const result = (async () => {
          const methodId = request.method_id ?? (await this.list({ mode: request.mode }))[0]?.method_id;
          if (!methodId) throw new Error("AI method is unavailable");
          const spec = await runnerRegistry.resolve(methodId, { workspaceRoot: store.target.projectRoot, prompt: request.prompt, ...(request.options ? { options: request.options } : {}) });
          if (cancelled) return { status: "cancelled" as const, output: "", exit_code: null };
          running = executor({ command: spec.command, args: [...spec.args], cwd: spec.cwd ?? store.target.projectRoot, env: spec.env ?? { ...process.env } });
          const completed = await running.result;
          return {
            status: completed.reason === "exit" && completed.exitCode === 0 ? "completed" as const : completed.reason === "exit" || completed.reason === "spawn-error" ? "failed" as const : completed.reason,
            output: completed.output ?? "",
            exit_code: completed.exitCode,
          };
        })();
        return { cancel: () => { cancelled = true; running?.cancel(); }, result };
      },
    } : undefined);
    const capability: ReviewCapabilityV1 = { apiVersion: 1, store: store as unknown as WorkflowReviewStore };
    const taskCapability = createIssueTaskCapability({ apiVersion: 1, store, annotations: createReviewAnnotationsV1(store) });
    super(capability, { executor, ...(ai ? { ai } : {}), taskCapability });
  }
}

export function buildBatchPrompt(reviewPath: string, annotationIds: string[], maxParallel: number, _legacyCliPath?: string): string {
  return buildWorkflowBatchPrompt(reviewPath, annotationIds, maxParallel, buildIssueCoordinatorInstructions());
}

export { extractIssueDraftOutput, validateEnqueueInput };
export type { IssueDraftOutput };
