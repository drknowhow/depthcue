/**
 * A branded deck's slide master and layouts, written into the package after the writer has made the slides. The
 * brand's chrome is the master: the background, the logo, the footer line, PowerPoint's own slide-number field and the
 * accent bar. Each template the scenes use is a layout named after it, with a placeholder at each slot's frame, typed
 * by the slot's role and prompting with the slot's hint, and showing as much of the chrome as the template says. A
 * template scene's slide uses its layout, and the first block in each slot is that slot's placeholder, so PowerPoint's
 * Reset puts it back in the slot. Scenes on built-in layouts use a blank layout that shows the chrome. A picture slide
 * (`--pictures`) uses a layout of its own with a title placeholder, which the slide keeps hidden.
 *
 * The writer's master support cannot do this (one master, no placeholder types, no fields), so the parts are written
 * here, as plain XML, the same way every time.
 */
import type { Block, DeckLook, Scene, Template, TemplateSlot } from "@depthcue/core";
import { PICTURE_TITLE } from "./build.ts";
import type { Box, ChromeMeasure, Ink, Item, SlideMeasure, TextPlace } from "./measure.ts";

type Parts = Map<string, Uint8Array>;

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELS_OPEN = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const LAYOUT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
/** The slide-number field's id: any GUID will do, and a fixed one keeps the bytes the same. */
const NUMBER_FIELD = "{5C1D2E5A-7F1B-4C55-9A57-DE97C0E1A001}";
/** The logo's picture part, shared by the master and any layout that draws its own copy. */
const LOGO_PART = "ppt/media/depthcue-logo.png";

/** Placeholder numbers: the master's body, footer and number, a layout's footer and number, and the first slot's. */
export const IDX = {
  masterBody: 1,
  masterFooter: 3,
  masterNumber: 4,
  footer: 11,
  number: 12,
  slot: 13,
} as const;

const emu = (px: number) => Math.round(px * 9525);
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const bare = (color: string) => color.replace("#", "").toUpperCase();
const fill = (color: string) => `<a:solidFill><a:srgbClr val="${bare(color)}"/></a:solidFill>`;
const xfrm = (box: Box) =>
  `<a:xfrm><a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${emu(Math.max(1, box.w))}" cy="${emu(Math.max(1, box.h))}"/></a:xfrm>`;
const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const rels = (entries: readonly string[]) => `${XML_HEAD}${RELS_OPEN}${entries.join("")}</Relationships>`;
const relationship = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`;

/**
 * The placeholder type a slot's role is kept as. A layout has one title, which has no number: the first title slot, or
 * the first claim slot when no slot is a title. Every other title or claim slot is a numbered body placeholder.
 */
export type PlaceholderType = "title" | "body" | "subTitle" | "pic" | "chart" | "tbl" | "obj";

export function placeholderType(slot: TemplateSlot, template: Template): PlaceholderType {
  switch (slot.role) {
    case "title":
    case "claim": {
      const title =
        template.slots.find((other) => other.role === "title") ??
        template.slots.find((other) => other.role === "claim");
      return title?.id === slot.id ? "title" : "body";
    }
    case "subtitle":
      return "subTitle";
    case "body":
      return "body";
    case "picture":
      return "pic";
    case "chart":
      return "chart";
    case "table":
      return "tbl";
    default:
      return "obj";
  }
}

/** A placeholder's `<p:ph>` attributes. A title has no number; the rest are numbered so a slide finds its own. */
const phAttributes = (type: PlaceholderType, idx: number) =>
  type === "title" ? 'type="title"' : type === "obj" ? `idx="${idx}"` : `type="${type}" idx="${idx}"`;

type Drawn = "text" | "picture" | "chart" | "table";

/** Which placeholders a drawn block may fill: words go in a text one, a chart in a chart one, and so on. */
function fits(type: PlaceholderType, kind: Drawn): boolean {
  if (type === "obj") return true;
  if (kind === "text") return type === "title" || type === "body" || type === "subTitle";
  if (kind === "picture") return type === "pic";
  if (kind === "chart") return type === "chart";
  return type === "tbl";
}

/** What a block is drawn as on the slide, for choosing a placeholder; nothing for what has no placeholder (a clip). */
function drawnKind(block: Block | undefined): Drawn | undefined {
  if (!block) return undefined;
  if (block.type === "text") return "text";
  if (block.type === "image") return "picture";
  if (block.type === "chart" || block.type === "bar-chart") return "chart";
  if (block.type === "table") return "table";
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// The plan: which layouts there are, and what each slide links to.
// ---------------------------------------------------------------------------------------------------------------------

interface SlotPlan {
  slot: TemplateSlot;
  type: PlaceholderType;
  idx: number;
  /** How the first block in the slot is drawn on the first slide of the template, for the placeholder's text. */
  ink?: Ink;
}

interface LayoutPlan {
  name: string;
  template?: Template;
  chrome: "full" | "minimal" | "none";
  ground: string;
  backdrop?: string;
  /** Its ground is not the deck's, so the chrome is drawn as the page draws it there: the logo on its plate. */
  strong: boolean;
  /** The chrome as the page drew it on the first slide of this layout. */
  measured?: ChromeMeasure;
  slots: SlotPlan[];
  picture: boolean;
}

export interface MasterInput {
  look: DeckLook;
  /** One per slide, in order, with what the page measured for it. */
  scenes: readonly Scene[];
  measures: readonly SlideMeasure[];
  /** Each slide is one picture (`--pictures`). */
  pictures: boolean;
  /** The slide number each slide shows; its place in the file when left out. */
  numbers?: readonly number[];
}

/** The first block in each slot, by slot id: the claim in the claim slot, and the first unpinned block in the others. */
export function firstInSlots(scene: Scene, template: Template): Map<string, string> {
  const first = new Map<string, string>();
  const claim = template.slots.find((slot) => slot.role === "claim");
  if (claim && scene.summary) first.set(claim.id, scene.summary.id);
  for (const block of scene.blocks) {
    if (block.frame || block.slot === undefined || first.has(block.slot)) continue;
    if (template.slots.some((slot) => slot.id === block.slot && slot.role !== "claim"))
      first.set(block.slot, block.id);
  }
  return first;
}

/** How a measured text item is drawn, by its block id. */
function textInk(measure: SlideMeasure, id: string): TextPlace | undefined {
  for (const item of measure.items) {
    if (item.kind === "text" && item.id === id) return item.text;
  }
  return undefined;
}

const claimInk = (measure: SlideMeasure): TextPlace | undefined =>
  (measure.items.find((item) => item.kind === "claim") as Extract<Item, { kind: "claim" }> | undefined)?.text;

const sameColor = (a: string | undefined, b: string) => a === undefined || bare(a) === bare(b);

/**
 * The chrome to draw on the master: each part from the first slide that shows it on the deck's own ground, a scene on
 * a built-in layout before a template's. The logo goes without its plate, which only a strong ground has.
 */
function masterChrome(
  look: DeckLook,
  scenes: readonly Scene[],
  measures: readonly SlideMeasure[],
): ChromeMeasure {
  const rank = (measure: SlideMeasure, at: number) =>
    (scenes[at]?.template === undefined ? 0 : 2) +
    (sameColor(measure.ground, look.colors.bg) && measure.backdrop === undefined ? 0 : 1);
  const order = measures
    .map((measure, at) => ({ measure, rank: rank(measure, at) }))
    .sort((a, b) => a.rank - b.rank);
  const chrome: ChromeMeasure = {};
  for (const { measure } of order) {
    const found = measure.chrome;
    if (!found) continue;
    if (!chrome.logo && found.logo?.png)
      chrome.logo = { box: found.logo.box, png: found.logo.png, alt: found.logo.alt };
    if (!chrome.footer && found.footer) chrome.footer = found.footer;
    if (!chrome.number && found.number) chrome.number = found.number;
    if (!chrome.accent && found.accent) chrome.accent = found.accent;
  }
  return chrome;
}

// ---------------------------------------------------------------------------------------------------------------------
// XML.
// ---------------------------------------------------------------------------------------------------------------------

/** A size in hundredths of a point, from CSS pixels. */
const hundredths = (px: number) => Math.max(100, Math.round(px * 75));

/** A text style from what the page measured: size, weight, slant, color, face and letter spacing. */
function runStyle(ink: Ink | undefined, tag = "a:defRPr"): string {
  if (!ink) return `<${tag} lang="en-US"/>`;
  const spacing = ink.spacing ? ` spc="${Math.round(ink.spacing * 75)}"` : "";
  const face = escapeXml(ink.family);
  return `<${tag} lang="en-US" sz="${hundredths(ink.px)}"${ink.weight >= 600 ? ' b="1"' : ""}${ink.italic ? ' i="1"' : ""}${ink.caps ? ' cap="all"' : ""}${spacing}>${fill(ink.color)}<a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/></${tag}>`;
}

const ALIGN = { left: "l", center: "ctr", right: "r", justify: "just" } as const;
const ANCHOR = { top: "t", middle: "ctr", bottom: "b" } as const;

interface PlaceholderOptions {
  id: number;
  name: string;
  ph: string;
  box?: Box;
  anchor?: string;
  wrap?: boolean;
  ink?: Ink;
  align?: string;
  prompt?: string;
  field?: boolean;
}

function placeholder(options: PlaceholderOptions): string {
  const { ink } = options;
  if (!options.box) {
    // A layout's copy of a master placeholder: its place and look come from the master's.
    const text = options.field
      ? `<a:fld id="${NUMBER_FIELD}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld>`
      : "";
    return `<p:sp><p:nvSpPr><p:cNvPr id="${options.id}" name="${escapeXml(options.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${options.ph}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${text}<a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
  }
  const spacing = ink ? `<a:lnSpc><a:spcPts val="${Math.round(ink.lineHeight * 75)}"/></a:lnSpc>` : "";
  const level = `<a:lvl1pPr marL="0" indent="0"${options.align ? ` algn="${options.align}"` : ""}>${spacing}<a:buNone/>${runStyle(ink)}</a:lvl1pPr>`;
  const body = options.field
    ? `<a:fld id="${NUMBER_FIELD}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld>`
    : options.prompt
      ? `<a:r><a:rPr lang="en-US"/><a:t>${escapeXml(options.prompt)}</a:t></a:r>`
      : "";
  const shape = options.box ? xfrm(options.box) : "";
  const bodyPr = `<a:bodyPr vert="horz" wrap="${options.wrap === false ? "none" : "square"}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${options.anchor ?? "t"}" anchorCtr="0"><a:noAutofit/></a:bodyPr>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${options.id}" name="${escapeXml(options.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${options.ph}/></p:nvPr></p:nvSpPr><p:spPr>${shape}</p:spPr><p:txBody>${bodyPr}<a:lstStyle>${level}</a:lstStyle><a:p>${body}<a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}

/**
 * A footer or number box: as wide as the slide allows on the side its text grows to, so a longer line or number still
 * fits where the page put the short one.
 */
function footBox(place: TextPlace, slide: { w: number; h: number }): { box: Box; align: string } {
  const { box, ink } = place;
  const room = Math.min(slide.w * 0.45, Math.max(box.w * 2, box.w + 120));
  if (ink.align === "right" || box.x + box.w > slide.w * 0.66) {
    return { box: { x: box.x + box.w - room, y: box.y, w: room, h: box.h }, align: "r" };
  }
  if (box.x + box.w / 2 > slide.w * 0.34) {
    return { box: { x: box.x + box.w / 2 - room / 2, y: box.y, w: room, h: box.h }, align: "ctr" };
  }
  return { box: { x: box.x, y: box.y, w: room, h: box.h }, align: "l" };
}

/** The accent bar, the plate behind the logo and the logo, as shapes, numbered from `firstId`. */
function chromeShapes(
  chrome: ChromeMeasure,
  options: { accent: boolean; logo: boolean; firstId: number },
): string {
  let id = options.firstId;
  let out = "";
  if (options.accent && chrome.accent) {
    out += `<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Accent bar"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr>${xfrm(chrome.accent.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill(chrome.accent.color)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
  }
  const logo = chrome.logo;
  if (logo && options.logo) {
    const plate = logo.plate;
    if (plate) {
      const adjust = Math.min(
        50000,
        Math.round((plate.radius / Math.max(1, Math.min(plate.box.w, plate.box.h))) * 100000),
      );
      out += `<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="Logo plate"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr>${xfrm(plate.box)}<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adjust}"/></a:avLst></a:prstGeom>${fill(plate.color)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
    }
    out += `<p:pic><p:nvPicPr><p:cNvPr id="${id++}" name="Logo" descr="${escapeXml(logo.alt)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr userDrawn="1"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(logo.box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  }
  return out;
}

function background(ground: string, imageRel?: string): string {
  return imageRel
    ? `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${imageRel}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`
    : `<p:bg><p:bgPr>${fill(ground)}<a:effectLst/></p:bgPr></p:bg>`;
}

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** The master's text styles: no bullets, single spacing, the deck's faces and text color. */
function textStyles(major: string, minor: string): string {
  const level = (n: number, size: number, face: string) =>
    `<a:lvl${n}pPr marL="${(n - 1) * 457200}" indent="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef><a:buNone/><a:defRPr sz="${size}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/></a:defRPr></a:lvl${n}pPr>`;
  const body = LEVELS.map((n) => level(n, 1800, minor)).join("");
  return `<p:txStyles><p:titleStyle>${level(1, 3600, major)}</p:titleStyle><p:bodyStyle>${body}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${body}</p:otherStyle></p:txStyles>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The slides' side.
// ---------------------------------------------------------------------------------------------------------------------

const regexText = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SHAPE = /<p:(sp|pic|graphicFrame)>(?:(?!<p:(?:sp|pic|graphicFrame)>)[\s\S])*?<\/p:\1>/g;

/** Puts a placeholder on the slide's shape named `name`: the first `p:sp`, `p:pic` or `p:graphicFrame` of that name. */
export function linkShape(xml: string, name: string, ph: string): string {
  const named = new RegExp(`<p:cNvPr id="\\d+" name="${regexText(escapeXml(name))}"`);
  let done = false;
  return xml.replace(SHAPE, (whole, kind: string) => {
    if (done || !named.test(whole)) return whole;
    done = true;
    let out = whole.replace(/<p:nvPr\/>|<p:nvPr>/, (open) =>
      open === "<p:nvPr/>" ? `<p:nvPr><p:ph ${ph}/></p:nvPr>` : `<p:nvPr><p:ph ${ph}/>`,
    );
    if (kind === "sp") out = out.replace("<p:cNvSpPr/>", '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>');
    else if (kind === "pic") out = out.replace("<a:picLocks ", '<a:picLocks noGrp="1" ');
    else {
      out = out.replace(
        "<p:cNvGraphicFramePr/>",
        '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>',
      );
    }
    return out;
  });
}

/**
 * Adds a description to the slide's shape named `name`, which the writer has no option for on a video. An empty one
 * empties the description of a decorative picture, where the writer puts the file's name for an empty alt text.
 */
export function describeShape(xml: string, name: string, text: string): string {
  const shape = `(<p:cNvPr id="\\d+" name="${regexText(escapeXml(name))}")`;
  if (text === "") return xml.replace(new RegExp(`${shape} descr="[^"]*"`), '$1 descr=""');
  return xml.replace(new RegExp(`${shape}(?![^>]*\\bdescr=)`), `$1 descr="${escapeXml(text)}"`);
}

/** The slide's own footer and number, filling the layout's: the words, and the field PowerPoint numbers each slide by. */
function footShapes(chrome: ChromeMeasure, number: number, footer: string | undefined): string {
  let out = "";
  if (chrome.footer && footer) {
    out += `<p:sp><p:nvSpPr><p:cNvPr id="9001" name="Footer"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ftr" sz="quarter" idx="${IDX.footer}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r>${runStyle(chrome.footer.ink, "a:rPr")}<a:t>${escapeXml(footer)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  }
  if (chrome.number) {
    out += `<p:sp><p:nvSpPr><p:cNvPr id="9002" name="Slide number"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="${IDX.number}"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="${NUMBER_FIELD}" type="slidenum">${runStyle(chrome.number.ink, "a:rPr")}<a:t>${number}</a:t></a:fld></a:p></p:txBody></p:sp>`;
  }
  return out;
}

/** The theme's colors from the deck's: text on background, the action and evidence colors, then the chart's. */
function themed(theme: string, look: DeckLook, link: string | undefined): string {
  const { colors } = look;
  const chart = look.chart.length > 0 ? look.chart : [colors.action, colors.evidence, colors.state];
  const pick = (at: number) => chart[at % chart.length] as string;
  const scheme: Array<[string, string]> = [
    ["dk1", colors.text],
    ["lt1", colors.bg],
    ["dk2", colors.muted],
    ["lt2", colors.surface],
    ["accent1", colors.action],
    ["accent2", colors.evidence],
    ["accent3", pick(0)],
    ["accent4", pick(1)],
    ["accent5", pick(2)],
    ["accent6", colors.line],
    ["hlink", link ?? colors.action],
    ["folHlink", colors.muted],
  ];
  let out = theme;
  for (const [name, color] of scheme) {
    out = out.replace(
      new RegExp(`<a:${name}>[\\s\\S]*?</a:${name}>`),
      `<a:${name}><a:srgbClr val="${bare(color)}"/></a:${name}>`,
    );
  }
  return out.replace(/<a:clrScheme name="[^"]*">/, `<a:clrScheme name="Depthcue ${escapeXml(look.theme)}">`);
}

/** A data URL's bytes. */
const dataBytes = (url: string) => new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));

// ---------------------------------------------------------------------------------------------------------------------
// Writing it.
// ---------------------------------------------------------------------------------------------------------------------

function planLayouts(input: MasterInput): { layouts: LayoutPlan[]; layoutOf: number[] } {
  const { look, scenes, measures } = input;
  const layouts: LayoutPlan[] = [
    input.pictures
      ? { name: "Picture", chrome: "none", ground: look.colors.bg, strong: false, slots: [], picture: true }
      : { name: "Blank", chrome: "full", ground: look.colors.bg, strong: false, slots: [], picture: false },
  ];
  const layoutOf: number[] = [];
  const byTemplate = new Map<string, number>();
  scenes.forEach((scene, at) => {
    const id = scene.template;
    const template = id === undefined ? undefined : look.templates[id];
    if (input.pictures || id === undefined || !template) {
      layoutOf.push(0);
      return;
    }
    const known = byTemplate.get(id);
    if (known !== undefined) {
      layoutOf.push(known);
      return;
    }
    const measure = measures[at] as SlideMeasure;
    const fills = firstInSlots(scene, template);
    const slots = template.slots.map((slot, index): SlotPlan => {
      const block = fills.get(slot.id);
      const place =
        block === undefined
          ? undefined
          : block === scene.summary?.id
            ? claimInk(measure)
            : textInk(measure, block);
      return {
        slot,
        type: placeholderType(slot, template),
        idx: IDX.slot + index,
        ...(place ? { ink: place.ink } : {}),
      };
    });
    const ground = measure.ground ?? look.colors.bg;
    layouts.push({
      name: template.name,
      template,
      chrome: template.chrome ?? "full",
      ground,
      ...(measure.backdrop ? { backdrop: measure.backdrop } : {}),
      strong: !sameColor(ground, look.colors.bg) || measure.backdrop !== undefined,
      ...(measure.chrome ? { measured: measure.chrome } : {}),
      slots,
      picture: false,
    });
    byTemplate.set(id, layouts.length - 1);
    layoutOf.push(layouts.length - 1);
  });
  return { layouts, layoutOf };
}

/**
 * The chrome a layout draws itself, when it cannot show the master's: on a strong ground the logo sits on its plate (and
 * the footer may take another color), and a minimal template shows the logo alone. Nothing when the master's will do.
 */
function ownChrome(layout: LayoutPlan, master: ChromeMeasure): ChromeMeasure | undefined {
  if (layout.picture || layout.chrome === "none") return undefined;
  if (layout.chrome === "full" && !layout.strong) return undefined;
  const measured = layout.measured ?? {};
  const logo = measured.logo ?? master.logo;
  const footer = measured.footer ?? master.footer;
  const number = measured.number ?? master.number;
  const accent = measured.accent ?? master.accent;
  return {
    ...(logo ? { logo: { box: logo.box, alt: logo.alt, ...(logo.plate ? { plate: logo.plate } : {}) } } : {}),
    ...(footer ? { footer } : {}),
    ...(number ? { number } : {}),
    ...(accent ? { accent } : {}),
  };
}

/** Writes the master, the layouts and each slide's links into the package. Returns the layouts' names, in order. */
export function applyMaster(parts: Parts, input: MasterInput): { layouts: string[] } {
  const { look, scenes, measures } = input;
  const first = measures[0];
  if (!first) return { layouts: [] };
  const slide = first.slide;
  const chrome = input.pictures ? {} : masterChrome(look, scenes, measures);
  const { layouts, layoutOf } = planLayouts(input);

  const logo = chrome.logo?.png !== undefined;
  if (chrome.logo?.png) parts.set(LOGO_PART, dataBytes(chrome.logo.png));
  const major = escapeXml(first.fonts.display || "+mj-lt");
  const minor = escapeXml(first.fonts.body || "+mn-lt");

  // The master: the deck's ground, title and text placeholders, the footer and number, and the brand's marks.
  const titleBox: Box = { x: slide.w * 0.06, y: slide.h * 0.07, w: slide.w * 0.88, h: slide.h * 0.16 };
  const bodyBox: Box = { x: slide.w * 0.06, y: slide.h * 0.27, w: slide.w * 0.88, h: slide.h * 0.6 };
  let shapes =
    placeholder({ id: 2, name: "Title", ph: 'type="title"', box: titleBox, anchor: "b", prompt: "Title" }) +
    placeholder({
      id: 3,
      name: "Text",
      ph: `type="body" idx="${IDX.masterBody}"`,
      box: bodyBox,
      prompt: "Text",
    });
  let id = 4;
  if (chrome.footer) {
    const { box, align } = footBox(chrome.footer, slide);
    shapes += placeholder({
      id: id++,
      name: "Footer",
      ph: `type="ftr" sz="quarter" idx="${IDX.masterFooter}"`,
      box,
      anchor: "b",
      wrap: false,
      ink: chrome.footer.ink,
      align,
      prompt: chrome.footer.text,
    });
  }
  if (chrome.number) {
    const { box, align } = footBox(chrome.number, slide);
    shapes += placeholder({
      id: id++,
      name: "Slide number",
      ph: `type="sldNum" sz="quarter" idx="${IDX.masterNumber}"`,
      box,
      anchor: "b",
      wrap: false,
      ink: chrome.number.ink,
      align,
      field: true,
    });
  }
  shapes += chromeShapes(chrome, { accent: true, logo, firstId: id });
  const layoutIds = layouts
    .map((_layout, at) => `<p:sldLayoutId id="${2147483649 + at}" r:id="rId${at + 1}"/>`)
    .join("");
  const footing = `<p:hf hdr="0" dt="0"${chrome.footer ? "" : ' ftr="0"'}${chrome.number ? "" : ' sldNum="0"'}/>`;
  parts.set(
    "ppt/slideMasters/slideMaster1.xml",
    encode(
      `${XML_HEAD}<p:sldMaster ${NS}><p:cSld>${background(look.colors.bg)}<p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${layoutIds}</p:sldLayoutIdLst>${footing}${textStyles(major, minor)}</p:sldMaster>`,
    ),
  );
  parts.set(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    encode(
      rels([
        ...layouts.map((_layout, at) =>
          relationship(`rId${at + 1}`, "slideLayout", `../slideLayouts/slideLayout${at + 1}.xml`),
        ),
        relationship(`rId${layouts.length + 1}`, "theme", "../theme/theme1.xml"),
        ...(logo ? [relationship("rIdLogo", "image", "../media/depthcue-logo.png")] : []),
      ]),
    ),
  );

  // The layouts.
  let types = decode(parts.get("[Content_Types].xml") as Uint8Array);
  const owns: Array<ChromeMeasure | undefined> = [];
  layouts.forEach((layout, at) => {
    const number = at + 1;
    const links = [relationship("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")];
    let body = "";
    let next = 2;
    if (layout.picture) {
      body += placeholder({
        id: next++,
        name: "Title",
        ph: 'type="title"',
        box: titleBox,
        anchor: "b",
        prompt: "Scene title",
      });
    }
    for (const plan of layout.slots) {
      const { frame } = plan.slot;
      const box: Box = {
        x: (frame.x / 100) * slide.w,
        y: (frame.y / 100) * slide.h,
        w: (frame.w / 100) * slide.w,
        h: (frame.h / 100) * slide.h,
      };
      const words =
        plan.type === "title" || plan.type === "body" || plan.type === "subTitle" || plan.type === "obj";
      body += placeholder({
        id: next++,
        name: plan.slot.id,
        ph: `${phAttributes(plan.type, plan.idx)} hasCustomPrompt="1"`,
        box,
        anchor: ANCHOR[plan.slot.valign ?? "top"],
        ...(words && plan.ink ? { ink: plan.ink, align: ALIGN[plan.ink.align] } : {}),
        prompt: plan.slot.hint,
      });
    }
    // The chrome: the master's own when the layout shows all of it on the deck's ground; else the layout's own copy of
    // what it shows, as the page draws it there, with the master's hidden.
    const own = ownChrome(layout, chrome);
    owns.push(own);
    if (own) {
      body += chromeShapes(own, { accent: layout.chrome === "full", logo, firstId: next });
      next += 3;
      if (logo) links.push(relationship("rIdLogo", "image", "../media/depthcue-logo.png"));
    }
    if (layout.chrome === "full") {
      const feet = own ?? chrome;
      if (feet.footer) {
        const { box, align } = footBox(feet.footer, slide);
        body += placeholder({
          id: next++,
          name: "Footer",
          ph: `type="ftr" sz="quarter" idx="${IDX.footer}"`,
          ...(own ? { box, align, ink: feet.footer.ink, anchor: "b", wrap: false } : {}),
        });
      }
      if (feet.number) {
        const { box, align } = footBox(feet.number, slide);
        body += placeholder({
          id: next++,
          name: "Slide number",
          ph: `type="sldNum" sz="quarter" idx="${IDX.number}"`,
          field: true,
          ...(own ? { box, align, ink: feet.number.ink, anchor: "b", wrap: false } : {}),
        });
      }
    }
    let ground = "";
    if (layout.backdrop) {
      const media = `ppt/media/depthcue-layout${number}.jpeg`;
      parts.set(media, dataBytes(layout.backdrop));
      links.push(relationship("rIdBackdrop", "image", `../media/depthcue-layout${number}.jpeg`));
      ground = background(layout.ground, "rIdBackdrop");
    } else if (!sameColor(layout.ground, look.colors.bg)) {
      ground = background(layout.ground);
    }
    const show = layout.chrome === "full" && !own ? "" : ' showMasterSp="0"';
    parts.set(
      `ppt/slideLayouts/slideLayout${number}.xml`,
      encode(
        `${XML_HEAD}<p:sldLayout ${NS} preserve="1" userDrawn="1"${show}><p:cSld name="${escapeXml(layout.name)}">${ground}<p:spTree>${GROUP}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
      ),
    );
    parts.set(`ppt/slideLayouts/_rels/slideLayout${number}.xml.rels`, encode(rels(links)));
    const part = `/ppt/slideLayouts/slideLayout${number}.xml`;
    if (!types.includes(`PartName="${part}"`)) {
      types = types.replace(
        "</Types>",
        `<Override PartName="${part}" ContentType="${LAYOUT_TYPE}"/></Types>`,
      );
    }
  });
  if (!types.includes('Extension="jpeg"') && layouts.some((layout) => layout.backdrop)) {
    types = types.replace(/(<Types\b[^>]*>)/, '$1<Default Extension="jpeg" ContentType="image/jpeg"/>');
  }
  if (!types.includes('Extension="png"') && logo) {
    types = types.replace(/(<Types\b[^>]*>)/, '$1<Default Extension="png" ContentType="image/png"/>');
  }
  parts.set("[Content_Types].xml", encode(types));

  // The slides: each on its layout, its first block in each slot that slot's placeholder, and its footer and number.
  scenes.forEach((scene, at) => {
    const name = `ppt/slides/slide${at + 1}.xml`;
    const relsName = `ppt/slides/_rels/slide${at + 1}.xml.rels`;
    const layoutAt = layoutOf[at] ?? 0;
    const layout = layouts[layoutAt] as LayoutPlan;
    const links = parts.get(relsName);
    if (links) {
      parts.set(
        relsName,
        encode(
          decode(links).replace(
            /slideLayouts\/slideLayout\d+\.xml/,
            `slideLayouts/slideLayout${layoutAt + 1}.xml`,
          ),
        ),
      );
    }
    const bytes = parts.get(name);
    if (!bytes) return;
    let xml = decode(bytes);
    if (layout.picture) {
      xml = linkShape(xml, PICTURE_TITLE, 'type="title"').replace(
        new RegExp(`(<p:cNvPr id="\\d+" name="${regexText(PICTURE_TITLE)}")`),
        '$1 hidden="1"',
      );
    } else if (layout.template) {
      const fills = firstInSlots(scene, layout.template);
      const blocks = new Map(scene.blocks.map((block) => [block.id, block]));
      for (const plan of layout.slots) {
        const block = fills.get(plan.slot.id);
        if (block === undefined) continue;
        const kind = block === scene.summary?.id ? "text" : drawnKind(blocks.get(block));
        if (!kind || !fits(plan.type, kind)) continue;
        xml = linkShape(xml, block, phAttributes(plan.type, plan.idx));
      }
    }
    if (layout.chrome === "full" && !layout.picture) {
      const feet = owns[layoutAt] ?? chrome;
      const foot = footShapes(feet, input.numbers?.[at] ?? at + 1, look.chrome?.footer?.text);
      if (foot) xml = xml.replace("</p:spTree>", `${foot}</p:spTree>`);
    }
    parts.set(name, encode(xml));
  });

  const theme = parts.get("ppt/theme/theme1.xml");
  if (theme && !input.pictures)
    parts.set("ppt/theme/theme1.xml", encode(themed(decode(theme), look, first.link)));
  return { layouts: layouts.map((layout) => layout.name) };
}
