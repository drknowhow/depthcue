export { adviceOf, checkContent, hasPlaceholderAlt, placeholderAlt } from "./advice.ts";
export type {
  ApplyFailure,
  ApplyFailureCode,
  ApplyResult,
  ApplySuccess,
  BlockChanges,
  DeckChanges,
  NewScene,
  Op,
  SceneChanges,
} from "./apply.ts";
export { applyOps } from "./apply.ts";
export type { AssetRef } from "./assets.ts";
export { assetRefs, assetsOf } from "./assets.ts";
export type { BuildEntry, BuildTarget } from "./build.ts";
export { buildOf, placeInBuild, revealable, STEPS_MAX } from "./build.ts";
export type {
  Anchor,
  Comment,
  CommentAuthor,
  CommentContext,
  CommentFailure,
  CommentFailureCode,
  CommentOp,
  CommentResult,
  CommentSuccess,
  CommentsFile,
  Message,
  ReadComments,
} from "./comments.ts";
export {
  applyCommentOps,
  COMMENTS_FILE,
  commentsRevision,
  commentsToText,
  commentWarnings,
  emptyComments,
  isOrphan,
  isTask,
  openComments,
  orphansOf,
  readComments,
} from "./comments.ts";
export type { Cue, CueBuild, CueMap } from "./cues.ts";
export {
  CUE_MAP_FORMAT,
  checkCues,
  cueMapPath,
  isMarker,
  keepMarkers,
  MARKER_TYPE,
  MAX_CUE_ID,
  MAX_CUES,
  makeCue,
  newMarker,
  nextMarkerId,
  readCueMap,
  roundedSeconds,
  tidyCues,
} from "./cues.ts";
export type {
  BarChartBlock,
  Cell,
  ChartBlock,
  ChartKind,
  ColumnKind,
  TableBlock,
} from "./data.ts";
export { chartFromBarChart, checkData, columnKinds, replaceBlockOps } from "./data.ts";
export type { RawError } from "./diagnostics.ts";
export { explain } from "./diagnostics.ts";
export type { Doc, LoadResult } from "./doc.ts";
export { checkDoc, docToFiles, loadDoc, revisionOf, sceneRevision } from "./doc.ts";
export type { Autosave, AutosaveOptions, DraftStore, Recovery, Timers } from "./draft.ts";
export { attachAutosave, DRAFT_FORMAT, memoryDraftStore, recoverDraft, serializeDraft } from "./draft.ts";
export type { ExportData } from "./exported.ts";
export { EXPORT_FORMAT } from "./exported.ts";
export type { Frame } from "./frames.ts";
export { checkFrames, FRAME_MIN, frameOf, hasFrames, SAFE_MARGIN } from "./frames.ts";
export type { Flow, Span, TextOptions, Tone } from "./inline.ts";
export {
  escapeText,
  isLinkTarget,
  literalText,
  parseText,
  readsAsWritten,
  serializeText,
  visibleText,
} from "./inline.ts";
export type {
  CommandResult,
  Lease,
  LeaseAction,
  LeaseCommand,
  LeaseController,
  LeaseEvent,
  LeaseHost,
  LeaseOptions,
  LeaseScope,
  LeaseState,
  Rejection,
  RenewResult,
  RevokeReason,
  Standing,
} from "./lease.ts";
export {
  createLeaseController,
  LEASE_ACTIONS,
  LEASE_EXPIRE_MS,
  LEASE_RENEW_MS,
  LEASE_RUN_LIMIT_MS,
  REVOKE_TEXT,
} from "./lease.ts";
export { checkReferences } from "./references.ts";
export type {
  Accepted,
  Author,
  Change,
  ChangeKind,
  ChangeScope,
  Difference,
  ReadReview,
  Reverted,
  RevertPlan,
  Review,
  ReviewFailure,
} from "./review.ts";
export {
  acceptChanges,
  baselineOf,
  describeChange,
  diffDocs,
  foldEdit,
  REVIEW_FILE,
  REVIEW_FORMAT,
  readReview,
  recordAgentEdit,
  revertChanges,
  revertOps,
  reviewChanges,
  reviewRevision,
  reviewToText,
  startReview,
} from "./review.ts";
export {
  ASSET_PATTERN,
  CHART_KINDS,
  COLOR_PATTERN,
  COLUMN_KINDS,
  COMMENT_AUTHORS,
  COMMENT_LIMITS,
  COMMENT_OP_NAMES,
  COMMENTS_FORMAT,
  commentOpsSchema,
  commentsSchema,
  DATA_LIMITS,
  deckSchema,
  FONT_PAIRS,
  ID_PATTERN,
  LAYOUTS,
  LEADS,
  MODULE_SETTING_PATTERN,
  OP_NAMES,
  opsSchema,
  PALETTE_COLORS,
  SCHEMA_VERSION,
  SCHEMA_VERSIONS,
  sceneSchema,
  TEXT_ALIGNS,
  TEXT_LIMITS,
  TEXT_ROLES,
  TEXT_SIZES,
  TEXT_SOURCE_LIMITS,
  THEME_COLORS,
  THEMES,
  TONES,
} from "./schema.ts";
export type { ApplyOptions, Session, SessionEvent, SessionEventType } from "./session.ts";
export { createSession } from "./session.ts";
export type { Placed, Placement, Slot, SlotName } from "./slots.ts";
export { addBlock, placeBlock, slotOf, slotsOf } from "./slots.ts";
export type { DeckStyle, FontPair, PaletteColor, ThemeColor, ThemeName } from "./style.ts";
export {
  CONTRAST,
  checkPalette,
  checkTones,
  contrastRatio,
  DEFAULT_FONTS,
  isLargeText,
  luminance,
  PRESETS,
  styleOf,
} from "./style.ts";
export type { Block, BlockType, Deck, Diagnostic, Scene, Severity } from "./types.ts";
export type { DeckFiles } from "./validate.ts";
export { checkDeckFiles, checkManifest, checkScene, MANIFEST_FILE, scenePath } from "./validate.ts";
export type { SchemaVersion } from "./versions.ts";
export {
  blockNeeds,
  checkDeckVersion,
  checkSceneVersion,
  checkText,
  deckNeeds,
  readsMarkup,
  sceneNeeds,
  shownText,
  textFlow,
  upgradeScene,
  versionAtLeast,
} from "./versions.ts";
