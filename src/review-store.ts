import { reviewDomainDependencies } from "./review-capability.js";
import {
  createReviewDomain,
  sanitizeAnchor as pluginSanitizeAnchor,
  sanitizeLegacyAnchor as pluginSanitizeLegacyAnchor,
  type ReviewStoreOptions,
} from "../plugins/review/server/review-store.js";
import type { AnnotationKind } from "../plugins/review/server/review-types.js";

const reviewDomain = createReviewDomain(reviewDomainDependencies);

/** @deprecated Import ReviewCapabilityV1; retained as a compatibility façade. */
export class ReviewStore extends reviewDomain.ReviewStore {}

/** @deprecated Review validation is owned by the bundled review plugin. */
export function sanitizeAnchor(kind: AnnotationKind, value: unknown): Record<string, unknown> {
  return pluginSanitizeAnchor(kind, value);
}

/** @deprecated Review migration is owned by the bundled review plugin. */
export function sanitizeLegacyAnchor(kind: unknown, value: unknown): Record<string, unknown> {
  return pluginSanitizeLegacyAnchor(kind, value);
}

export type { ReviewStoreOptions };
