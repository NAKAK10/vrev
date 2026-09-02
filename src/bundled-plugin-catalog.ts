import { createAnnotationWorkflowBridgeAdapter } from "../plugins/annotation-workflow/server/index.js";
import type { JobManager } from "../plugins/annotation-workflow/server/job-manager.js";
import type { ReviewCapabilityV1 as WorkflowReviewCapabilityV1, RunnerRegistryV1 } from "../plugins/annotation-workflow/server/workflow-types.js";
import { createCustomCommandBridgeAdapter, parseCommandTemplate, type CustomCommandProviderV1 } from "../plugins/custom-command/index.js";
import { createIssueBridgeAdapter, type IssueReviewCapabilityV1, type IssueTaskCapabilityV1 } from "../plugins/github-issue/server/index.js";
import { createPageMapBridgeAdapter } from "../plugins/page-map/server/index.js";
import { createReviewBridgeAdapter, type ReviewCapabilityV1 } from "../plugins/review/server/review-capability.js";

export interface BundledBridgeRequest {
  request_id: string;
  expected_revision?: unknown;
  input: Record<string, unknown>;
}

export type BundledBridgeResult =
  | { ok: true; revision?: string; data: unknown; effects?: unknown[] }
  | { ok: false; revision?: string; error: { code: string; message: string; retryable: boolean; request_id: string; fields?: Record<string, string> } };

export interface BundledBridgeAdapter {
  query(name: string, request: BundledBridgeRequest): Promise<BundledBridgeResult>;
  command(name: string, request: BundledBridgeRequest): Promise<BundledBridgeResult>;
}

export interface BundledBridgeCatalogOptions {
  review: ReviewCapabilityV1;
  workflowManager: JobManager;
  customCommands: CustomCommandProviderV1 | (() => Promise<CustomCommandProviderV1>);
  issueTask: IssueTaskCapabilityV1;
  allowScripts: boolean;
  aiJobsEnabled: boolean;
  pluginManagementVisible: boolean;
}

/** The sole Core location allowed to bind bundled plugin IDs to implementations. */
export function createBundledBridgeCatalog(options: BundledBridgeCatalogOptions): ReadonlyMap<string, BundledBridgeAdapter> {
  const review = options.review;
  const loadCustomCommands = async (): Promise<CustomCommandProviderV1> => typeof options.customCommands === "function" ? options.customCommands() : options.customCommands;
  const runnerRegistry: RunnerRegistryV1 = {
    async list() {
      try {
        return (await loadCustomCommands()).list(review.store.target.projectRoot)
          .map(({ runner_id, name, verified }) => ({ runner_id, name, provider_id: "custom-command", verified }));
      } catch {
        return [];
      }
    },
    async resolve(runnerId, context) {
      const resolved = (await loadCustomCommands()).resolve(context.workspaceRoot, runnerId);
      const parsed = parseCommandTemplate(resolved.template, context.prompt);
      return { ...parsed, cwd: context.workspaceRoot, env: { ...process.env } };
    },
  };
  return new Map<string, BundledBridgeAdapter>([
    ["review", createReviewBridgeAdapter(review, options)],
    ["annotation-workflow", createAnnotationWorkflowBridgeAdapter(review as unknown as WorkflowReviewCapabilityV1, options.workflowManager, runnerRegistry)],
    ["custom-command", createCustomCommandBridgeAdapter(review.store.target.projectRoot, options.customCommands) as BundledBridgeAdapter],
    ["github-issue", createIssueBridgeAdapter(review as unknown as IssueReviewCapabilityV1, options.issueTask) as BundledBridgeAdapter],
    ["page-map", createPageMapBridgeAdapter(review.store.target) as BundledBridgeAdapter],
  ]);
}
