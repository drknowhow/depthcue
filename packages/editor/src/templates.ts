import type { Block, Doc, NewScene, Scene } from "@depthcue/core";

export type Layout = Scene["layout"];

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

export type NewBlockKind = "text" | "image" | "bar-chart" | "clip";

export const BLOCK_KINDS: ReadonlyArray<{ kind: NewBlockKind; label: string }> = [
  { kind: "text", label: "Text" },
  { kind: "image", label: "Image" },
  { kind: "bar-chart", label: "Bar chart" },
  { kind: "clip", label: "Clip" },
];

const stem = (path: string) => path.replace(/^.*\//, "").replace(/\.[^.]+$/, "");

/** A new block of a kind. Images and clips need a file in the deck, so they take its path. */
export function newBlock(scene: Scene, kind: NewBlockKind, asset?: string): Block {
  const id = uniqueId(`${scene.id}-${kind === "bar-chart" ? "chart" : kind}`, idsInScene(scene));
  switch (kind) {
    case "text":
      return { id, type: "text", role: "body", text: "New text" };
    case "bar-chart":
      return {
        id,
        type: "bar-chart",
        data: [
          { label: "First", value: 1 },
          { label: "Second", value: 2 },
        ],
      };
    case "image":
      return { id, type: "image", asset: asset as string, alt: stem(asset as string).replace(/[-_]+/g, " ") };
    case "clip":
      return { id, type: "clip", source: asset as string, alt: stem(asset as string).replace(/[-_]+/g, " ") };
  }
}

export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
export const VIDEO_FILE = /\.(mp4|webm)$/i;

/** A short label for a block in a list: its text, its alt text or its chart title. */
export function blockLabel(block: Block): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return block.alt;
    case "clip":
      return block.alt;
    case "bar-chart":
      return block.title ?? "Bar chart";
  }
}

const KIND_LABEL = { image: "Image", clip: "Clip", "bar-chart": "Chart" } as const;

const capital = (word: string) => `${word[0]?.toUpperCase()}${word.slice(1)}`;

/** What a block is and says, in one short line for a list: "Heading: Why prices rise". */
export function describeBlock(block: Block, limit = 36): string {
  const kind = block.type === "text" ? capital(block.role) : KIND_LABEL[block.type];
  const label = blockLabel(block);
  return `${kind}: ${label.length > limit ? `${label.slice(0, limit - 1)}…` : label}`;
}
