/** @deprecated Review-domain contracts are owned by the bundled review plugin. */
export type {
  Actor,
  AddMessageInput,
  Anchor,
  Annotation,
  AnnotationKind,
  AnnotationStatus,
  CreateAnnotationInput,
  Dimensions,
  DomAnchor,
  JsonValue,
  NumericBox,
  RegionAnchor,
  Review,
  ReviewEvent,
  ReviewMessage,
  SetStatusInput,
  TargetKind,
} from "../plugins/review/server/review-types.js";

/** @deprecated Annotation workflow contracts are owned by the bundled plugin. */
export type {
  EnqueueJobsInput,
  ReviewCli,
  ReviewJob,
  ReviewJobBatch,
  ReviewJobState,
  ReviewJobStatus,
} from "../plugins/annotation-workflow/server/workflow-types.js";
