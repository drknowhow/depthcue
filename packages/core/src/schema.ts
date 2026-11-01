/**
 * JSON Schema source of truth for a deck folder (draft-07 keywords only).
 * `pnpm schema` writes the published .schema.json files and the compiled validators from these objects.
 */
/** Versions a file may declare. 0.2 adds the optional block `frame`; a 0.1 file is read as it is. */
export const SCHEMA_VERSIONS = ["0.1", "0.2"] as const;
/** The version the tool writes into a new scene. */
export const SCHEMA_VERSION = "0.2" as const;

export const ID_PATTERN = "^[a-z][a-z0-9-]{1,63}$";
export const ASSET_PATTERN = "^assets/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*$";
export const LANGUAGE_PATTERN = "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$";
export const URL_PATTERN = "^https?://[^\\s]+$";
/** What a deck says about a module: `off`, or the version it needs, such as `1` or `1.2`. */
export const MODULE_SETTING_PATTERN = "^(off|[0-9]{1,4}(\\.[0-9]{1,4}){0,2})$";

export const LAYOUTS = ["title", "claim-evidence", "text-media"] as const;
export const THEMES = ["paper", "ink"] as const;
export const LEADS = ["human", "agent", "shared"] as const;
export const TEXT_ROLES = ["heading", "body", "caption", "quote"] as const;

/** Character limits per text role; the renderer measures real boxes, these keep the source honest. */
export const TEXT_LIMITS = { heading: 90, body: 600, caption: 160, quote: 300 } as const;

const id = { type: "string", pattern: ID_PATTERN } as const;
const idList = { type: "array", items: id, uniqueItems: true, maxItems: 32 } as const;

/** The smallest a frame may be, in percent of the slide's width or height. */
export const FRAME_MIN = 5;
const percent = { type: "number", minimum: 0, maximum: 100 } as const;
const extent = { type: "number", minimum: FRAME_MIN, maximum: 100 } as const;
/**
 * Where a pinned block sits: its left, top, width and height in percent of a 16 by 9 slide. That the box stays
 * on the slide (x + w and y + h at most 100) is a sum, which a schema cannot state; `checkFrames` does.
 */
const frame = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y", "w", "h"],
  properties: { x: percent, y: percent, w: extent, h: extent },
} as const;
const assetPath = { type: "string", pattern: ASSET_PATTERN, maxLength: 200 } as const;
const schemaVersion = { enum: SCHEMA_VERSIONS } as const;
const schemaRef = { type: "string", maxLength: 300 } as const;

const textBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "role", "text"],
  properties: {
    id,
    type: { const: "text" },
    role: { enum: TEXT_ROLES },
    text: { type: "string", minLength: 1, maxLength: TEXT_LIMITS.body },
    sourceIds: idList,
    frame,
  },
  allOf: [
    {
      if: { properties: { role: { const: "heading" } }, required: ["role"] },
      then: { properties: { text: { type: "string", maxLength: TEXT_LIMITS.heading } } },
    },
    {
      if: { properties: { role: { const: "caption" } }, required: ["role"] },
      then: { properties: { text: { type: "string", maxLength: TEXT_LIMITS.caption } } },
    },
    {
      if: { properties: { role: { const: "quote" } }, required: ["role"] },
      then: { properties: { text: { type: "string", maxLength: TEXT_LIMITS.quote } } },
    },
  ],
} as const;

const imageBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "asset", "alt"],
  properties: {
    id,
    type: { const: "image" },
    asset: assetPath,
    alt: { type: "string", minLength: 1, maxLength: 250 },
    caption: { type: "string", minLength: 1, maxLength: TEXT_LIMITS.caption },
    sourceIds: idList,
    frame,
  },
} as const;

const barChartBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "data"],
  properties: {
    id,
    type: { const: "bar-chart" },
    title: { type: "string", minLength: 1, maxLength: 120 },
    unit: { type: "string", minLength: 1, maxLength: 16 },
    data: {
      type: "array",
      minItems: 1,
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 40 },
          value: { type: "number" },
        },
      },
    },
    sourceIds: idList,
    frame,
  },
} as const;

const clipBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "source", "alt"],
  properties: {
    id,
    type: { const: "clip" },
    source: assetPath,
    poster: assetPath,
    alt: { type: "string", minLength: 1, maxLength: 250 },
    sourceIds: idList,
    frame,
  },
} as const;

const source = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title"],
  properties: {
    id,
    title: { type: "string", minLength: 1, maxLength: 160 },
    asset: assetPath,
    url: { type: "string", pattern: URL_PATTERN, maxLength: 500 },
  },
} as const;

export const sceneSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.2:scene",
  title: "Depthcue scene",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "title", "layout", "blocks"],
  properties: {
    $schema: schemaRef,
    schemaVersion,
    id,
    title: { type: "string", minLength: 1, maxLength: 120 },
    layout: { enum: LAYOUTS },
    lead: { enum: LEADS },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["id", "text", "evidenceIds"],
      properties: {
        id,
        text: { type: "string", minLength: 1, maxLength: 280 },
        evidenceIds: idList,
      },
    },
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        discriminator: { propertyName: "type" },
        oneOf: [textBlock, imageBlock, barChartBlock, clipBlock],
      },
    },
    sources: { type: "array", maxItems: 32, items: source },
    reading: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 2000 } },
    },
    steps: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reveal"],
        properties: { id, reveal: { ...idList, minItems: 1 } },
      },
    },
    notes: { type: "string", maxLength: 4000 },
  },
} as const;

export const deckSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.2:deck",
  title: "Depthcue deck manifest",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "title", "language", "theme", "scenes"],
  properties: {
    $schema: schemaRef,
    schemaVersion,
    id,
    title: { type: "string", minLength: 1, maxLength: 120 },
    language: { type: "string", pattern: LANGUAGE_PATTERN, maxLength: 35 },
    theme: { enum: THEMES },
    scenes: { type: "array", items: id, uniqueItems: true, minItems: 1, maxItems: 200 },
    modules: {
      type: "object",
      propertyNames: id,
      additionalProperties: { type: "string", pattern: MODULE_SETTING_PATTERN, maxLength: 16 },
    },
  },
} as const;

export const OP_NAMES = [
  "deck.set",
  "scene.add",
  "scene.remove",
  "scene.move",
  "scene.set",
  "block.add",
  "block.remove",
  "block.move",
  "block.set",
  "block.frame",
  "block.unframe",
] as const;

const object = { type: "object" } as const;
/** Where to put something: after this id, or null for the start. */
const position = { type: ["string", "null"], pattern: ID_PATTERN } as const;
/** Properties to write; a null value deletes an optional property. Values are checked on the result. */
const changes = { type: "object", minProperties: 1 } as const;

const op = <Name extends string, Properties extends object, Required extends readonly string[]>(
  name: Name,
  properties: Properties,
  required: Required,
) =>
  ({
    type: "object",
    additionalProperties: false,
    required: ["op", ...required],
    properties: { op: { const: name }, ...properties },
  }) as const;

/**
 * The command vocabulary. Shapes are checked here; the values inside `scene`, `block` and `set` are checked
 * against the scene schema on the document the operations produce, so errors point at the real file and path.
 */
export const opsSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.2:ops",
  title: "Depthcue operations",
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    type: "object",
    discriminator: { propertyName: "op" },
    oneOf: [
      op("deck.set", { set: changes }, ["set"]),
      op("scene.add", { scene: object, after: position }, ["scene"]),
      op("scene.remove", { id }, ["id"]),
      op("scene.move", { id, after: position }, ["id", "after"]),
      op("scene.set", { id, set: changes }, ["id", "set"]),
      op("block.add", { scene: id, block: object, after: position }, ["scene", "block"]),
      op("block.remove", { scene: id, id }, ["scene", "id"]),
      op("block.move", { scene: id, id, after: position }, ["scene", "id", "after"]),
      op("block.set", { scene: id, id, set: changes }, ["scene", "id", "set"]),
      op("block.frame", { scene: id, id, frame }, ["scene", "id", "frame"]),
      op("block.unframe", { scene: id, id }, ["scene", "id"]),
    ],
  },
} as const;

/** The format name written into `comments.json`, so a reader can tell what it has. */
export const COMMENTS_FORMAT = "depthcue-comments/1";
/** Who wrote a message: the person at the editor, or an agent working on the deck. */
export const COMMENT_AUTHORS = ["you", "agent"] as const;
/** Limits that keep a comments file a conversation and not a store of documents. */
export const COMMENT_LIMITS = { text: 2000, thread: 50, comments: 500 } as const;
export const COMMENT_OP_NAMES = [
  "comment.add",
  "comment.reply",
  "comment.resolve",
  "comment.reopen",
  "comment.delete",
] as const;

/** UTC, to the second or the millisecond, as `Date.prototype.toISOString` writes it. */
const TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$";
const fraction = { type: "number", minimum: 0, maximum: 1 } as const;
const author = { enum: COMMENT_AUTHORS } as const;
const commentText = { type: "string", minLength: 1, maxLength: COMMENT_LIMITS.text } as const;
/** Where on the block a comment points, as fractions of the block's width and height from its top left. */
const anchor = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: { x: fraction, y: fraction },
} as const;
const message = {
  type: "object",
  additionalProperties: false,
  required: ["author", "text", "at"],
  properties: {
    author,
    text: commentText,
    at: { type: "string", pattern: TIMESTAMP_PATTERN, maxLength: 30 },
  },
} as const;
const comment = {
  type: "object",
  additionalProperties: false,
  required: ["id", "scene", "block", "anchor", "thread", "resolved"],
  properties: {
    id,
    scene: id,
    block: id,
    anchor,
    thread: { type: "array", minItems: 1, maxItems: COMMENT_LIMITS.thread, items: message },
    resolved: { type: "boolean" },
    ask: { type: "boolean" },
  },
} as const;

/**
 * The comments file, which sits beside the deck and is never part of it: a comment does not change the deck's
 * revision, an export does not carry it, and the player never reads it. A comment whose scene or block has gone is
 * still valid here, and is shown as orphaned; that it exists in the deck is checked against the deck, not the file.
 */
export const commentsSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.2:comments",
  title: "Depthcue comments",
  type: "object",
  additionalProperties: false,
  required: ["format", "comments"],
  properties: {
    $schema: schemaRef,
    format: { const: COMMENTS_FORMAT },
    comments: { type: "array", maxItems: COMMENT_LIMITS.comments, items: comment },
  },
} as const;

/** The commands for comments. They run on the comments file, with the deck read for the block a comment points at. */
export const commentOpsSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.2:comment-ops",
  title: "Depthcue comment operations",
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    type: "object",
    discriminator: { propertyName: "op" },
    oneOf: [
      // Marked pure so that a build which never reads these schemas, the player's, drops them with the rest.
      /* @__PURE__ */ op(
        "comment.add",
        { id, scene: id, block: id, anchor, author, text: commentText, ask: { type: "boolean" } },
        ["scene", "block", "anchor", "author", "text"],
      ),
      /* @__PURE__ */ op("comment.reply", { id, author, text: commentText }, ["id", "author", "text"]),
      /* @__PURE__ */ op("comment.resolve", { id }, ["id"]),
      /* @__PURE__ */ op("comment.reopen", { id }, ["id"]),
      /* @__PURE__ */ op("comment.delete", { id }, ["id"]),
    ],
  },
} as const;
