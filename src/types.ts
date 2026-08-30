export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Actor = "human" | "ai";
export type AnnotationKind = "dom" | "region";
export type AnnotationStatus = "open" | "in_progress" | "failed" | "addressed" | "resolved";
export type TargetKind = "html" | "image";

export interface NumericBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface Dimensions {
  width?: number;
  height?: number;
}

export interface DomAnchor {
  selector?: string;
  xpath?: string;
  tag?: string;
  text_excerpt?: string;
  attributes?: Record<string, string>;
  rect?: NumericBox;
  document?: Dimensions;
  viewport?: Dimensions;
  viewport_mode?: "desktop" | "tablet" | "mobile";
  source_hint?: {
    framework?: string;
    component?: string;
    file?: string;
  };
}

export interface RegionAnchor {
  bounds: NumericBox & Required<Pick<NumericBox, "x" | "y" | "width" | "height">>;
  space?: string;
  document?: Dimensions;
  viewport?: Dimensions;
  viewport_mode?: "desktop" | "tablet" | "mobile";
  natural?: Dimensions;
  nearest?: Pick<DomAnchor, "selector" | "xpath" | "tag">;
}

export type Anchor = DomAnchor | RegionAnchor;

export interface ReviewMessage {
  id: string;
  body: string;
  actor: Actor;
  at: string;
}

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  page_path: string;
  comment: string;
  anchor: Anchor | Record<string, never>;
  actor: Actor;
  status: AnnotationStatus;
  source_hash: string;
  created_at: string;
  updated_at: string;
  thread: ReviewMessage[];
  issue_url?: string;
  issue_title?: string;
  issue_body?: string;
  issue_state?: "requested" | "ready" | "failed" | "created";
}

export interface ReviewEvent {
  revision: number;
  id: string;
  type: "annotation_created" | "message_added" | "status_changed";
  annotation_id: string;
  actor: Actor;
  at: string;
  details: Record<string, JsonValue>;
}

export interface Review {
  schema_version: 2;
  review_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  migrated_at?: string;
  target: {
    entry_path: string;
    kind: TargetKind;
    sha256: string;
  };
  annotations: Annotation[];
  annotation_order?: string[];
  events: ReviewEvent[];
}

export interface CreateAnnotationInput {
  kind: AnnotationKind;
  page_path: string;
  comment: string;
  anchor: unknown;
  source_hash: string;
  actor?: Actor;
}

export interface AddMessageInput {
  body: string;
  actor?: Actor;
}

export interface SetStatusInput {
  status: AnnotationStatus;
  actor?: Actor;
}

export type ReviewCli = "opencode" | "claude" | "codex" | "copilot" | "pi" | "custom";

export type ReviewJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export interface ReviewJob {
  id: string;
  batch_id: string;
  annotation_id: string;
  page_path: string;
  source_hash: string;
  cli: ReviewCli;
  custom_name: string | null;
  session_id: string | null;
  state: ReviewJobStatus;
  created: string;
  started: string | null;
  finished: string | null;
  exit_code: number | null;
  summary: string;
}

export interface ReviewJobBatch {
  id: string;
  max_parallel: number;
  opencode_attach: string | null;
  custom_command: string | null;
}

export interface ReviewJobState {
  revision: number;
  batches: ReviewJobBatch[];
  jobs: ReviewJob[];
}

export interface EnqueueJobsInput {
  cli: ReviewCli;
  max_parallel: number;
  session_id?: string | null;
  opencode_attach?: string | null;
  custom_name?: string | null;
  custom_command?: string | null;
}
