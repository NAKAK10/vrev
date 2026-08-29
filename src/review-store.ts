import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { atomicWriteJson, fileSha256, readJson, withFileLock } from "./file-utils.js";
import {
  legacyReviewFilePath,
  resolveTarget,
  resolvedReviewFilePath,
  reviewFilePath,
  type ResolvedTarget,
} from "./paths.js";
import { registerWorkspaceReview } from "./workspace-settings.js";
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
const STATUSES = new Set(["open", "in_progress", "addressed", "resolved"]);
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
    if ("viewport_mode" in input) {
      if (!["desktop", "tablet", "mobile"].includes(String(input.viewport_mode))) throw new Error("anchor viewport_mode is invalid");
      cleaned.viewport_mode = input.viewport_mode as JsonValue;
    }
    if ("source_hint" in input) {
      const hint = record(input.source_hint, "anchor source_hint must be an object");
      cleaned.source_hint = Object.fromEntries(["framework", "component", "file"].filter((key) => typeof hint[key] === "string" && Boolean((hint[key] as string).trim())).map((key) => [key, cleanString(hint[key], `source_hint.${key}`)]));
    }
    if (!("selector" in cleaned) && !("xpath" in cleaned)) throw new Error("DOM anchor requires selector or xpath");
    return cleaned;
  }
  if (!("bounds" in input)) throw new Error("region anchor requires bounds");
  const bounds = numericObject(input.bounds, "bounds", RECT_FIELDS);
  if (!["x", "y", "width", "height"].every((key) => key in bounds)) throw new Error("region bounds require x, y, width, and height");
  const cleaned: UnknownRecord = { bounds };
  if ("space" in input) cleaned.space = cleanString(input.space, "space");
  if ("viewport_mode" in input) {
    if (!["desktop", "tablet", "mobile"].includes(String(input.viewport_mode))) throw new Error("anchor viewport_mode is invalid");
    cleaned.viewport_mode = input.viewport_mode as JsonValue;
  }
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
  if (kind === "dom" && typeof input.source_hint === "object" && input.source_hint !== null && !Array.isArray(input.source_hint)) {
    const hint = input.source_hint as UnknownRecord;
    candidate.source_hint = Object.fromEntries(["framework", "component", "file"].filter((key) => typeof hint[key] === "string" && Boolean((hint[key] as string).trim())).map((key) => [key, truncate((hint[key] as string).trim(), STRING_LIMIT)]));
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

export interface ReviewStoreOptions { projectRoot?: string; projectDirectory?: string }

export class ReviewStore {
  readonly target: ResolvedTarget;
  readonly path: string;
  readonly resolvedPath: string;
  readonly legacyPath: string;
  readonly transactionPath: string;

  constructor(target: string, options: ReviewStoreOptions = {}) {
    this.target = resolveTarget(target, options.projectRoot);
    this.path = reviewFilePath(this.target);
    this.resolvedPath = resolvedReviewFilePath(this.target);
    this.legacyPath = legacyReviewFilePath(this.target);
    this.transactionPath = path.join(path.dirname(this.path), ".transaction.json");
    for (const candidate of [this.legacyPath, this.transactionPath]) {
      if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) throw new Error("review storage files must not be symbolic links");
    }
    registerWorkspaceReview(this.target, options.projectDirectory ?? this.target.projectRoot, this.path, this.resolvedPath);
  }

  get entryPath(): string { return this.target.entryPath; }
  get targetPath(): string { return this.target.absolutePath; }

  sourceHash(pagePath = this.entryPath): string {
    if (this.target.liveUrl) {
      const page = new URL(pagePath, this.target.liveUrl);
      const origin = new URL(this.target.liveUrl).origin;
      if (page.origin !== origin) throw new Error("page URL is outside the active live origin");
      page.hash = "";
      return createHash("sha256").update(`live-url:${page.toString()}`, "utf8").digest("hex");
    }
    return fileSha256(resolveTarget(pagePath, this.target.projectRoot).absolutePath);
  }

  private newReview(): Review {
    const timestamp = now();
    return { schema_version: 2, review_id: randomUUID(), revision: 0, created_at: timestamp, updated_at: timestamp, target: { entry_path: this.entryPath, kind: this.target.kind, sha256: this.sourceHash() }, annotations: [], annotation_order: [], events: [] };
  }

  private parseReview(filePath: string): Review {
    const loaded = record(readJson(filePath), "review file must contain a JSON object");
    if (loaded.schema_version === 1) {
      if (Array.isArray(loaded.annotations)) for (const item of loaded.annotations) if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const annotation = item as UnknownRecord;
        annotation.anchor = sanitizeLegacyAnchor(annotation.kind, annotation.anchor);
      }
      loaded.schema_version = 2;
      loaded.migrated_at = now();
    }
    if (loaded.schema_version !== 2 || !Array.isArray(loaded.annotations) || !Array.isArray(loaded.events)) throw new Error("unsupported review schema version");
    return loaded as unknown as Review;
  }

  private splitReview(review: Review, resolved: boolean): Review {
    const annotations = review.annotations.filter(({ status }) => (status === "resolved") === resolved);
    const ids = new Set(annotations.map(({ id }) => id));
    return { ...structuredClone(review), annotations, annotation_order: review.annotations.map(({ id }) => id), events: review.events.filter(({ annotation_id }) => ids.has(annotation_id)) };
  }

  private writeSplitFiles(review: Review): void {
    atomicWriteJson(this.path, this.splitReview(review, false));
    atomicWriteJson(this.resolvedPath, this.splitReview(review, true));
  }

  private writeUnlocked(review: Review): void {
    atomicWriteJson(this.transactionPath, review);
    this.writeSplitFiles(review);
    unlinkSync(this.transactionPath);
  }

  private loadUnlocked(): Review {
    if (existsSync(this.transactionPath)) {
      const pending = this.parseReview(this.transactionPath);
      this.writeSplitFiles(pending);
      unlinkSync(this.transactionPath);
      return pending;
    }
    if (!existsSync(this.path)) {
      if (existsSync(this.legacyPath)) {
        const migrated = this.parseReview(this.legacyPath);
        this.writeUnlocked(migrated);
        unlinkSync(this.legacyPath);
        return migrated;
      }
      const review = this.newReview();
      this.writeUnlocked(review);
      return review;
    }
    const active = this.parseReview(this.path);
    const resolved = existsSync(this.resolvedPath) ? this.parseReview(this.resolvedPath) : this.splitReview(active, true);
    const combinedAnnotations = [...active.annotations.filter(({ status }) => status !== "resolved"), ...resolved.annotations.filter(({ status }) => status === "resolved")];
    const order = active.annotation_order ?? (active.annotations.some(({ status }) => status === "resolved") ? active.annotations.map(({ id }) => id) : resolved.annotation_order) ?? combinedAnnotations.map(({ id }) => id);
    const orderIndex = new Map(order.map((id, index) => [id, index]));
    const eventIds = new Set<string>();
    const merged: Review = {
      ...active,
      revision: Math.max(active.revision, resolved.revision),
      updated_at: active.updated_at >= resolved.updated_at ? active.updated_at : resolved.updated_at,
      annotations: combinedAnnotations.sort((left, right) => (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER)),
      annotation_order: order,
      events: [...active.events, ...resolved.events].filter(({ id }) => !eventIds.has(id) && Boolean(eventIds.add(id))).sort((left, right) => left.revision - right.revision),
    };
    if (!existsSync(this.resolvedPath) || active.annotations.some(({ status }) => status === "resolved")) this.writeUnlocked(merged);
    return merged;
  }

  load(): Review { return withFileLock(this.path, () => this.loadUnlocked()); }

  private pagePath(value: unknown): { entryPath: string; absolutePath: string } {
    const pagePath = nonblank(value, "page_path");
    if (this.target.liveUrl) {
      const resolved = resolveTarget(new URL(pagePath, this.target.liveUrl).toString(), this.target.projectRoot);
      if (!resolved.liveUrl || new URL(resolved.liveUrl).origin !== new URL(this.target.liveUrl).origin) {
        throw new Error("page URL is outside the active live origin");
      }
      return { entryPath: resolved.entryPath, absolutePath: resolved.absolutePath };
    }
    const resolved = resolveTarget(pagePath, this.target.projectRoot);
    if (this.target.kind === "image") {
      if (resolved.absolutePath !== this.targetPath) throw new Error("page_path is outside the active image session");
    } else if (resolved.kind !== "html") {
      throw new Error("HTML session page_path must be HTML or HTM");
    }
    return { entryPath: resolved.entryPath, absolutePath: resolved.absolutePath };
  }

  private normalizeSourceHint(anchor: UnknownRecord): void {
    const hint = anchor.source_hint;
    if (typeof hint !== "object" || hint === null || Array.isArray(hint)) return;
    const sourceHint = hint as UnknownRecord;
    const file = sourceHint.file;
    if (typeof file !== "string" || !file.trim()) return;
    const normalized = file.replace(/^file:\/\//, "").replaceAll("\\", "/");
    if (normalized.startsWith(`${this.target.projectRoot.replaceAll("\\", "/")}/`)) {
      sourceHint.file = normalized.slice(this.target.projectRoot.length + 1);
      return;
    }
    const sourcePath = /(?:^|\/)((?:src|app|pages|components|packages|wp-content)\/.*)$/.exec(normalized)?.[1];
    if (sourcePath) sourceHint.file = sourcePath;
    else if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) delete sourceHint.file;
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
    this.normalizeSourceHint(anchor);
    const page = this.pagePath(payload.page_path);
    const annotationActor = actor(payload.actor ?? "human");
    if (!SOURCE_HASH.test(payload.source_hash)) throw new Error("source_hash must be a 64-character lowercase hex digest");
    return withFileLock(this.path, () => {
      const review = this.loadUnlocked();
      if (this.sourceHash(page.entryPath) !== payload.source_hash) throw new Error("source_hash does not match the current page");
      const timestamp = now();
      const annotationId = randomUUID();
      const message = { id: randomUUID(), body: comment, actor: annotationActor, at: timestamp };
      const annotation = { id: annotationId, kind: payload.kind, page_path: page.entryPath, comment, anchor, actor: annotationActor, status: "open" as const, source_hash: payload.source_hash, created_at: timestamp, updated_at: timestamp, thread: [message] };
      review.annotations.push(annotation);
      this.addEvent(review, "annotation_created", annotationId, annotationActor, timestamp, { kind: payload.kind, page_path: page.entryPath });
      this.writeUnlocked(review);
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
      this.writeUnlocked(review);
      return review;
    });
  }

  setStatus(annotationId: string, payload: SetStatusInput): Review {
    if (!STATUSES.has(payload.status)) throw new Error("status must be open, in_progress, addressed, or resolved");
    const statusActor = actor(payload.actor ?? "human");
    return withFileLock(this.path, () => {
      const review = this.loadUnlocked();
      const annotation = this.findAnnotation(review, annotationId);
      const previous = annotation.status;
      if (previous === payload.status) return review;
      const allowed = (statusActor === "ai" && previous === "open" && (payload.status === "in_progress" || payload.status === "addressed"))
        || (statusActor === "ai" && previous === "in_progress" && (payload.status === "addressed" || payload.status === "open"))
        || (statusActor === "human" && previous === "in_progress" && payload.status === "open")
        || (statusActor === "human" && previous === "addressed" && (payload.status === "resolved" || payload.status === "open"))
        || (statusActor === "human" && previous === "resolved" && payload.status === "open");
      if (!allowed) throw new Error(`invalid ${statusActor} status transition: ${previous} -> ${payload.status}`);
      const timestamp = now();
      annotation.status = payload.status;
      annotation.updated_at = timestamp;
      this.addEvent(review, "status_changed", annotationId, statusActor, timestamp, { from: previous, to: payload.status });
      this.writeUnlocked(review);
      return review;
    });
  }
}
