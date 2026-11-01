/**
 * A PowerPoint slide layout as a Depthcue template. Each placeholder becomes a slot with a frame in percent of the
 * slide, taken from the layout or, when the layout leaves it out, from the master's placeholder of the same kind. A
 * layout whose slots would overlap or fall off the slide is skipped with the reason, never bent to fit.
 */
import { BLOCK_KINDS, BRAND_LIMITS, FRAME_MIN, type Template, type TemplateSlot } from "@depthcue/core";
import type { Layout } from "./master.ts";
import type { OfficePackage } from "./package.ts";
import type { Palette } from "./palette.ts";
import { anchorOf, type Box, directionOf, promptOf, type Shape } from "./shapes.ts";
import { type ColorMap, colorElement, resolveColor, type Theme } from "./theme.ts";
import type { Left, SlotReport, SlotRole } from "./types.ts";
import { child, type XmlNode } from "./xml.ts";

type Accepts = NonNullable<TemplateSlot["accepts"]>;

interface SlotKind {
  role: SlotRole;
  accepts: Accepts;
}

/** What a placeholder is for a slot when its type has no slot of its own (a video, a diagram): any block. */
const CONTENT: SlotKind = { role: "content", accepts: [...BLOCK_KINDS] };

/** What a placeholder type means for a slot: its role, and the kinds of block it takes. */
const SLOT_OF: Readonly<Record<string, SlotKind>> = {
  title: { role: "title", accepts: ["heading"] },
  ctrTitle: { role: "title", accepts: ["heading"] },
  subTitle: { role: "subtitle", accepts: ["body"] },
  body: { role: "body", accepts: ["body"] },
  pic: { role: "picture", accepts: ["image"] },
  chart: { role: "chart", accepts: ["chart"] },
  tbl: { role: "table", accepts: ["table"] },
  obj: CONTENT,
};

/** Placeholders that are not slots: the date, the footer and the slide number are the brand's chrome. */
const CHROME_TYPES = new Set(["dt", "ftr", "sldNum", "hdr", "sldImg"]);

/** What a slot's hint says when the layout has no prompt text of its own. */
const HINTS: Readonly<Record<SlotRole, string>> = {
  title: "The slide's title, in a few words.",
  subtitle: "A line under the title.",
  claim: "The scene's claim.",
  body: "The text of the slide.",
  picture: "A picture.",
  chart: "A chart.",
  table: "A table.",
  content: "Text, a picture, a table or a chart.",
};

/** The prompt PowerPoint puts in an empty placeholder ("Click to edit Master title style") says nothing about its use. */
const STOCK_PROMPT = /^click\b/i;

/** The placeholder family a layout's placeholder inherits its place from on the master. */
const familyOf = (type: string): string =>
  type === "ctrTitle" || type === "title" ? "title" : CHROME_TYPES.has(type) ? type : "body";

/** The template's background when a layout paints one: the picture is copied into the brand, and a scrim laid over it. */
const SCRIM = 65;

export interface TemplateContext {
  pkg: OfficePackage;
  slide: { w: number; h: number };
  masterShapes: readonly Shape[];
  theme: Theme;
  map: ColorMap;
  palette: Palette;
  /** Puts a picture in the brand's `images/` folder, and says where, or why it cannot. */
  addImage(part: string, bytes: Uint8Array): { file: string } | { why: string };
}

export interface TemplateResult {
  /** The layout's name in the file. */
  layout: string;
  template?: Template;
  slots: SlotReport[];
  /** Why the layout is not a template. */
  skipped?: string;
  left: Left[];
  /** Placeholder types taken as `content` because they have no slot of their own. */
  generic: string[];
  decoration: { shapes: number; pictures: number };
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** A box as a frame in percent of the slide. Both edges are rounded, so boxes that touch still touch. */
export function frameOf(box: Box, slide: { w: number; h: number }): SlotReport["frame"] {
  const [left, right] = [round((box.x / slide.w) * 100), round(((box.x + box.w) / slide.w) * 100)];
  const [top, bottom] = [round((box.y / slide.h) * 100), round(((box.y + box.h) / slide.h) * 100)];
  return { x: left, y: top, w: round(right - left), h: round(bottom - top) };
}

/**
 * A slot may run this many percent past an edge of the slide and be trimmed back to it. PowerPoint's own layouts bleed a
 * picture a hair past the edge (Office's "Content with Picture" layouts run to 100.13%). A slot further out is a slot
 * placed off the slide, which skips the layout.
 */
const BLEED = 0.5;

/** The frame cut back to the slide when it passes an edge by no more than `BLEED`, and by how much it passed. */
export function trimmed(frame: SlotReport["frame"]): { frame: SlotReport["frame"]; by?: number } {
  let { x, y, w, h } = frame;
  let by = 0;
  if (x < 0 && x >= -BLEED) {
    by = Math.max(by, -x);
    w = round(w + x);
    x = 0;
  }
  if (y < 0 && y >= -BLEED) {
    by = Math.max(by, -y);
    h = round(h + y);
    y = 0;
  }
  if (x + w > 100 && x + w <= 100 + BLEED) {
    by = Math.max(by, x + w - 100);
    w = round(100 - x);
  }
  if (y + h > 100 && y + h <= 100 + BLEED) {
    by = Math.max(by, y + h - 100);
    h = round(100 - y);
  }
  return { frame: { x, y, w, h }, ...(by > 0 ? { by: round(by) } : {}) };
}

/**
 * Two slots overlap when their frames share more than this many percent of the slide across and down. PowerPoint's own
 * layouts let neighbors share a pixel or two (Office's "Comparison" does), which is touching, not overlapping. The frames
 * are kept as they are, so Depthcue's own `slots-overlap` warning still shows for such a pair.
 */
const TOUCH = 1;

const overlaps = (a: SlotReport["frame"], b: SlotReport["frame"]): boolean =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > TOUCH &&
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > TOUCH;

/** The master's placeholder a layout's placeholder takes its place from, by kind and then by index. */
function inheritedFrom(shape: Shape, master: readonly Shape[]): Shape | undefined {
  const type = shape.placeholder?.type ?? "obj";
  const same = master.filter(
    (candidate) => candidate.placeholder && familyOf(candidate.placeholder.type) === familyOf(type),
  );
  return (
    same.find(
      (candidate) =>
        shape.placeholder?.idx !== undefined && candidate.placeholder?.idx === shape.placeholder.idx,
    ) ?? same[0]
  );
}

const valignOf = (anchor: string | undefined): TemplateSlot["valign"] =>
  anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : undefined;

/** What a `p:bg` paints: the kind of fill, the color element of a solid one, the picture element of a picture fill. */
export function fillOf(
  bg: XmlNode | undefined,
  theme: Theme,
): { kind?: string; color?: XmlNode; blip?: XmlNode } {
  const fill = child(bg, "bgPr")?.children.find((node) => /Fill$/.test(node.name));
  const reference = child(bg, "bgRef");
  if (fill) {
    return {
      kind: fill.name,
      ...(fill.name === "solidFill" && colorElement(fill) ? { color: colorElement(fill) as XmlNode } : {}),
      ...(fill.name === "blipFill" && child(fill, "blip") ? { blip: child(fill, "blip") as XmlNode } : {}),
    };
  }
  if (reference) {
    // A background from the theme's fill list: the first entry is a plain fill painted in the color given here.
    const kind = theme.backgroundFills[Number(reference.attrs.idx) - 1001];
    return {
      ...(kind ? { kind } : {}),
      ...(kind === "solidFill" && colorElement(reference)
        ? { color: colorElement(reference) as XmlNode }
        : {}),
    };
  }
  return {};
}

/** Where a layout's own background comes from, and which of the brand's colors it is. */
async function backgroundOf(
  layout: Layout,
  ctx: TemplateContext,
  left: Left[],
): Promise<Template["background"] | undefined> {
  const bg = layout.background;
  if (!bg) return undefined;
  const map = layout.map ?? ctx.map;
  const nothing = (why: string): undefined => {
    left.push({ what: `The background of the layout "${layout.name}"`, why });
    return undefined;
  };
  const { kind, color, blip } = fillOf(bg, ctx.theme);
  if (kind === "blipFill") {
    const id = blip?.attrs["r:embed"];
    const part = id ? layout.rels.find((rel) => rel.id === id)?.target : undefined;
    const bytes = part ? await ctx.pkg.bytes(part) : undefined;
    if (!part || !bytes) return nothing("its picture is not in the file");
    const added = ctx.addImage(part, bytes);
    if ("why" in added) return nothing(added.why);
    return { color: "bg", image: added.file, scrim: SCRIM };
  }
  if (kind !== "solidFill") {
    return nothing(
      kind === "noFill" || kind === undefined
        ? "it has no fill this reads"
        : `it is a ${kind.replace(/Fill$/, "")} fill, and a template's background is a plain color or a picture`,
    );
  }
  const resolved = resolveColor(color, ctx.theme, map);
  if (!resolved?.hex || !resolved.plain) {
    return nothing(
      "its color is lightened, darkened or made transparent, or is written in a form this does not read",
    );
  }
  const names = ["bg", "surface", "text", "action", "evidence"] as const;
  const name = names.find((candidate) => ctx.palette[candidate] === resolved.hex);
  if (!name)
    return nothing(
      `its color ${resolved.hex} is not one of the brand's colors (background, panel, text, accent or link)`,
    );
  // The slide's own background needs no entry.
  return name === "bg" ? undefined : { color: name };
}

export async function buildTemplate(
  layout: Layout,
  id: string,
  ctx: TemplateContext,
): Promise<TemplateResult> {
  const left: Left[] = [];
  const generic = new Set<string>();
  const result: TemplateResult = {
    layout: layout.name,
    slots: [],
    left,
    generic: [],
    decoration: {
      shapes: layout.shapes.filter((shape) => shape.kind === "other").length,
      pictures: layout.shapes.filter((shape) => shape.kind === "picture").length,
    },
  };
  // A skipped layout is reported as a whole, so what was left out of its parts is not listed again.
  const skip = (why: string): TemplateResult => ({ ...result, slots: [], left: [], skipped: why });

  const counts = new Map<SlotRole, number>();
  const drafts: Array<{ report: SlotReport; slot: TemplateSlot }> = [];
  let vertical: string | undefined;
  for (const shape of layout.shapes) {
    const type = shape.placeholder?.type;
    if (shape.kind !== "placeholder" || type === undefined || CHROME_TYPES.has(type)) continue;
    const label = `the placeholder "${shape.name || type}" of the layout "${layout.name}"`;
    const inherited = inheritedFrom(shape, ctx.masterShapes);
    const box = shape.box ?? inherited?.box;
    const turned = shape.box ? shape.turned : (inherited?.turned ?? false);
    if (!box) {
      left.push({
        what: label,
        why: "it has no position in the layout, and the master has no placeholder to take one from",
      });
      continue;
    }
    if (turned) {
      left.push({ what: label, why: "it is rotated or flipped, and a slot is an upright box" });
      continue;
    }
    const direction = directionOf(shape) ?? (inherited ? directionOf(inherited) : undefined);
    if (direction !== undefined && direction !== "horz")
      vertical ??= `"${shape.name || type}" (text direction ${direction})`;
    const { frame, by: bleed } = trimmed(frameOf(box, ctx.slide));
    if (bleed)
      left.push({
        what: label,
        why: `it ran ${bleed}% past the edge of the slide, and the part past the edge is cut`,
      });
    if (frame.w < FRAME_MIN || frame.h < FRAME_MIN) {
      left.push({
        what: label,
        why: `it is ${frame.w}% by ${frame.h}% of the slide, under the ${FRAME_MIN}% a slot must be`,
      });
      continue;
    }
    const known = Object.hasOwn(SLOT_OF, type) ? SLOT_OF[type] : undefined;
    if (!known) generic.add(type);
    const { role, accepts } = known ?? CONTENT;
    const count = (counts.get(role) ?? 0) + 1;
    counts.set(role, count);
    const prompt = promptOf(shape);
    const hint = (prompt && !STOCK_PROMPT.test(prompt) ? prompt : HINTS[role]).slice(0, BRAND_LIMITS.hint);
    const valign = valignOf(anchorOf(shape) ?? (inherited ? anchorOf(inherited) : undefined));
    const slotId = count === 1 ? role : `${role}-${count}`;
    const slot: TemplateSlot = {
      id: slotId,
      role,
      frame,
      accepts: [...accepts],
      ...(role === "title" ? { required: true } : {}),
      ...(valign ? { valign } : {}),
      hint,
    };
    drafts.push({
      slot,
      report: {
        id: slotId,
        role,
        accepts: [...accepts],
        frame,
        ...(valign ? { valign } : {}),
        hint,
        placeholder: type,
      },
    });
  }
  result.generic = [...generic];

  if (vertical)
    return skip(`the placeholder ${vertical} runs its text vertically, which Depthcue does not draw`);
  if (drafts.length === 0) return skip("it has no placeholder a slot can be made from (a blank layout)");
  if (drafts.length > BRAND_LIMITS.slots) {
    return skip(
      `it has ${drafts.length} placeholders, and a template holds at most ${BRAND_LIMITS.slots} slots`,
    );
  }
  for (const { report } of drafts) {
    const { x, y, w, h } = report.frame;
    if (x < 0 || y < 0 || x + w > 100 || y + h > 100) {
      return skip(
        `the slot "${report.id}" runs off the slide (to ${round(x + w)}% across and ${round(y + h)}% down), and a slot must lie on it`,
      );
    }
  }
  for (const [at, { report }] of drafts.entries()) {
    const other = drafts.slice(0, at).find((earlier) => overlaps(earlier.report.frame, report.frame));
    if (other)
      return skip(`the slots "${other.report.id}" and "${report.id}" overlap, and a template's slots do not`);
  }

  const background = await backgroundOf(layout, ctx, left);
  const template: Template = {
    schemaVersion: "0.4",
    id,
    name: layout.name.slice(0, BRAND_LIMITS.styleName).trim() || id,
    description:
      `The PowerPoint layout "${layout.name}", with the slots ${drafts.map(({ slot }) => slot.id).join(", ")}.`.slice(
        0,
        BRAND_LIMITS.description,
      ),
    ...(background ? { background } : {}),
    ...(layout.showsMasterShapes ? {} : { chrome: "none" as const }),
    slots: drafts.map(({ slot }) => slot),
  };
  return { ...result, template, slots: drafts.map(({ report }) => report) };
}
