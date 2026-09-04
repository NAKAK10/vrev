import type { AiCapabilityV1 } from "../packages/plugin-sdk/index.js";
import { createAnnotationWorkflowBridgeAdapter } from "../plugins/annotation-workflow/server/index.js";
import type { JobManager } from "../plugins/annotation-workflow/server/job-manager.js";
import type { ReviewCapabilityV1 as WorkflowReviewCapabilityV1 } from "../plugins/annotation-workflow/server/workflow-types.js";
import {
  createIssueBridgeAdapter,
  type IssueReviewCapabilityV1,
  type IssueTaskCapabilityV1,
} from "../plugins/github-issue/server/index.js";
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
  stop?(): void | Promise<void>;
}

/** One-beta security policy for AI-capable bundled bridge adapters. */
export function isBundledAiBridgeOperation(pluginId: string, operation: string): boolean {
  return (pluginId === "annotation-workflow" && operation.startsWith("jobs."))
    || (pluginId === "github-issue" && operation.startsWith("issue."))
    || pluginId === "ai";
}

export interface BundledBridgeCatalogOptions {
  review: ReviewCapabilityV1;
  workflowManager: JobManager;
  ai: AiCapabilityV1;
  issueTask: IssueTaskCapabilityV1;
  allowScripts: boolean;
  aiJobsEnabled: boolean;
  pluginManagementVisible: boolean;
}

/** The sole Core location allowed to bind bundled plugin IDs to implementations. */
export function createBundledBridgeCatalog(options: BundledBridgeCatalogOptions): ReadonlyMap<string, BundledBridgeAdapter> {
  const review = options.review;
  return new Map<string, BundledBridgeAdapter>([
    ["review", createReviewBridgeAdapter(review, options)],
    ["annotation-workflow", createAnnotationWorkflowBridgeAdapter(review as unknown as WorkflowReviewCapabilityV1, options.workflowManager, options.ai)],
    ["github-issue", createIssueBridgeAdapter({
      review: review as unknown as IssueReviewCapabilityV1,
      issueTask: options.issueTask,
      ai: options.ai,
      projectRoot: review.store.target.projectRoot,
      draftsEnabled: options.aiJobsEnabled,
    }) as BundledBridgeAdapter],
    ["page-map", createPageMapBridgeAdapter(review.store.target) as BundledBridgeAdapter],
  ]);
}
