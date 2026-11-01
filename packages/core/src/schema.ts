/**
 * JSON Schema source of truth for a deck folder (draft-07 keywords only).
 * `pnpm schema` writes the published .schema.json files and the compiled validators from these objects.
 */
/**
 * Versions a file may declare, oldest first. 0.2 adds the optional block `frame`. 0.3 adds the deck's `palette` and
 * `fonts`, a text block's `tone`, `size` and `align`, the `table` and `chart` blocks, and reads the text of text
 * blocks as markup (see inline.ts). 0.4 adds the deck's `brand`, a scene's `template`, a block's `slot` and `style`,
 * and the brand and template files; it reads text as 0.3 does. A file is read as the version it declares, so the text
 * of an older scene stays exactly as written.
 */
export const SCHEMA_VERSIONS = ["0.1", "0.2", "0.3", "0.4"] as const;
/** The version the tool writes into a new scene. 0.4 reads exactly as 0.3, so a new scene shows the same either way. */
export const SCHEMA_VERSION = "0.4" as const;
/** The versions a brand or a template file may declare: both came with 0.4. A test keeps this the tail of the list above. */
export const BRAND_SCHEMA_VERSIONS = ["0.4"] as const;

export const ID_PATTERN = "^[a-z][a-z0-9-]{1,63}$";
export const ASSET_PATTERN = "^assets/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*$";
/**
 * Files of a brand, named relative to the `brand/` folder: fonts, logos and images, each in its own folder and of the
 * kinds a browser shows. Like an asset path, none climbs out of its folder.
 */
export const FONT_FILE_PATTERN = "^fonts/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*\\.(woff2|woff|ttf|otf)$";
export const LOGO_FILE_PATTERN = "^logos/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*\\.(svg|png)$";
export const IMAGE_FILE_PATTERN =
  "^images/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*\\.(jpg|jpeg|png|webp|svg)$";
/** A font family name: no quote, backslash, semicolon, brace or angle bracket, so it is safe inside CSS. */
export const FAMILY_PATTERN = "^[^\"'\\\\;{}<>]+$";
export const LANGUAGE_PATTERN = "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$";
export const URL_PATTERN = "^https?://[^\\s]+$";
/** What a deck says about a module: `off`, or the version it needs, such as `1` or `1.2`. */
export const MODULE_SETTING_PATTERN = "^(off|[0-9]{1,4}(\\.[0-9]{1,4}){0,2})$";
/** A color in a deck's palette: `#` and six hex digits. */
export const COLOR_PATTERN = "^#[0-9A-Fa-f]{6}$";

export const LAYOUTS = ["title", "claim-evidence", "text-media"] as const;
/** The two presets a deck's colors start from. */
export const THEMES = ["paper", "ink"] as const;
export const LEADS = ["human", "agent", "shared"] as const;
export const TEXT_ROLES = ["heading", "body", "caption", "quote"] as const;

/** Every color a theme names, as brand/tokens.json has them under `color.theme`. */
export const THEME_COLORS = [
  "bg",
  "surface",
  "line",
  "text",
  "muted",
  "action",
  "evidence",
  "state",
  "on-state",
] as const;
/**
 * The theme colors a deck's `palette` may change. `state` and `on-state` are left out: they mark live, current and
 * done in Depthcue's own controls, never on a slide, so recoloring them would change nothing the audience sees.
 */
export const PALETTE_COLORS = ["bg", "surface", "line", "text", "muted", "action", "evidence"] as const;
/**
 * The palette colors that may color text, by a text block's `tone` or a `[label]{tone}` span. They are roles with
 * contrast duties, not a palette for data: a chart's series colors are not stored, and come from the deck's palette
 * by series position. The backgrounds and the line color are not tones: text in those would sit on itself.
 */
export const TONES = ["text", "muted", "action", "evidence"] as const;
/** The four font pairs a deck may choose. `editorial` is Instrument Serif with Space Grotesk, the default. */
export const FONT_PAIRS = ["editorial", "modern", "classic", "technical"] as const;
export const TEXT_SIZES = ["s", "m", "l", "xl"] as const;
/** Where the lines of a text block sit: `start` and `end` follow the deck's language, so they suit any script. */
export const TEXT_ALIGNS = ["start", "center", "end"] as const;
export const COLUMN_KINDS = ["text", "number"] as const;
export const CHART_KINDS = ["bar", "stacked-bar", "line", "area", "scatter", "donut"] as const;

/**
 * The kinds of block a template slot accepts and a style applies to: a text block by its role, any other by its type.
 * A `bar-chart` is a `chart` here, so a slot or a style for charts takes the old block too.
 */
export const BLOCK_KINDS = [
  "heading",
  "body",
  "caption",
  "quote",
  "image",
  "table",
  "chart",
  "clip",
] as const;
/** Which of the deck's faces a style sets its text in. */
export const STYLE_FONTS = ["display", "body", "mono"] as const;
export const STYLE_WEIGHTS = ["regular", "bold"] as const;
/** `upper` and `lower` set every letter in that case; `none` shows the text as written. */
export const STYLE_CASES = ["none", "upper", "lower"] as const;
/** A style's text color: one of the tones, or `bg` for reversed text on a dark fill. */
export const STYLE_TONES = ["text", "muted", "action", "evidence", "bg"] as const;
/** What a style fills its block with: nothing, or a palette color. */
export const STYLE_FILLS = ["none", "surface", "action", "evidence", "text"] as const;
export const STYLE_BORDERS = ["none", "line", "action"] as const;
/** A bar of the accent color along one edge of the block: down its start side, or along its top. */
export const STYLE_EDGES = ["none", "start", "top"] as const;
/** The steps a style's corner radius and padding take. */
export const STYLE_STEPS = ["none", "s", "m", "l"] as const;
/** Where a brand's logo sits on a slide. `start` and `end` follow the deck's language, as text alignment does. */
export const LOGO_CORNERS = ["top-start", "top-end", "bottom-start", "bottom-end"] as const;
export const LOGO_SIZES = ["s", "m", "l"] as const;
/** Where the footer line and the slide number sit along the bottom of a slide. */
export const CHROME_PLACES = ["start", "center", "end"] as const;
/** A bar of the action color on every slide: none, along the top, or down the start side. */
export const ACCENTS = ["none", "top", "start"] as const;
/** How much of the brand's chrome a template shows: all of it, the logo alone, or nothing. */
export const TEMPLATE_CHROME = ["full", "minimal", "none"] as const;
/**
 * What a template slot is for. PowerPoint keeps it as a placeholder's type: a brand import reads it from a layout's
 * placeholders, and the export writes placeholders of that type. A `claim` slot is where the scene's claim is drawn and
 * takes no blocks; a `content` slot takes any block.
 */
export const SLOT_ROLES = [
  "title",
  "subtitle",
  "claim",
  "body",
  "picture",
  "chart",
  "table",
  "content",
] as const;
const TEXT_KINDS = ["heading", "body", "caption", "quote"] as const;
/** The kinds of block a slot of each role may take: its `accepts` lists some of them, and `checkTemplate` holds it. */
export const ROLE_KINDS: Readonly<Record<(typeof SLOT_ROLES)[number], readonly string[]>> = {
  title: ["heading"],
  subtitle: TEXT_KINDS,
  claim: [],
  body: TEXT_KINDS,
  picture: ["image"],
  chart: ["chart"],
  table: ["table"],
  content: BLOCK_KINDS,
};
/** Where a slot's blocks sit in its frame, as a PowerPoint placeholder's anchor. Left out, at the top. */
export const VALIGNS = ["top", "middle", "bottom"] as const;
/** The palette colors a template's background may take. */
export const BACKGROUND_COLORS = ["bg", "surface", "text", "action", "evidence"] as const;
export const FONT_STYLES = ["normal", "italic"] as const;
export const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
/** What a brand may hide of Depthcue's own: its templates, its styles, or both. */
export const BUILT_IN_SETS = ["templates", "styles"] as const;
/** How big a brand and its templates may be. */
export const BRAND_LIMITS = {
  name: 80,
  styles: 24,
  styleName: 40,
  chart: 6,
  faceFiles: 8,
  slots: 12,
  slotMax: 8,
  description: 200,
  hint: 160,
  footer: 120,
  alt: 250,
} as const;

/**
 * Character limits per text role, counted on the text the audience sees: markup, link addresses and list markers do
 * not count. The renderer measures real boxes; these keep the source honest.
 */
export const TEXT_LIMITS = { heading: 90, body: 600, caption: 160, quote: 300 } as const;
/**
 * Limits on the stored text, markup included. Each is more than twice the limit above, so a scene upgraded to 0.3,
 * whose text gets a backslash before each character that would otherwise be markup, always fits.
 */
export const TEXT_SOURCE_LIMITS = { heading: 240, body: 1600, caption: 400, quote: 800 } as const;
/** How big a table or a chart may be. A chart's first column holds its categories; each other one is a series. */
export const DATA_LIMITS = { columns: 12, rows: 30, series: 6, donutParts: 6, cell: 120, label: 40 } as const;

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

/**
 * A text block. Its `text` is markup in a scene of 0.3 or later and literal below; the limit on what the audience
 * sees depends on that, so `checkText` counts it, and the schema holds only the stored length.
 */
const textBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "role", "text"],
  properties: {
    id,
    type: { const: "text" },
    role: { enum: TEXT_ROLES },
    text: { type: "string", minLength: 1, maxLength: TEXT_SOURCE_LIMITS.body },
    tone: { enum: TONES },
    size: { enum: TEXT_SIZES },
    align: { enum: TEXT_ALIGNS },
    sourceIds: idList,
    frame,
    slot: id,
    style: id,
  },
  allOf: [
    {
      if: { properties: { role: { const: "heading" } }, required: ["role"] },
      then: { properties: { text: { type: "string", maxLength: TEXT_SOURCE_LIMITS.heading } } },
    },
    {
      if: { properties: { role: { const: "caption" } }, required: ["role"] },
      then: { properties: { text: { type: "string", maxLength: TEXT_SOURCE_LIMITS.caption } } },
    },
    {
      if: { properties: { role: { const: "quote" } }, required: ["role"] },
      then: { properties: { text: { type: "string", maxLength: TEXT_SOURCE_LIMITS.quote } } },
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
    slot: id,
    style: id,
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
    slot: id,
    style: id,
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
    slot: id,
    style: id,
  },
} as const;

const dataTitle = { type: "string", minLength: 1, maxLength: 120 } as const;
const dataUnit = { type: "string", minLength: 1, maxLength: 16 } as const;
const columnLabel = { type: "string", minLength: 1, maxLength: DATA_LIMITS.label } as const;
/** One cell: text, a number, or null for an empty one. Which a column takes is checked by `checkData`. */
const cell = { type: ["string", "number", "null"], minLength: 1, maxLength: DATA_LIMITS.cell } as const;
/** The rows of a table or a chart: one array per row, with one cell per column, which `checkData` checks. */
const rows = (minCells: number, maxCells: number) =>
  ({
    type: "array",
    minItems: 1,
    maxItems: DATA_LIMITS.rows,
    items: { type: "array", minItems: minCells, maxItems: maxCells, items: cell },
  }) as const;

const tableBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "columns", "rows"],
  properties: {
    id,
    type: { const: "table" },
    title: dataTitle,
    columns: {
      type: "array",
      minItems: 1,
      maxItems: DATA_LIMITS.columns,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: { label: columnLabel, kind: { enum: COLUMN_KINDS }, unit: dataUnit },
      },
    },
    rows: /* @__PURE__ */ rows(1, DATA_LIMITS.columns),
    /** Whether the column labels show as a header row. Left out, they do. */
    header: { type: "boolean" },
    sourceIds: idList,
    frame,
    slot: id,
    style: id,
  },
} as const;

/**
 * A chart. Its data has the shape of a table's, so one grid edits both and a change of `kind` keeps it: the first
 * column holds the categories (for a scatter, the x numbers), and each column after it is a series of numbers. A
 * series has no stored color: the player gives it one from the deck's palette by its position.
 */
const chartBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "kind", "columns", "rows"],
  properties: {
    id,
    type: { const: "chart" },
    kind: { enum: CHART_KINDS },
    title: dataTitle,
    unit: dataUnit,
    columns: {
      type: "array",
      minItems: 2,
      maxItems: DATA_LIMITS.series + 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: { label: columnLabel, unit: dataUnit },
      },
    },
    rows: /* @__PURE__ */ rows(2, DATA_LIMITS.series + 1),
    sourceIds: idList,
    frame,
    slot: id,
    style: id,
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

/**
 * A scene. It is drawn by a built-in `layout` or by a `template`, exactly one of the two, which `checkSceneForm`
 * checks so the message can say both ways out. In a template scene each block names its `slot`, unless it is pinned
 * over the slots, and the claim is drawn in the template's claim slot.
 */
export const sceneSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.4:scene",
  title: "Depthcue scene",
  $comment:
    "A scene has exactly one of layout and template; depthcue check says so when it has neither or both.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "title", "blocks"],
  properties: {
    $schema: schemaRef,
    schemaVersion,
    id,
    title: { type: "string", minLength: 1, maxLength: 120 },
    layout: { enum: LAYOUTS },
    template: id,
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
        oneOf: [textBlock, imageBlock, barChartBlock, clipBlock, tableBlock, chartBlock],
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

const color = { type: "string", pattern: COLOR_PATTERN, maxLength: 7 } as const;
/** Colors that replace a preset's, by name: a deck's, and a brand's for each preset. */
const palette = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    bg: color,
    surface: color,
    line: color,
    text: color,
    muted: color,
    action: color,
    evidence: color,
  },
} as const;

export const deckSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.4:deck",
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
    /** The preset the colors start from. */
    theme: { enum: THEMES },
    /** Colors that replace the preset's, by name. Contrast between them is checked by `checkPalette`. */
    palette,
    fonts: { enum: FONT_PAIRS },
    /** The id of the brand in the deck's `brand/` folder, whose `brand.json` must say the same id. */
    brand: id,
    scenes: { type: "array", items: id, uniqueItems: true, minItems: 1, maxItems: 200 },
    modules: {
      type: "object",
      propertyNames: id,
      additionalProperties: { type: "string", pattern: MODULE_SETTING_PATTERN, maxLength: 16 },
    },
  },
} as const;

/** A brand's palette for a preset: a deck palette's colors, and the series colors of charts on that preset's slides. */
const brandPalette = {
  ...palette,
  properties: {
    ...palette.properties,
    /** In order. Without them a chart takes its colors from the palette. */
    chart: { type: "array", minItems: 1, maxItems: BRAND_LIMITS.chart, items: color },
  },
} as const;

const brandVersion = { enum: BRAND_SCHEMA_VERSIONS } as const;
const brandName = { type: "string", minLength: 1, maxLength: BRAND_LIMITS.name } as const;
/** Typed as strings, so Ajv checks the list for repeats without its deep-equal helper, which a standalone module lacks. */
const kinds = {
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: { type: "string", enum: BLOCK_KINDS },
} as const;

/**
 * One face of a brand's own: its family, and the files that carry it, by weight and style, with the license they are
 * carried under. A face with no files is installed on the viewers' machines, needs no license here, and is what a
 * PowerPoint theme names.
 */
const face = {
  type: "object",
  additionalProperties: false,
  required: ["family"],
  properties: {
    family: { type: "string", minLength: 1, maxLength: 64, pattern: FAMILY_PATTERN },
    /** An SPDX id such as `OFL-1.1`, or the license's name. */
    license: { type: "string", minLength: 1, maxLength: 120 },
    /** Left out for a face that is installed on the viewers' machines and not carried by the deck. */
    files: {
      type: "array",
      minItems: 1,
      maxItems: BRAND_LIMITS.faceFiles,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "weight", "style"],
        properties: {
          file: { type: "string", pattern: FONT_FILE_PATTERN, maxLength: 200 },
          weight: { enum: FONT_WEIGHTS },
          style: { enum: FONT_STYLES },
        },
      },
    },
  },
  dependencies: { files: ["license"] },
} as const;

/** The brand's own faces, and the built-in pair the deck falls back to while they load or when they are missing. */
export const facesSchema = {
  type: "object",
  additionalProperties: false,
  required: ["display", "body", "fallback"],
  properties: { display: face, body: face, mono: face, fallback: { enum: FONT_PAIRS } },
} as const;

/**
 * A component style: a named look a block takes with `"style": "<id>"`, from a bounded set of properties, for the kinds
 * of block in `for`. A block's own tone, size and align win over its style's.
 */
export const blockStyleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "for"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: BRAND_LIMITS.styleName },
    for: kinds,
    font: { enum: STYLE_FONTS },
    size: { enum: TEXT_SIZES },
    weight: { enum: STYLE_WEIGHTS },
    case: { enum: STYLE_CASES },
    tone: { enum: STYLE_TONES },
    fill: { enum: STYLE_FILLS },
    border: { enum: STYLE_BORDERS },
    edge: { enum: STYLE_EDGES },
    radius: { enum: STYLE_STEPS },
    pad: { enum: STYLE_STEPS },
    align: { enum: TEXT_ALIGNS },
  },
} as const;

/**
 * `brand/brand.json`. Files it names are relative to the `brand/` folder. Which logos it needs, which files exist and
 * whether its colors reach the contrast minimums are facts the schema cannot state; `checkBrand` checks them.
 */
export const brandSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.4:brand",
  title: "Depthcue brand",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "name"],
  properties: {
    $schema: schemaRef,
    schemaVersion: brandVersion,
    id,
    name: brandName,
    /**
     * A palette for each preset, each with its own chart colors, so each can reach 3:1 on its own background. The
     * brand's goes on the preset's, and a deck's own palette on top, unless locked.
     */
    colors: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: { paper: brandPalette, ink: brandPalette },
    },
    /** A built-in pair, or the brand's own faces. */
    fonts: {
      type: ["string", "object"],
      if: { type: "string" },
      then: { enum: FONT_PAIRS },
      else: facesSchema,
    },
    /** A logo for light slides, one for dark slides, or both, and what it says to someone who cannot see it. */
    logos: {
      type: "object",
      additionalProperties: false,
      required: ["alt"],
      properties: {
        light: { type: "string", pattern: LOGO_FILE_PATTERN, maxLength: 200 },
        dark: { type: "string", pattern: LOGO_FILE_PATTERN, maxLength: 200 },
        alt: { type: "string", minLength: 1, maxLength: BRAND_LIMITS.alt },
      },
    },
    /** What sits on every slide, as on a PowerPoint slide master. */
    chrome: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        logo: {
          type: "object",
          additionalProperties: false,
          required: ["corner", "size"],
          properties: { corner: { enum: LOGO_CORNERS }, size: { enum: LOGO_SIZES } },
        },
        footer: {
          type: "object",
          additionalProperties: false,
          required: ["text", "place"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: BRAND_LIMITS.footer },
            place: { enum: CHROME_PLACES },
          },
        },
        number: {
          type: "object",
          additionalProperties: false,
          required: ["place"],
          properties: { place: { enum: CHROME_PLACES } },
        },
        accent: { enum: ACCENTS },
      },
    },
    /** The brand's component styles, by id. One with the id of a built-in style replaces it. */
    styles: {
      type: "object",
      propertyNames: id,
      maxProperties: BRAND_LIMITS.styles,
      additionalProperties: blockStyleSchema,
    },
    /** True refuses a deck palette and a deck font pair, so a deck cannot drift off the brand. */
    lock: { type: "boolean" },
    /** Depthcue's own templates or styles that this brand's decks do not offer. */
    hideBuiltIn: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", enum: BUILT_IN_SETS },
    },
  },
} as const;

/**
 * A slot of a template: what it is for, where on the slide it sits, which kinds of block it takes and how many, the
 * style its blocks take unless they name one, and a hint that tells a person or an agent what goes there. A `claim`
 * slot holds the scene's claim, so it has no `accepts`; every other slot has one, which its role bounds.
 */
const slot = {
  type: "object",
  additionalProperties: false,
  required: ["id", "role", "frame", "hint"],
  properties: {
    id,
    role: { enum: SLOT_ROLES },
    frame,
    accepts: kinds,
    style: id,
    /** How many blocks the slot stacks. Left out, one. */
    max: { type: "integer", minimum: 1, maximum: BRAND_LIMITS.slotMax },
    /** True when a scene of this template should fill the slot; an empty one is a warning, not an error. */
    required: { type: "boolean" },
    valign: { enum: VALIGNS },
    hint: { type: "string", minLength: 1, maxLength: BRAND_LIMITS.hint },
  },
  if: { properties: { role: { const: "claim" } }, required: ["role"] },
  else: { properties: { accepts: {} }, required: ["accepts"] },
} as const;

/**
 * `brand/templates/<id>.json`, and the shape of a built-in template: a slide layout with named slots. Its file name is
 * its id. That slots lie on the slide and whether they overlap are sums the schema cannot state; `checkTemplate` does.
 */
export const templateSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.4:template",
  title: "Depthcue template",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "name", "description", "slots"],
  properties: {
    $schema: schemaRef,
    schemaVersion: brandVersion,
    id,
    name: { type: "string", minLength: 1, maxLength: BRAND_LIMITS.styleName },
    /** When to use it, for the template picker and for an agent choosing one. */
    description: { type: "string", minLength: 1, maxLength: BRAND_LIMITS.description },
    /**
     * The slide's color, or a brand image with `color` laid over it at `scrim` percent, so text on it can be read.
     * Left out, the slide's own background.
     */
    background: {
      type: "object",
      additionalProperties: false,
      required: ["color"],
      properties: {
        color: { enum: BACKGROUND_COLORS },
        image: { type: "string", pattern: IMAGE_FILE_PATTERN, maxLength: 200 },
        scrim: { type: "number", minimum: 0, maximum: 100 },
      },
      dependencies: { image: ["scrim"], scrim: ["image"] },
    },
    /** How much of the brand's chrome shows. Left out, all of it. */
    chrome: { enum: TEMPLATE_CHROME },
    slots: { type: "array", minItems: 1, maxItems: BRAND_LIMITS.slots, items: slot },
  },
} as const;

export const OP_NAMES = [
  "deck.set",
  "scene.add",
  "scene.remove",
  "scene.move",
  "scene.set",
  "scene.upgrade",
  "block.add",
  "block.remove",
  "block.move",
  "block.set",
  "block.frame",
  "block.unframe",
  "brand.set",
  "style.set",
  "template.set",
] as const;

const object = { type: "object" } as const;
/** Where to put something: after this id, or null for the start. */
const position = { type: ["string", "null"], pattern: ID_PATTERN } as const;
/** Properties to write; a null value deletes an optional property. Values are checked on the result. */
const changes = { type: "object", minProperties: 1 } as const;
/** A whole thing to write, or null to remove it. */
const whole = { type: ["object", "null"] } as const;

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
 * The command vocabulary. Shapes are checked here; the values inside `scene`, `block`, `set`, `style` and `template`
 * are checked against their own schemas on the document the operations produce, so errors point at the real file and
 * path. `brand.set` with `set: null` takes the brand off the deck; `style.set` and `template.set` with null remove one.
 */
export const opsSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.4:ops",
  title: "Depthcue operations",
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    type: "object",
    discriminator: { propertyName: "op" },
    oneOf: [
      /* @__PURE__ */ op("deck.set", { set: changes }, ["set"]),
      /* @__PURE__ */ op("scene.add", { scene: object, after: position }, ["scene"]),
      /* @__PURE__ */ op("scene.remove", { id }, ["id"]),
      /* @__PURE__ */ op("scene.move", { id, after: position }, ["id", "after"]),
      /* @__PURE__ */ op("scene.set", { id, set: changes }, ["id", "set"]),
      /* @__PURE__ */ op("scene.upgrade", { id }, ["id"]),
      /* @__PURE__ */ op("block.add", { scene: id, block: object, after: position }, ["scene", "block"]),
      /* @__PURE__ */ op("block.remove", { scene: id, id }, ["scene", "id"]),
      /* @__PURE__ */ op("block.move", { scene: id, id, after: position }, ["scene", "id", "after"]),
      /* @__PURE__ */ op("block.set", { scene: id, id, set: changes }, ["scene", "id", "set"]),
      /* @__PURE__ */ op("block.frame", { scene: id, id, frame }, ["scene", "id", "frame"]),
      /* @__PURE__ */ op("block.unframe", { scene: id, id }, ["scene", "id"]),
      /* @__PURE__ */ op("brand.set", { set: whole }, ["set"]),
      /* @__PURE__ */ op("style.set", { id, style: whole }, ["id", "style"]),
      /* @__PURE__ */ op("template.set", { id, template: whole }, ["id", "template"]),
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
  $id: "urn:depthcue:schema:0.4:comments",
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
  $id: "urn:depthcue:schema:0.4:comment-ops",
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
