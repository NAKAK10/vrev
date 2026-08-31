import { atomicWriteJson, fileSha256, readJson, withFileLock } from "./file-utils.js";
import { legacyReviewFilePath, resolveTarget, resolvedReviewFilePath, reviewFilePath } from "./paths.js";
import { registerWorkspaceReview } from "./workspace-settings.js";
import {
  createReviewCapability as createPluginReviewCapability,
  REVIEW_CAPABILITY_API_VERSION,
  REVIEW_CAPABILITY_ID,
  REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID,
  type ReviewCapabilityV1,
} from "../plugins/review/server/review-capability.js";
import type { ReviewDomainDependencies, ReviewStoreOptions } from "../plugins/review/server/review-store.js";

/** Host primitives supplied to the isolated review plugin implementation. */
export const reviewDomainDependencies: ReviewDomainDependencies = Object.freeze({
  atomicWriteJson,
  fileSha256,
  readJson,
  withFileLock,
  legacyReviewFilePath,
  resolveTarget,
  resolvedReviewFilePath,
  reviewFilePath,
  registerWorkspaceReview,
});

export function createReviewCapability(target: string, options: ReviewStoreOptions = {}): ReviewCapabilityV1 {
  return createPluginReviewCapability(reviewDomainDependencies, target, options);
}

export {
  REVIEW_CAPABILITY_API_VERSION,
  REVIEW_CAPABILITY_ID,
  REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID,
};
export type { ReviewCapabilityV1 };
