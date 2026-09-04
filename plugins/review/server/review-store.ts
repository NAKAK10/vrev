import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type {
  Actor,
  AddMessageInput,
  Annotation,
  AnnotationKind,
  CreateAnnotationInput,
  JsonValue,
  Review,
  SetStatusInput,
} from "./review-types.js";

/** Logical review documents a storage implementation must persist; file paths never leak past this boundary. */
export type ReviewDocumentKind = "active" | "resolved" | "transaction" | "legacy" | "context";

/** Paths a host resolves for the review documents, handed to `createStorage` to build a `ReviewDocumentStorage`. */
export interface ReviewDocumentPaths {
  active: string;
  resolved: string;
  legacy: string;
  transaction: string;
  context: string;
}

export interface ReviewDocumentStorage {
  /** Remote authoritative stores may opt into short-lived read coalescing and last-known-good projections. */
  readonly cacheReads?: boolean;
  /** Returns `null` when the document does not exist. */
  read(kind: ReviewDocumentKind): Promise<unknown | null>;
  write(kind: ReviewDocumentKind, value: unknown): Promise<void>;
  remove(kind: ReviewDocumentKind): Promise<void>;
  /** Mutual exclusion for one review's document set. Local storage uses a file lock; a remote backend may implement this differently. */
  withLock<T>(action: () => Promise<T>): Promise<T>;
}

export interface ReviewDomainDependencies {
  fileSha256(filePath: string): string;
  createStorage(target: ResolvedTarget, paths: ReviewDocumentPaths): ReviewDocumentStorage;
  legacyReviewFilePath(target: ResolvedTarget): string;
  resolveTarget(target: string, projectRoot?: string): ResolvedTarget;
  resolvedReviewFilePath(target: ResolvedTarget): string;
  reviewFilePath(target: ResolvedTarget): string;
  registerWorkspaceReview(target: ResolvedTarget, projectDirectory: string, reviewPath: string, resolvedPath: string): void;
}

export interface ResolvedTarget {
  projectRoot: string;
  entryPath: string;
  absolutePath: string;
  kind: "html" | "image";
  liveUrl?: string;
  urlMode?: "loopback" | "private" | "public";
}

const ACTORS = new Set(["human", "ai"]);
const STATUSES = new Set(["open", "in_progress", "failed", "addressed", "resolved"]);
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

export interface ReviewContext {
  schema_version: 1;
  discovery_status: "pending" | "completed";
  primary_project: string;
  related_scopes: string[];
}

export interface ReviewStoreContract {
  readonly target: ResolvedTarget;
  readonly path: string;
  readonly resolvedPath: string;
  readonly legacyPath: string;
  readonly transactionPath: string;
  readonly entryPath: string;
  readonly targetPath: string;
  sourceHash(pagePath?: string): string;
  load(): Promise<Review>;
  loadActive(): Promise<Review>;
  /** Context from the same authoritative backend as the review documents. */
  loadContext(): Promise<ReviewContext>;
  createAnnotation(payload: CreateAnnotationInput, expectedRevision?: unknown): Promise<Review>;
  createIssueRequest(payload: CreateAnnotationInput): Promise<Review>;
  setIssueDraftReady(annotationId: string, title: string, body: string): Promise<Review>;
  failIssueDraft(annotationId: string, message: string): Promise<Review>;
  completeIssueDraft(annotationId: string, title: string, url: string): Promise<Review>;
  addMessage(annotationId: string, payload: AddMessageInput): Promise<Review>;
  setStatus(annotationId: string, payload: SetStatusInput): Promise<Review>;
}

export interface ReviewDomain {
  ReviewStore: new (target: string, options?: ReviewStoreOptions) => ReviewStoreContract;
  sanitizeAnchor: typeof sanitizeAnchor;
  sanitizeLegacyAnchor: typeof sanitizeLegacyAnchor;
}

export function createReviewDomain(dependencies: ReviewDomainDependencies): ReviewDomain {
  const {
    fileSha256,
    createStorage,
    legacyReviewFilePath,
    resolveTarget,
    resolvedReviewFilePath,
    reviewFilePath,
    registerWorkspaceReview,
  } = dependencies;

class ReviewStore {
  readonly target: ResolvedTarget;
  readonly path: string;
  readonly resolvedPath: string;
  readonly legacyPath: string;
  readonly transactionPath: string;
  private readonly storage: ReviewDocumentStorage;
  private pendingLoad: Promise<Review> | undefined;
  private lastSuccessfulLoad: { at: number; review: Review } | undefined;

  constructor(target: string, options: ReviewStoreOptions = {}) {
    this.target = resolveTarget(target, options.projectRoot);
    this.path = reviewFilePath(this.target);
    this.resolvedPath = resolvedReviewFilePath(this.target);
    this.legacyPath = legacyReviewFilePath(this.target);
    this.transactionPath = path.join(path.dirname(this.path), ".transaction.json");
    const contextPath = path.join(path.dirname(this.path), "context.json");
    this.storage = createStorage(this.target, { active: this.path, resolved: this.resolvedPath, legacy: this.legacyPath, transaction: this.transactionPath, context: contextPath });
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

  private parseDocument(value: unknown): Review {
    const loaded = record(value, "review file must contain a JSON object");
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

  private async writeSplitFiles(review: Review): Promise<void> {
    await Promise.all([
      this.storage.write("active", this.splitReview(review, false)),
      this.storage.write("resolved", this.splitReview(review, true)),
    ]);
  }

  private async writeUnlocked(review: Review): Promise<void> {
    this.lastSuccessfulLoad = undefined;
    await this.storage.write("transaction", review);
    await this.writeSplitFiles(review);
    await this.storage.remove("transaction");
  }

  private async loadUnlocked(): Promise<Review> {
    const [pendingValue, activeValue, resolvedValue] = await Promise.all([
      this.storage.read("transaction"),
      this.storage.read("active"),
      this.storage.read("resolved"),
    ]);
    if (pendingValue !== null) {
      const pending = this.parseDocument(pendingValue);
      await this.writeSplitFiles(pending);
      await this.storage.remove("transaction");
      return pending;
    }
    if (activeValue === null) {
      const legacyValue = await this.storage.read("legacy");
      if (legacyValue !== null) {
        const migrated = this.parseDocument(legacyValue);
        await this.writeUnlocked(migrated);
        await this.storage.remove("legacy");
        return migrated;
      }
      const review = this.newReview();
      await this.writeUnlocked(review);
      return review;
    }
    const active = this.parseDocument(activeValue);
    const resolved = resolvedValue !== null ? this.parseDocument(resolvedValue) : this.splitReview(active, true);
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
    if (resolvedValue === null || active.annotations.some(({ status }) => status === "resolved")) await this.writeUnlocked(merged);
    return merged;
  }

  load(): Promise<Review> {
    const cached = this.lastSuccessfulLoad;
    if (this.storage.cacheReads === true && cached && Date.now() - cached.at < 1_000) return Promise.resolve(structuredClone(cached.review));
    if (!this.pendingLoad) {
      const load = this.storage.withLock(() => this.loadUnlocked());
      this.pendingLoad = load;
      void load.then(
        (review) => { if (this.storage.cacheReads === true) this.lastSuccessfulLoad = { at: Date.now(), review: structuredClone(review) }; if (this.pendingLoad === load) this.pendingLoad = undefined; },
        () => { if (this.pendingLoad === load) this.pendingLoad = undefined; },
      );
    }
    const pending = this.pendingLoad;
    return pending.then((review) => structuredClone(review)).catch((error) => {
      if (this.storage.cacheReads === true && this.lastSuccessfulLoad) return structuredClone(this.lastSuccessfulLoad.review);
      throw error;
    });
  }

  loadActive(): Promise<Review> {
    return this.storage.withLock(async () => {
      const transactionValue = await this.storage.read("transaction");
      const activeValue = transactionValue === null ? await this.storage.read("active") : null;
      if (transactionValue !== null || activeValue === null) {
        return this.splitReview(await this.loadUnlocked(), false);
      }
      const active = this.parseDocument(activeValue);
      if (active.annotations.some(({ status }) => status === "resolved")) {
        return this.splitReview(await this.loadUnlocked(), false);
      }
      return this.splitReview(active, false);
    });
  }

  loadContext(): Promise<ReviewContext> {
    return this.storage.withLock(async () => {
      const value = await this.storage.read("context");
      if (value === null) {
        const created: ReviewContext = { schema_version: 1, discovery_status: "pending", primary_project: ".", related_scopes: [] };
        await this.storage.write("context", created);
        return created;
      }
      const loaded = record(value, "review context must contain a JSON object");
      if (loaded.schema_version !== 1 || (loaded.discovery_status !== "pending" && loaded.discovery_status !== "completed")
        || typeof loaded.primary_project !== "string" || !Array.isArray(loaded.related_scopes)
        || loaded.related_scopes.some((scope) => typeof scope !== "string")) {
        throw new Error("unsupported review context schema");
      }
      return {
        schema_version: 1,
        discovery_status: loaded.discovery_status,
        primary_project: loaded.primary_project,
        related_scopes: [...loaded.related_scopes] as string[],
      };
    });
  }

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

  private addEvent(review: Review, type: Review["events"][number]["type"], annotationId: string, eventActor: Actor, at: string, details: Record<string, JsonValue>, eventId = randomUUID()): void {
    if (review.events.some(({ id }) => id === eventId)) return;
    review.revision += 1;
    review.updated_at = at;
    review.events.push({ revision: review.revision, id: eventId, type, annotation_id: annotationId, actor: eventActor, at, details });
  }

  async createAnnotation(payload: CreateAnnotationInput, expectedRevision?: unknown): Promise<Review> {
    if (payload.kind !== "dom" && payload.kind !== "region") throw new Error("kind must be dom or region");
    const comment = nonblank(payload.comment, "comment");
    const anchor = sanitizeAnchor(payload.kind, payload.anchor);
    this.normalizeSourceHint(anchor);
    const page = this.pagePath(payload.page_path);
    const annotationActor = actor(payload.actor ?? "human");
    if (!SOURCE_HASH.test(payload.source_hash)) throw new Error("source_hash must be a 64-character lowercase hex digest");
    const timestamp = now();
    const annotationId = randomUUID();
    const message = { id: randomUUID(), body: comment, actor: annotationActor, at: timestamp };
    const eventId = randomUUID();
    return this.storage.withLock(async () => {
      const review = await this.loadUnlocked();
      if (review.annotations.some(({ id }) => id === annotationId)) return review;
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== review.revision && expectedRevision !== `review:${review.revision}`) throw new Error("review revision conflict");
      if (this.sourceHash(page.entryPath) !== payload.source_hash) throw new Error("source_hash does not match the current page");
      const annotation = { id: annotationId, kind: payload.kind, page_path: page.entryPath, comment, anchor, actor: annotationActor, status: "open" as const, source_hash: payload.source_hash, created_at: timestamp, updated_at: timestamp, thread: [message] };
      review.annotations.push(annotation);
      this.addEvent(review, "annotation_created", annotationId, annotationActor, timestamp, { kind: payload.kind, page_path: page.entryPath }, eventId);
      await this.writeUnlocked(review);
      return review;
    });
  }

  async createIssueRequest(payload: CreateAnnotationInput): Promise<Review> {
    if (payload.kind !== "dom" && payload.kind !== "region") throw new Error("kind must be dom or region");
    const comment = nonblank(payload.comment, "comment");
    const anchor = sanitizeAnchor(payload.kind, payload.anchor);
    this.normalizeSourceHint(anchor);
    const page = this.pagePath(payload.page_path);
    if (!SOURCE_HASH.test(payload.source_hash)) throw new Error("source_hash must be a 64-character lowercase hex digest");
    const timestamp = now();
    const annotationId = randomUUID();
    const messageId = randomUUID();
    const eventId = randomUUID();
    return this.storage.withLock(async () => {
      const review = await this.loadUnlocked();
      if (review.annotations.some(({ id }) => id === annotationId)) return review;
      if (this.sourceHash(page.entryPath) !== payload.source_hash) throw new Error("source_hash does not match the current page");
      const annotation: Annotation = {
        id: annotationId,
        kind: payload.kind,
        page_path: page.entryPath,
        comment,
        anchor,
        actor: "human",
        status: "open",
        source_hash: payload.source_hash,
        created_at: timestamp,
        updated_at: timestamp,
        thread: [{ id: messageId, body: comment, actor: "human", at: timestamp }],
        issue_state: "requested",
      };
      review.annotations.push(annotation);
      this.addEvent(review, "annotation_created", annotationId, "human", timestamp, { kind: payload.kind, page_path: page.entryPath }, eventId);
      await this.writeUnlocked(review);
      return review;
    });
  }

  async setIssueDraftReady(annotationId: string, title: string, body: string): Promise<Review> {
    const issueTitle = nonblank(title, "issue_title");
    const issueBody = nonblank(body, "issue_body");
    const timestamp = now();
    const messageId = randomUUID();
    const messageEventId = randomUUID();
    const statusEventId = randomUUID();
    return this.storage.withLock(async () => {
      const review = await this.loadUnlocked();
      const annotation = this.findAnnotation(review, annotationId);
      if (annotation.issue_state === "ready" && annotation.status === "addressed" && annotation.issue_title === issueTitle && annotation.issue_body === issueBody) return review;
      const internalReferences = [annotationId, ".vreview/", "Visual Review注釈", "Visual Review annotation"];
      if (internalReferences.some((reference) => issueTitle.includes(reference) || issueBody.includes(reference))) {
        throw new Error("Issue draft must be understandable without internal review references");
      }
      annotation.issue_state = "ready";
      annotation.issue_title = issueTitle;
      annotation.issue_body = issueBody;
      const previous = annotation.status;
      annotation.status = "addressed";
      annotation.updated_at = timestamp;
      const message = { id: messageId, body: "GitHub Issueのラフを作成しました。内容を確認してください。", actor: "ai" as const, at: timestamp };
      annotation.thread.push(message);
      this.addEvent(review, "message_added", annotationId, "ai", timestamp, { message_id: message.id }, messageEventId);
      if (previous !== "addressed") this.addEvent(review, "status_changed", annotationId, "ai", timestamp, { from: previous, to: "addressed" }, statusEventId);
      await this.writeUnlocked(review);
      return review;
    });
  }

  /**
   * A draft failure is an attestation, not a verified fact: the caller may race a later success (or
   * another failure) writing to the same annotation. Only apply it while the annotation is still
   * "requested" so a stale failure can never clobber a draft that has since become ready or created.
   */
  async failIssueDraft(annotationId: string, message: string): Promise<Review> {
    const failureMessage = nonblank(message, "message");
    const timestamp = now();
    const messageId = randomUUID();
    const messageEventId = randomUUID();
    const statusEventId = randomUUID();
    return this.storage.withLock(async () => {
      const review = await this.loadUnlocked();
      const annotation = this.findAnnotation(review, annotationId);
      if (annotation.issue_state !== "requested") return review;
      const previous = annotation.status;
      annotation.status = "failed";
      annotation.updated_at = timestamp;
      const failureNotice = { id: messageId, body: `GitHub Issueのラフ作成に失敗しました: ${failureMessage}`, actor: "ai" as const, at: timestamp };
      annotation.thread.push(failureNotice);
      this.addEvent(review, "message_added", annotationId, "ai", timestamp, { message_id: failureNotice.id }, messageEventId);
      if (previous !== "failed") this.addEvent(review, "status_changed", annotationId, "ai", timestamp, { from: previous, to: "failed" }, statusEventId);
      await this.writeUnlocked(review);
      return review;
    });
  }

  async completeIssueDraft(annotationId: string, title: string, url: string): Promise<Review> {
    const issueTitle = nonblank(title, "issue_title");
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(url)) throw new Error("issue_url must be a GitHub Issue URL");
    return this.storage.withLock(async () => {
      const review = await this.loadUnlocked();
      const annotation = this.findAnnotation(review, annotationId);
      if (annotation.issue_state === "created") {
        if (annotation.issue_url === url) return review;
        throw new Error("Issue draft was already created with a different URL");
      }
      if (annotation.issue_state !== "ready" || annotation.status !== "addressed") {
        throw new Error("Issue draft is not ready for creation");
      }
      const timestamp = now();
      annotation.issue_state = "created";
      annotation.issue_title = issueTitle;
      annotation.issue_url = url;
      const previous = annotation.status;
      annotation.status = "resolved";
      this.addEvent(review, "status_changed", annotationId, "human", timestamp, { from: previous, to: "resolved", issue_url: url });
      await this.writeUnlocked(review);
      return review;
    });
  }

  async addMessage(annotationId: string, payload: AddMessageInput): Promise<Review> {
    const body = nonblank(payload.body, "body");
    const messageActor = actor(payload.actor ?? "human");
    const timestamp = now();
    const message = { id: randomUUID(), body, actor: messageActor, at: timestamp };
    const messageEventId = randomUUID();
    const statusEventId = randomUUID();
    return this.storage.withLock(async () => {
      const review = await this.loadUnlocked();
      const annotation = this.findAnnotation(review, annotationId);
      if (annotation.thread.some(({ id }) => id === message.id)) return review;
      annotation.thread.push(message);
      annotation.updated_at = timestamp;
      this.addEvent(review, "message_added", annotationId, messageActor, timestamp, { message_id: message.id }, messageEventId);
      if (messageActor === "human" && (annotation.status === "failed" || annotation.status === "addressed" || annotation.status === "resolved")) {
        const previous = annotation.status;
        annotation.status = "open";
        this.addEvent(review, "status_changed", annotationId, messageActor, timestamp, { from: previous, to: "open" }, statusEventId);
      }
      await this.writeUnlocked(review);
      return review;
    });
  }

  async setStatus(annotationId: string, payload: SetStatusInput): Promise<Review> {
    if (!STATUSES.has(payload.status)) throw new Error("status must be open, in_progress, failed, addressed, or resolved");
    const statusActor = actor(payload.actor ?? "human");
    return this.storage.withLock(async () => {
      const review = await this.loadUnlocked();
      const annotation = this.findAnnotation(review, annotationId);
      const previous = annotation.status;
      if (previous === payload.status) return review;
      const allowed = (statusActor === "ai" && previous === "open" && (payload.status === "in_progress" || payload.status === "failed" || payload.status === "addressed"))
        || (statusActor === "ai" && previous === "in_progress" && (payload.status === "failed" || payload.status === "addressed" || payload.status === "open"))
        || (statusActor === "ai" && previous === "failed" && payload.status === "addressed")
        || (statusActor === "ai" && previous === "addressed" && payload.status === "failed")
        || (statusActor === "human" && previous === "open" && payload.status === "resolved")
        || (statusActor === "human" && previous === "in_progress" && (payload.status === "open" || payload.status === "resolved"))
        || (statusActor === "human" && previous === "failed" && (payload.status === "open" || payload.status === "resolved"))
        || (statusActor === "human" && previous === "addressed" && (payload.status === "resolved" || payload.status === "open"))
        || (statusActor === "human" && previous === "resolved" && payload.status === "open");
      if (!allowed) throw new Error(`invalid ${statusActor} status transition: ${previous} -> ${payload.status}`);
      const timestamp = now();
      annotation.status = payload.status;
      annotation.updated_at = timestamp;
      if (payload.status === "addressed") annotation.source_hash = this.sourceHash(annotation.page_path);
      this.addEvent(review, "status_changed", annotationId, statusActor, timestamp, { from: previous, to: payload.status });
      await this.writeUnlocked(review);
      return review;
    });
  }
}


  return Object.freeze({ ReviewStore, sanitizeAnchor, sanitizeLegacyAnchor });
}

export type ReviewStoreInstance = ReviewStoreContract;
