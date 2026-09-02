import { parseCustomCommand, type CommandExecutor } from "../plugins/annotation-workflow/server/adapters.js";
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
import type { ReviewCapabilityV1, RunnerRegistryV1, WorkflowReviewStore } from "../plugins/annotation-workflow/server/workflow-types.js";
import type { ReviewStoreContract } from "../plugins/review/server/review-store.js";

/** @deprecated Construct workflow jobs through the annotation-workflow capability. */
export interface JobManagerOptions {
  executor?: CommandExecutor;
  customCommandResolver?: (runnerId: string) => { template: string } | Promise<{ template: string }>;
  runnerRegistry?: RunnerRegistryV1;
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
          const { command, args } = parseCustomCommand((await resolveTemplate(runnerId)).template, prompt);
          return { command, args, cwd: workspaceRoot, env: { ...process.env } };
        },
      };
    }
    const capability: ReviewCapabilityV1 = { apiVersion: 1, store: store as unknown as WorkflowReviewStore };
    const taskCapability = createIssueTaskCapability({ apiVersion: 1, store, annotations: createReviewAnnotationsV1(store) });
    super(capability, { executor: options.executor ?? createSpawnExecutor(), ...(runnerRegistry ? { runnerRegistry } : {}), taskCapability });
  }
}

export function buildBatchPrompt(reviewPath: string, annotationIds: string[], maxParallel: number, _legacyCliPath?: string): string {
  return buildWorkflowBatchPrompt(reviewPath, annotationIds, maxParallel, buildIssueCoordinatorInstructions());
}

export { extractIssueDraftOutput, validateEnqueueInput };
export type { IssueDraftOutput };
