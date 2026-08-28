import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { atomicWriteJson, fileSha256, readJson, withFileLock } from "./file-utils.js";
import {
  resolveTarget,
  reviewFilePath,
  type ResolvedTarget,
} from "./paths.js";
import type {
  Actor,
  AddMessageInput,
  Annotation,
  AnnotationKind,
  CreateAnnotationInput,
  JsonValue,
  Review,
  SetStatusInput,
} from "./types.js";

const ACTORS = new Set(["human", "ai"]);
const STATUSES = new Set(["open", "addressed", "resolved"]);
const ATTRIBUTE_NAMES = new Set([
  "id", "class", "role", "aria-label", "data-testid", "data-test", "data-qa",
  "data-cy", "data-id",
]);
const RECT_FIELDS = new Set(["x", "y", "width", "height", "top", "right", "bottom", "left"]);
const DIMENSION_FIELDS = new Set(["width", "height"]);
const SOURCE_HASH = /^[0-9a-f]{64}$/;
const STRING_LIMIT = 1000;
const TEXT_LIMIT = 2000;

type UnknownRecord = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function record(value: unknown, message: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as UnknownRecord;
}

function truncate(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}

function cleanString(value: unknown, field: string, limit = STRING_LIMIT): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`anchor ${field} must be a nonblank string`);
  return truncate(value.trim(), limit);
}

function numericObject(value: unknown, field: string, allowed: Set<string>): Record<string, number> {
  const input = record(value, `anchor ${field} must be an object`);
  const cleaned: Record<string, number> = {};
  for (const key of allowed) {
    if (!(key in input)) continue;
    const number = input[key];
    if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`anchor ${field}.${key} must be finite numeric`);
    if ((key === "width" || key === "height") && number < 0) throw new Error(`anchor ${field}.${key} must be nonnegative`);
    cleaned[key] = number;
  }
  if (Object.keys(cleaned).length === 0) throw new Error(`anchor ${field} has no supported numeric fields`);
  return cleaned;
}

export function sanitizeAnchor(kind: AnnotationKind, value: unknown): UnknownRecord {
  const input = record(value, "anchor must be an object");
  if (kind === "dom") {
    const cleaned: UnknownRecord = {};
    for (const key of ["selector", "xpath", "tag"] as const) if (key in input) cleaned[key] = cleanString(input[key], key);
    if ("text_excerpt" in input) cleaned.text_excerpt = cleanString(input.text_excerpt, "text_excerpt", TEXT_LIMIT);
    if ("attributes" in input) {
      const attributes = record(input.attributes, "anchor attributes must be an object");
      cleaned.attributes = Object.fromEntries([...ATTRIBUTE_NAMES].filter((key) => key in attributes).map((key) => [key, cleanString(attributes[key], `attributes.${key}`)]));
    }
    for (const [key, fields] of [["rect", RECT_FIELDS], ["document", DIMENSION_FIELDS], ["viewport", DIMENSION_FIELDS]] as const) {
      if (key in input) cleaned[key] = numericObject(input[key], key, fields);
    }
    if (!("selector" in cleaned) && !("xpath" in cleaned)) throw new Error("DOM anchor requires selector or xpath");
    return cleaned;
  }
  if (!("bounds" in input)) throw new Error("region anchor requires bounds");
  const bounds = numericObject(input.bounds, "bounds", RECT_FIELDS);
  if (!["x", "y", "width", "height"].every((key) => key in bounds)) throw new Error("region bounds require x, y, width, and height");
  const cleaned: UnknownRecord = { bounds };
  if ("space" in input) cleaned.space = cleanString(input.space, "space");
  for (const [key, fields] of [["document", DIMENSION_FIELDS], ["viewport", DIMENSION_FIELDS], ["natural", DIMENSION_FIELDS]] as const) {
    if (key in input) cleaned[key] = numericObject(input[key], key, fields);
  }
  if ("nearest" in input) {
    const nearest = record(input.nearest, "anchor nearest must be an object");
    cleaned.nearest = Object.fromEntries(["selector", "xpath", "tag"].filter((key) => key in nearest).map((key) => [key, cleanString(nearest[key], `nearest.${key}`)]));
  }
  return cleaned;
}

export function sanitizeLegacyAnchor(kind: unknown, value: unknown): UnknownRecord {
  if ((kind !== "dom" && kind !== "region") || typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as UnknownRecord;
  const candidate: UnknownRecord = {};
  const strings = kind === "dom" ? ["selector", "xpath", "tag", "text_excerpt"] : ["space"];
  for (const key of strings) if (typeof input[key] === "string" && input[key].trim()) candidate[key] = truncate(input[key].trim(), key === "text_excerpt" ? TEXT_LIMIT : STRING_LIMIT);
  if (kind === "dom" && typeof input.attributes === "object" && input.attributes !== null && !Array.isArray(input.attributes)) {
    const attrs = input.attributes as UnknownRecord;
    candidate.attributes = Object.fromEntries([...ATTRIBUTE_NAMES].filter((key) => typeof attrs[key] === "string" && Boolean((attrs[key] as string).trim())).map((key) => [key, truncate((attrs[key] as string).trim(), STRING_LIMIT)]));
  }
  const numeric = kind === "dom" ? [["rect", RECT_FIELDS], ["document", DIMENSION_FIELDS], ["viewport", DIMENSION_FIELDS]] as const : [["bounds", RECT_FIELDS], ["document", DIMENSION_FIELDS], ["viewport", DIMENSION_FIELDS], ["natural", DIMENSION_FIELDS]] as const;
  for (const [key, fields] of numeric) try { candidate[key] = numericObject(input[key], key, fields); } catch { /* omit malformed legacy data */ }
  if (kind === "region" && typeof input.nearest === "object" && input.nearest !== null && !Array.isArray(input.nearest)) {
    const nearest = input.nearest as UnknownRecord;
    candidate.nearest = Object.fromEntries(["selector", "xpath", "tag"].filter((key) => typeof nearest[key] === "string" && Boolean((nearest[key] as string).trim())).map((key) => [key, truncate((nearest[key] as string).trim(), STRING_LIMIT)]));
  }
  try { return sanitizeAnchor(kind, candidate); } catch {
    if (kind === "dom" && ("selector" in candidate || "xpath" in candidate)) return Object.fromEntries(["selector", "xpath", "tag"].filter((key) => key in candidate).map((key) => [key, candidate[key]]));
    return {};
  }
}

function nonblank(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be nonblank`);
  return value.trim();
}

function actor(value: unknown): Actor {
  const result = nonblank(value, "actor");
  if (!ACTORS.has(result)) throw new Error("actor must be human or ai");
  return result as Actor;
}

export interface ReviewStoreOptions { projectRoot?: string }

export class ReviewStore {
  readonly target: ResolvedTarget;
  readonly path: string;

  constructor(target: string, options: ReviewStoreOptions = {}) {
    this.target = resolveTarget(target, options.projectRoot);
    this.path = reviewFilePath(this.target);
  }

  get entryPath(): string { return this.target.entryPath; }
  get targetPath(): string { return this.target.absolutePath; }

  private newReview(): Review {
    const timestamp = now();
    return { schema_version: 2, review_id: randomUUID(), revision: 0, created_at: timestamp, updated_at: timestamp, target: { entry_path: this.entryPath, kind: this.target.kind, sha256: fileSha256(this.targetPath) }, annotations: [], events: [] };
  }

  private loadUnlocked(): Review {
    if (!existsSync(this.path)) {
      const review = this.newReview();
      atomicWriteJson(this.path, review);
      return review;
    }
    const loaded = record(readJson(this.path), "review file must contain a JSON object");
    if (loaded.schema_version === 1) {
      if (Array.isArray(loaded.annotations)) for (const item of loaded.annotations) if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const annotation = item as UnknownRecord;
        annotation.anchor = sanitizeLegacyAnchor(annotation.kind, annotation.anchor);
      }
      loaded.schema_version = 2;
      loaded.migrated_at = now();
      atomicWriteJson(this.path, loaded);
    }
    if (loaded.schema_version !== 2) throw new Error("unsupported review schema version");
    return loaded as unknown as Review;
  }

  load(): Review { return withFileLock(this.path, () => this.loadUnlocked()); }

  private pagePath(value: unknown): { entryPath: string; absolutePath: string } {
    const pagePath = nonblank(value, "page_path");
    const resolved = resolveTarget(pagePath, this.target.projectRoot);
    if (this.target.kind === "image") {
      if (resolved.absolutePath !== this.targetPath) throw new Error("page_path is outside the active image session");
    } else if (resolved.kind !== "html") {
      throw new Error("HTML session page_path must be HTML or HTM");
    }
    return { entryPath: resolved.entryPath, absolutePath: resolved.absolutePath };
  }

  private findAnnotation(review: Review, annotationId: string): Annotation {
    const annotation = review.annotations.find(({ id }) => id === annotationId);
    if (!annotation) throw new Error(`annotation not found: ${annotationId}`);
    return annotation;
  }

  private addEvent(review: Review, type: Review["events"][number]["type"], annotationId: string, eventActor: Actor, at: string, details: Record<string, JsonValue>): void {
    review.revision += 1;
    review.updated_at = at;
    review.events.push({ revision: review.revision, id: randomUUID(), type, annotation_id: annotationId, actor: eventActor, at, details });
  }

  createAnnotation(payload: CreateAnnotationInput): Review {
    if (payload.kind !== "dom" && payload.kind !== "region") throw new Error("kind must be dom or region");
    const comment = nonblank(payload.comment, "comment");
    const anchor = sanitizeAnchor(payload.kind, payload.anchor);
    const page = this.pagePath(payload.page_path);
    const annotationActor = actor(payload.actor ?? "human");
    if (!SOURCE_HASH.test(payload.source_hash)) throw new Error("source_hash must be a 64-character lowercase hex digest");
    return withFileLock(this.path, () => {
      const review = this.loadUnlocked();
      if (fileSha256(page.absolutePath) !== payload.source_hash) throw new Error("source_hash does not match the current page");
      const timestamp = now();
      const annotationId = randomUUID();
      const message = { id: randomUUID(), body: comment, actor: annotationActor, at: timestamp };
      const annotation = { id: annotationId, kind: payload.kind, page_path: page.entryPath, comment, anchor, actor: annotationActor, status: "open" as const, source_hash: payload.source_hash, created_at: timestamp, updated_at: timestamp, thread: [message] };
      review.annotations.push(annotation);
      this.addEvent(review, "annotation_created", annotationId, annotationActor, timestamp, { kind: payload.kind, page_path: page.entryPath });
      atomicWriteJson(this.path, review);
      return review;
    });
  }

  addMessage(annotationId: string, payload: AddMessageInput): Review {
    const body = nonblank(payload.body, "body");
    const messageActor = actor(payload.actor ?? "human");
    return withFileLock(this.path, () => {
      const review = this.loadUnlocked();
      const annotation = this.findAnnotation(review, annotationId);
      const timestamp = now();
      const message = { id: randomUUID(), body, actor: messageActor, at: timestamp };
      annotation.thread.push(message);
      annotation.updated_at = timestamp;
      this.addEvent(review, "message_added", annotationId, messageActor, timestamp, { message_id: message.id });
      if (messageActor === "human" && (annotation.status === "addressed" || annotation.status === "resolved")) {
        const previous = annotation.status;
        annotation.status = "open";
        this.addEvent(review, "status_changed", annotationId, messageActor, timestamp, { from: previous, to: "open" });
      }
      atomicWriteJson(this.path, review);
      return review;
    });
  }

  setStatus(annotationId: string, payload: SetStatusInput): Review {
    if (!STATUSES.has(payload.status)) throw new Error("status must be open, addressed, or resolved");
    const statusActor = actor(payload.actor ?? "human");
    return withFileLock(this.path, () => {
      const review = this.loadUnlocked();
      const annotation = this.findAnnotation(review, annotationId);
      const previous = annotation.status;
      if (previous === payload.status) return review;
      const allowed = (statusActor === "ai" && previous === "open" && payload.status === "addressed") || (statusActor === "human" && previous === "addressed" && (payload.status === "resolved" || payload.status === "open")) || (statusActor === "human" && previous === "resolved" && payload.status === "open");
      if (!allowed) throw new Error(`invalid ${statusActor} status transition: ${previous} -> ${payload.status}`);
      const timestamp = now();
      annotation.status = payload.status;
      annotation.updated_at = timestamp;
      this.addEvent(review, "status_changed", annotationId, statusActor, timestamp, { from: previous, to: payload.status });
      atomicWriteJson(this.path, review);
      return review;
    });
  }
}
