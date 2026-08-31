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
