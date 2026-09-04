import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { WorkflowReviewContext, WorkflowReviewDocument, WorkflowReviewStore } from "./workflow-types.js";

export interface WorkflowRuntimeSnapshot {
  readonly directory: string;
  readonly reviewPath: string;
  readonly contextPath: string;
  cleanup(): Promise<void>;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeContext(value: WorkflowReviewContext | undefined): WorkflowReviewContext {
  if (!value) return { schema_version: 1, discovery_status: "pending", primary_project: ".", related_scopes: [] };
  if (value.schema_version !== 1 || !["pending", "completed"].includes(value.discovery_status)
    || typeof value.primary_project !== "string" || !Array.isArray(value.related_scopes)
    || value.related_scopes.some((scope) => typeof scope !== "string")) {
    throw new Error("authoritative review context has an invalid schema");
  }
  // Project discovery is the only context exposed to an AI process. Unknown fields (including
  // provider configuration or credentials) are deliberately not copied into the snapshot.
  return {
    schema_version: 1,
    discovery_status: value.discovery_status,
    primary_project: value.primary_project,
    related_scopes: [...value.related_scopes],
  };
}

function projectReview(review: WorkflowReviewDocument, annotationIds: readonly string[]): WorkflowReviewDocument {
  const allowed = new Set(annotationIds);
  const projected = structuredClone(review) as WorkflowReviewDocument & { annotation_order?: unknown; events?: unknown };
  projected.annotations = projected.annotations.filter(({ id }) => allowed.has(id));
  if (Array.isArray(projected.annotation_order)) projected.annotation_order = projected.annotation_order.filter((id) => typeof id === "string" && allowed.has(id));
  if (Array.isArray(projected.events)) projected.events = projected.events.filter((event) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
    return typeof (event as { annotation_id?: unknown }).annotation_id === "string" && allowed.has((event as { annotation_id: string }).annotation_id);
  });
  return projected;
}

/** Materializes only the claimed capability data for one coordinator run without assuming local review files exist. */
export async function createWorkflowRuntimeSnapshot(
  store: WorkflowReviewStore,
  annotationIds: readonly string[],
  activeReview?: WorkflowReviewDocument,
): Promise<WorkflowRuntimeSnapshot> {
  if (annotationIds.length === 0) throw new Error("runtime snapshot requires at least one annotation");
  const [loadedReview, context] = await Promise.all([
    activeReview ? Promise.resolve(activeReview) : store.loadActive(),
    store.loadContext?.() ?? Promise.resolve(undefined),
  ]);
  const review = projectReview(loadedReview, annotationIds);
  if (review.annotations.length !== new Set(annotationIds).size) throw new Error("runtime snapshot is missing a claimed annotation");
  const directory = await mkdtemp(path.join(os.tmpdir(), "vrev-workflow-"));
  if (isInside(store.target.projectRoot, directory)) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("runtime snapshot directory must be outside the workspace");
  }
  const reviewPath = path.join(directory, "review.json");
  const contextPath = path.join(directory, "context.json");
  try {
    await Promise.all([
      writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }),
      writeFile(contextPath, `${JSON.stringify(safeContext(context), null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }),
    ]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let cleanupPromise: Promise<void> | undefined;
  return Object.freeze({
    directory,
    reviewPath,
    contextPath,
    cleanup(): Promise<void> {
      cleanupPromise ??= rm(directory, { recursive: true, force: true });
      return cleanupPromise;
    },
  });
}
