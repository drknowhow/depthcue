/**
 * A text block's words as PowerPoint text. The words, marks, links and lists come from the deck through core's markup
 * parser, so what PowerPoint gets is the source and not what the page happened to draw; how big, in which face and in
 * which color comes from the page's measurements.
 */
import type { Flow, Span } from "@depthcue/core";
import type PptxGenJS from "pptxgenjs";
import type { Box, Ink, TextPlace } from "./measure.ts";

export type Run = PptxGenJS.TextProps;
type Options = NonNullable<Run["options"]>;

/** Points in a CSS pixel: the slide is 96 pixels to the inch and a point is 1/72 inch. */
export const POINT = 0.75;
export const pt = (px: number): number => Math.round(px * POINT * 100) / 100;
/** Inches, which is what the writer places things in. */
export const inch = (px: number): number => px / 96;

/** The deck-wide facts a run needs. */
export interface RunContext {
  /** The color of each tone, as the page draws it. */
  tones: Readonly<Record<string, string>>;
  /** The color of a link, as the page draws it. */
  link: string;
  /** The deck's language, which marks the text for spell checking. */
  language: string;
}

/** Marks a run whose capitals the stylesheet draws; the package step turns this into PowerPoint's "all caps". */
export const CAPS_MARK = "~caps";
/** Marks a bulleted paragraph's first run with the color its marker takes: `~bu=RRGGBB`. */
export const BULLET_MARK = "~bu=";

/** The options every run of a text takes from how the page draws it. */
export function inkOptions(ink: Ink, context: RunContext): Options {
  return {
    fontFace: ink.family,
    fontSize: pt(ink.px),
    color: ink.color,
    lang: ink.caps ? `${context.language}${CAPS_MARK}` : context.language,
    ...(ink.weight >= 600 ? { bold: true } : {}),
    ...(ink.italic ? { italic: true } : {}),
    ...(ink.spacing === 0 ? {} : { charSpacing: Math.round(ink.spacing * POINT * 100) / 100 }),
  };
}

interface Format {
  bold?: true;
  italic?: true;
  color?: string;
  link?: string;
}

interface Piece {
  text: string;
  format: Format;
}

function pieces(spans: readonly Span[], format: Format, context: RunContext, into: Piece[]): Piece[] {
  for (const span of spans) {
    if (span.type === "text") into.push({ text: span.text, format });
    else if (span.type === "strong") pieces(span.children, { ...format, bold: true }, context, into);
    else if (span.type === "em") pieces(span.children, { ...format, italic: true }, context, into);
    else if (span.type === "link")
      pieces(span.children, { ...format, link: span.href, color: context.link }, context, into);
    else
      pieces(
        span.children,
        { ...format, color: context.tones[span.tone] ?? format.color ?? "" },
        context,
        into,
      );
  }
  return into;
}

/** What one paragraph needs besides its runs. */
interface Paragraph {
  spans: readonly Span[];
  /** Space above, in points. */
  before: number;
  bullet?: Options["bullet"];
}

/**
 * The runs of one paragraph. Its paragraph-level options go on the first run and its alignment on every run, which is
 * how the writer tells where a paragraph ends: only a run with `breakLine` does that. A line break inside a paragraph
 * is a soft break before the run that follows it.
 */
function paragraphRuns(
  paragraph: Paragraph,
  ink: Ink,
  context: RunContext,
  align: NonNullable<Options["align"]>,
  last: boolean,
): Run[] {
  const base = inkOptions(ink, context);
  const runs: Run[] = [];
  for (const piece of pieces(paragraph.spans, {}, context, [])) {
    piece.text.split("\n").forEach((part, at) => {
      const options: Options = {
        ...base,
        align,
        ...(piece.format.bold ? { bold: true } : {}),
        ...(piece.format.italic ? { italic: true } : {}),
        ...(piece.format.color ? { color: piece.format.color } : {}),
        ...(piece.format.link ? { hyperlink: { url: piece.format.link } } : {}),
        ...(at > 0 ? { softBreakBefore: true } : {}),
      };
      runs.push({ text: part, options });
    });
  }
  if (runs.length === 0) runs.push({ text: "", options: { ...base, align } });
  const first = (runs[0] as Run).options as Options;
  first.lineSpacing = pt(ink.lineHeight);
  if (paragraph.before > 0) first.paraSpaceBefore = paragraph.before;
  if (paragraph.bullet) {
    first.bullet = paragraph.bullet;
    // The marker takes the color of the paragraph's first run, and a toned first word would tone it. The package step
    // reads this and gives the marker the text's own color.
    first.lang = `${first.lang ?? context.language}${BULLET_MARK}${ink.color}`;
  }
  if (!last) ((runs[runs.length - 1] as Run).options as Options).breakLine = true;
  return runs;
}

/** The gap between paragraphs, and between list items, in em, as the stylesheet sets them. */
const PARAGRAPH_GAP = 0.6;
const ITEM_GAP = 0.25;
/** A list's indent, in em. */
const LIST_INDENT = 1.4;

/**
 * Paragraphs and lists as runs. A list item is its own paragraph with a bullet or a number, hanging by the indent the
 * page uses; the items of a numbered list share the number they count up from, so PowerPoint numbers them in a row.
 */
export function flowRuns(flow: readonly Flow[], ink: Ink, context: RunContext): Run[] {
  const paragraphs: Paragraph[] = [];
  const em = ink.px * POINT;
  flow.forEach((part, index) => {
    const gap = index > 0 ? PARAGRAPH_GAP * em : 0;
    if (part.type === "paragraph") {
      paragraphs.push({ spans: part.children, before: gap });
      return;
    }
    const indent = Math.round(LIST_INDENT * em * 100) / 100;
    part.items.forEach((item, at) => {
      paragraphs.push({
        spans: item,
        before: at === 0 ? gap : ITEM_GAP * em,
        bullet: part.type === "bullets" ? { indent } : { type: "number", indent, numberStartAt: part.start },
      });
    });
  });
  const align = ink.align;
  return paragraphs.flatMap((paragraph, at) =>
    paragraphRuns(paragraph, ink, context, align, at === paragraphs.length - 1),
  );
}

/** Plain words in one style, as runs. */
export function plainRuns(text: string, ink: Ink, context: RunContext): Run[] {
  return flowRuns([{ type: "paragraph", children: [{ type: "text", text }] }], ink, context);
}

/**
 * Where a text box goes: the page's box without its padding and borders. A heading the page balances over several
 * lines is as wide as its widest line, so PowerPoint breaks it where the page does; a heading on one line keeps the
 * whole width, so a face that is wider than expected does not push a word onto a second line.
 *
 * The page centers a line's glyphs in its line box, so half of any space the line height adds sits above them and half
 * below. PowerPoint puts all of it above the baseline, and takes all of it from there when the line is tighter than
 * the face. The box moves by half the difference so the first line's glyphs land where the page's do.
 */
export function textFrame(place: TextPlace): Box {
  const { box, inset, ink } = place;
  const x = box.x + inset.l;
  const w = Math.max(0, box.w - inset.l - inset.r);
  const lift = ink.natural > 0 ? (ink.natural - ink.lineHeight) / 2 : 0;
  const frame = { x, y: box.y + inset.t + lift, w, h: Math.max(0, box.h - inset.t - inset.b) };
  if (place.widest === undefined) return frame;
  const fitted = Math.min(w, place.widest * 1.03 + 3);
  const slack = w - fitted;
  return {
    ...frame,
    x: frame.x + (ink.align === "center" ? slack / 2 : ink.align === "right" ? slack : 0),
    w: fitted,
  };
}
