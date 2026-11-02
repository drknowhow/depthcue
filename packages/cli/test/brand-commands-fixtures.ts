// Sample content for every built-in template, written as scenes with real sentences in them, so the tests (and a look
// at a screenshot) see each template with what a person would put there. The layout tests need both: a template drawn
// empty always fits. Plain data and plain functions, so a scratch script can import it too.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Json = Record<string, unknown>;

/** The ids of Depthcue's own templates, in the order a deck would use them. */
export const BUILT_IN_TEMPLATE_IDS = [
  "title",
  "agenda",
  "section",
  "statement",
  "big-number",
  "quote",
  "two-column",
  "comparison",
  "full-image",
  "closing",
] as const;

/** A picture for the full-image and two-column scenes: a calm sky over water, so a title plate reads on it. */
export const SAMPLE_PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" role="img" aria-label="A harbor at dusk">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2B3A55"/>
      <stop offset="0.6" stop-color="#C98B6B"/>
      <stop offset="1" stop-color="#F2C7A0"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3C5A6E"/>
      <stop offset="1" stop-color="#1E3140"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="540" fill="url(#sky)"/>
  <rect y="540" width="1600" height="360" fill="url(#sea)"/>
  <circle cx="1180" cy="470" r="70" fill="#F6DDB5"/>
  <g fill="#18222D">
    <rect x="240" y="400" width="14" height="140"/>
    <rect x="300" y="360" width="14" height="180"/>
    <rect x="360" y="420" width="14" height="120"/>
    <path d="M200 540 L420 540 L400 580 L220 580 Z"/>
    <path d="M900 520 L1100 520 L1080 560 L920 560 Z"/>
    <rect x="985" y="450" width="10" height="70"/>
  </g>
</svg>
`;

const SOURCES = [
  { id: "berth-log", title: "Harbor master's berth log, July to September" },
  { id: "shipper-survey", title: "Shipper survey, September, 212 replies" },
  { id: "port-tariff", title: "Port tariff schedule, 2026 edition" },
];

const text = (id: string, role: string, body: string, slot: string, extra: Json = {}): Json => ({
  id,
  type: "text",
  role,
  text: body,
  slot,
  ...extra,
});

/** What each built-in template is shown with. `sourceIds` of the block that carries the scene's citations is filled in. */
const SCENES: Record<string, () => Json> = {
  title: () => ({
    title: "Where the harbor grew",
    blocks: [
      text("title-kicker", "caption", "Third quarter review", "kicker"),
      text("title-title", "heading", "Where the harbor grew", "title"),
      text("title-subtitle", "body", "Ships handled rose by a third once the berths reopened.", "subtitle"),
      text("title-byline", "caption", "The analytics team, for the October planning meeting", "byline"),
    ],
  }),
  agenda: () => ({
    title: "Today",
    blocks: [
      text("agenda-title", "heading", "Today", "title"),
      ...[
        "Where the quarter started",
        "What changed in August",
        "Ships handled, berth by berth",
        "What it means for next quarter",
        "The three decisions we need",
        "Questions",
      ].map((item, i) => text(`agenda-item-${i + 1}`, "body", `${i + 1}. ${item}`, "items")),
    ],
  }),
  section: () => ({
    title: "What the numbers say",
    blocks: [
      text("section-kicker", "caption", "Part two", "kicker"),
      text("section-title", "heading", "What the numbers say", "title"),
      text(
        "section-lede",
        "body",
        "Three charts, one table, and what they change for the next quarter.",
        "lede",
      ),
    ],
  }),
  statement: () => ({
    title: "Channel B leads",
    summary: {
      id: "statement-claim",
      text: "Berth B and C reopened in August, and together they carried most of the growth.",
      evidenceIds: ["statement-chart"],
    },
    blocks: [
      {
        id: "statement-chart",
        type: "chart",
        kind: "bar",
        title: "Ships handled each month",
        columns: [{ label: "Month" }, { label: "Berth A" }, { label: "Berth B" }, { label: "Berth C" }],
        rows: [
          ["July", 40, 0, 0],
          ["August", 42, 18, 12],
          ["September", 44, 30, 26],
        ],
        sourceIds: ["berth-log"],
        slot: "evidence",
      },
    ],
    sources: [SOURCES[0]],
  }),
  "big-number": () => ({
    title: "A third more ships",
    summary: {
      id: "big-number-claim",
      text: "Ships handled rose by more than a third once all three berths were open.",
      evidenceIds: ["big-number-figure"],
    },
    blocks: [
      text("big-number-figure", "heading", "+38%", "number"),
      text(
        "big-number-context",
        "body",
        "Ships handled per month, September against July, across all three berths.",
        "context",
      ),
    ],
  }),
  quote: () => ({
    title: "A planned flat quarter",
    blocks: [
      text(
        "quote-words",
        "quote",
        "We planned for a flat quarter, and the second half surprised us.",
        "quote",
      ),
      text("quote-who", "caption", "Harbor master, at the September review", "attribution"),
    ],
  }),
  "two-column": () => ({
    title: "Why the second half beat the plan",
    blocks: [
      text("two-column-title", "heading", "Why the second half beat the plan", "title"),
      text(
        "two-column-left",
        "body",
        "- Berths B and C reopened in August.\n- Dredging finished two weeks early.\n- Crews moved from night shifts to days.",
        "left",
      ),
      {
        id: "two-column-picture",
        type: "image",
        asset: "assets/harbor.svg",
        alt: "A harbor at dusk, with cranes over the berths.",
        caption: "Berth B, the week it reopened.",
        slot: "right",
      },
    ],
  }),
  comparison: () => ({
    title: "Berth A against B and C",
    blocks: [
      text("comparison-title", "heading", "Berth A against B and C", "title"),
      text("comparison-left-title", "heading", "Berth A", "left-title"),
      text("comparison-left-1", "body", "Open all quarter, at about 40 ships a month.", "left"),
      text("comparison-left-2", "body", "Close to its limit by September.", "left"),
      text("comparison-right-title", "heading", "Berths B and C", "right-title"),
      text(
        "comparison-right-1",
        "body",
        "Open from August, 56 ships a month together by September.",
        "right",
      ),
      text("comparison-right-2", "body", "Room to grow before the winter schedule.", "right"),
    ],
  }),
  "full-image": () => ({
    title: "The new berth",
    blocks: [
      {
        id: "full-image-picture",
        type: "image",
        asset: "assets/harbor.svg",
        alt: "A harbor at dusk, with cranes over the berths.",
        slot: "picture",
      },
      text("full-image-title", "heading", "The new berth, the week it opened", "title"),
    ],
  }),
  closing: () => ({
    title: "Thank you",
    blocks: [
      text("closing-title", "heading", "Thank you", "title"),
      text("closing-message", "body", "Questions, and the three decisions we need today.", "message"),
      text("closing-contact", "caption", "analytics@harbor.example", "contact"),
    ],
  }),
};

/**
 * The block of each sample scene that carries its citations, where a person would put them: on the content that has
 * numbers or claims behind it. A block that cites gets a "Source:" line under it, so a slot has to have room for it; a
 * title, a quote or a closing line cites nothing, and the scene lists its sources all the same.
 */
const CITING: Record<string, string | undefined> = {
  statement: "statement-chart",
  "big-number": "big-number-context",
  "two-column": "two-column-left",
  comparison: "comparison-left-1",
};

export interface SampleOptions {
  /** Cite three sources, so the band at the foot of the slide has three lines to draw. */
  sources?: boolean;
  /** The scene id; left out, `s-<template>`. */
  id?: string;
}

/** A scene of the template, filled with what it is for. Not every template takes every option (a title has no figure). */
export function sampleScene(template: string, options: SampleOptions = {}): Json {
  const make = SCENES[template];
  if (!make) throw new Error(`No sample for the template "${template}".`);
  const scene = make();
  const blocks = (scene.blocks as Json[]).map((block) =>
    options.sources && block.id === CITING[template]
      ? { ...block, sourceIds: SOURCES.map((source) => source.id) }
      : block,
  );
  return {
    schemaVersion: "0.4",
    id: options.id ?? `s-${template}`,
    ...scene,
    template,
    blocks,
    ...(options.sources ? { sources: SOURCES } : {}),
  };
}

export interface SampleDeckOptions {
  templates?: readonly string[];
  theme?: "paper" | "ink";
  fonts?: "editorial" | "modern" | "classic" | "technical";
  brand?: string;
  sources?: boolean;
  /** Added to the deck's file list, by path from the deck folder: the brand's files, copied by `brand use`. */
  extra?: Readonly<Record<string, string | Uint8Array>>;
  id?: string;
}

/** The files of a deck with one scene per template, ready to write. */
export function sampleDeckFiles(options: SampleDeckOptions = {}): Record<string, string | Uint8Array> {
  const templates = options.templates ?? BUILT_IN_TEMPLATE_IDS;
  const ids = templates.map((template) => `s-${template}`);
  const files: Record<string, string | Uint8Array> = {
    "deck.json": `${JSON.stringify(
      {
        schemaVersion: "0.4",
        id: options.id ?? "built-in-samples",
        title: "Built-in templates",
        language: "en",
        theme: options.theme ?? "paper",
        ...(options.fonts ? { fonts: options.fonts } : {}),
        ...(options.brand ? { brand: options.brand } : {}),
        scenes: ids,
      },
      null,
      2,
    )}\n`,
    "assets/harbor.svg": SAMPLE_PICTURE,
  };
  for (const template of templates) {
    const scene = sampleScene(template, options.sources === undefined ? {} : { sources: options.sources });
    files[`scenes/s-${template}.json`] = `${JSON.stringify(scene, null, 2)}\n`;
  }
  return { ...files, ...options.extra };
}

/** Writes the files under `dir`, making the folders. */
export function writeFiles(dir: string, files: Readonly<Record<string, string | Uint8Array>>): void {
  for (const [path, data] of Object.entries(files)) {
    const to = join(dir, ...path.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, data);
  }
}
