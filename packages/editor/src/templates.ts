import {
  type Block,
  type Doc,
  hasPlaceholderAlt,
  LAYOUTS,
  type NewScene,
  placeholderAlt,
  type Scene,
  shownText,
  type TEXT_ALIGNS,
  type TEXT_SIZES,
  type TONES,
} from "@depthcue/core";
import { CHART_KIND_LABELS } from "@depthcue/player";

export type Layout = NonNullable<Scene["layout"]>;
export type Lead = NonNullable<Scene["lead"]>;
export type TextRole = Extract<Block, { type: "text" }>["role"];

/*
 * What each layout, lead and text role is called on screen. Each is a `Record` over the core's own union, so a
 * value added to the core does not compile until it has a name here.
 */
export const LAYOUT_LABEL: Record<Layout, string> = {
  title: "Title",
  "claim-evidence": "Claim and evidence",
  "text-media": "Text and media",
};
export const LAYOUT_CHOICES = LAYOUTS.map((value) => ({ value, label: LAYOUT_LABEL[value] }));
export const LEAD_LABEL: Record<Lead, string> = { human: "Human", agent: "Agent", shared: "Shared" };
export const ROLE_LABEL: Record<TextRole, string> = {
  heading: "Heading",
  body: "Body",
  caption: "Caption",
  quote: "Quote",
};
export type TextSize = (typeof TEXT_SIZES)[number];
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export type TextTone = (typeof TONES)[number];
export const SIZE_LABEL: Record<TextSize, string> = {
  s: "Small",
  m: "Medium",
  l: "Large",
  xl: "Extra large",
};
export const ALIGN_LABEL: Record<TextAlign, string> = { start: "Start", center: "Center", end: "End" };
export const TONE_LABEL: Record<TextTone, string> = {
  text: "Text",
  muted: "Muted",
  action: "Action",
  evidence: "Evidence",
};

const slug = (text: string): string => {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(cleaned) ? cleaned : `x${cleaned}`;
};

/** An id that matches the schema and is not in `taken`: the base, then base-2, base-3 and so on. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const stem = slug(base).padEnd(2, "x");
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem.slice(0, 60)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Every id a scene already uses; ids are unique across its claim, blocks, sources and steps. */
export function idsInScene(scene: Scene): Set<string> {
  const ids = new Set<string>();
  if (scene.summary) ids.add(scene.summary.id);
  for (const block of scene.blocks) ids.add(block.id);
  for (const source of scene.sources ?? []) ids.add(source.id);
  for (const step of scene.steps ?? []) ids.add(step.id);
  return ids;
}

/** A new scene with just enough on it to be valid and to show what the layout is for. */
export function newScene(doc: Doc, layout: Layout): NewScene {
  const id = uniqueId("new-scene", new Set(doc.deck.scenes));
  const heading: Block = { id: `${id}-heading`, type: "text", role: "heading", text: "New scene" };
  const body: Block = { id: `${id}-body`, type: "text", role: "body", text: "Say something short." };
  if (layout === "claim-evidence") {
    return {
      id,
      title: "New scene",
      layout,
      summary: { id: `${id}-claim`, text: "State the claim here.", evidenceIds: [`${id}-body`] },
      blocks: [body],
    };
  }
  return { id, title: "New scene", layout, blocks: [heading, body] };
}

export type NewBlockKind = "text" | "image" | "chart" | "clip" | "table";

export const BLOCK_KINDS: ReadonlyArray<{ kind: NewBlockKind; label: string }> = [
  { kind: "text", label: "Text" },
  { kind: "image", label: "Image" },
  { kind: "chart", label: "Chart" },
  { kind: "table", label: "Table" },
  { kind: "clip", label: "Clip" },
];

/** True for a kind of block the editor can add. A layout may accept more, such as the old bar chart, that it cannot add. */
export const isNewBlockKind = (kind: string): kind is NewBlockKind =>
  BLOCK_KINDS.some((entry) => entry.kind === kind);

// The core owns this rule, so the editor's flag and `depthcue check` cannot disagree about which alt text is missing.
export { placeholderAlt };
export const needsAlt = hasPlaceholderAlt;

/** A new block of a kind. Images and clips need a file in the deck, so they take its path. */
export function newBlock(scene: Scene, kind: NewBlockKind, asset?: string): Block {
  const id = uniqueId(`${scene.id}-${kind}`, idsInScene(scene));
  switch (kind) {
    case "text":
      return { id, type: "text", role: "body", text: "New text" };
    case "chart":
      // A bar chart of three rows to change: a category column and one series, in the grid that edits any chart.
      return {
        id,
        type: "chart",
        kind: "bar",
        columns: [{ label: "Category" }, { label: "Value" }],
        rows: [
          ["First", 3],
          ["Second", 5],
          ["Third", 4],
        ],
      };
    case "table":
      // Three columns and three rows to type into, under a header row that names the columns.
      return {
        id,
        type: "table",
        columns: [{ label: "Column 1" }, { label: "Column 2" }, { label: "Column 3" }],
        rows: [
          [null, null, null],
          [null, null, null],
          [null, null, null],
        ],
      };
    case "image":
      return { id, type: "image", asset: asset as string, alt: placeholderAlt(asset as string) };
    case "clip":
      return { id, type: "clip", source: asset as string, alt: placeholderAlt(asset as string) };
  }
}

/** The claim a scene gets when one is added: a line to replace, citing nothing yet. */
export function newClaim(scene: Scene): NonNullable<Scene["summary"]> {
  return {
    id: uniqueId(`${scene.id}-claim`, idsInScene(scene)),
    text: "State the claim here.",
    evidenceIds: [],
  };
}

/** The picture commands by id, as the toolbar, the menu and the palette call them. */
export const PICTURE = {
  crop: "Crop",
  fill: "Fill",
  fit: "Fit",
  reset: "Reset picture",
  fitbox: "Fit box to picture",
  bg: "Use as slide background",
  nobg: "Remove background",
} as const;
export type PictureAction = keyof typeof PICTURE;

/** The kinds of image the upload accepts. */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
export const VIDEO_FILE = /\.(mp4|webm)$/i;

/**
 * A short label for a block in a list: its text, its alt text or its chart title. Given its scene, a text is given as
 * the audience sees it, without markup.
 */
export function blockLabel(block: Block, scene?: Pick<Scene, "schemaVersion">): string {
  switch (block.type) {
    case "text":
      return scene ? shownText(scene, block) : block.text;
    case "image":
      return block.alt ?? placeholderAlt(block.asset);
    case "clip":
      return block.alt;
    case "bar-chart":
      return block.title ?? "Bar chart";
    case "table":
      return block.title ?? "Table";
    case "chart":
      return block.title ?? `${CHART_KIND_LABELS[block.kind]} chart`;
  }
}

const KIND_LABEL = {
  image: "Image",
  clip: "Clip",
  "bar-chart": "Chart",
  table: "Table",
  chart: "Chart",
} as const;

const capital = (word: string) => `${word[0]?.toUpperCase()}${word.slice(1)}`;

/** What a block is and says, in one short line for a list: "Heading: Why prices rise". */
export function describeBlock(block: Block, limit = 36, scene?: Pick<Scene, "schemaVersion">): string {
  const kind = block.type === "text" ? capital(block.role) : KIND_LABEL[block.type];
  const label = blockLabel(block, scene);
  return `${kind}: ${label.length > limit ? `${label.slice(0, limit - 1)}…` : label}`;
}
