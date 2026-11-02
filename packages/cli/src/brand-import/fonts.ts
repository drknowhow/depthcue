/**
 * The brand's fonts from a PowerPoint theme. The theme's major and minor Latin fonts become the display and body faces
 * by family name, with no files, and a built-in pair stands in until a viewer has them. Which pair depends on whether
 * each face is a serif or a sans, which the theme's PANOSE number says, or else the font's name.
 */
import { FAMILY_PATTERN, type FontPair } from "@depthcue/core";
import type { ThemeFont } from "./theme.ts";

/** A family name a brand can carry: core's own pattern, and the 64 characters its schema allows. */
const FAMILY = new RegExp(FAMILY_PATTERN);

export type Serifness = "serif" | "sans";

export interface FaceKind {
  kind: Serifness;
  /** The rule that decided it, in words for the report. */
  rule: string;
}

/** PANOSE's second digit, the serif style: 2 to 10 are the serif styles, 11 to 15 the sans ones, 0 and 1 say nothing. */
function byPanose(panose: string): Serifness | undefined {
  const familyKind = Number.parseInt(panose.slice(0, 2), 16);
  const style = Number.parseInt(panose.slice(2, 4), 16);
  if (familyKind !== 2) return undefined;
  if (style >= 2 && style <= 10) return "serif";
  if (style >= 11 && style <= 15) return "sans";
  return undefined;
}

/** Families that are serifs, by the words in their names. "Sans" and "Gothic" are checked first: "Century Gothic" is a sans. */
const SERIF_NAMES =
  /\b(serif|times|georgia|cambria|garamond|palatino|book antiqua|bookman|baskerville|century|constantia|didot|bodoni|caslon|minion|sitka|perpetua|rockwell|playfair|merriweather|lora|charter|cochin|hoefler|iowan|athelas|elephant|bell mt|bookshelf|californian|centaur|footlight|goudy|plantagenet|slab)\b/i;
const SANS_NAMES = /\b(sans|gothic|grotesk|grotesque)\b/i;

/** Whether a face is a serif or a sans, by its PANOSE number when it has a useful one, else by its name. */
export function classify(face: ThemeFont): FaceKind {
  const panose = face.panose ? byPanose(face.panose) : undefined;
  if (panose && face.panose) {
    return { kind: panose, rule: `its PANOSE number ${face.panose} says ${panose}` };
  }
  if (SANS_NAMES.test(face.typeface)) return { kind: "sans", rule: `its name has "sans" or "gothic" in it` };
  const named = SERIF_NAMES.exec(face.typeface);
  if (named) return { kind: "serif", rule: `its name matches the serif family "${named[1]}"` };
  return {
    kind: "sans",
    rule: face.panose
      ? "its PANOSE number does not say, and its name is not a known serif, so a sans is assumed"
      : "it has no PANOSE number, and its name is not a known serif, so a sans is assumed",
  };
}

/**
 * The built-in pair that stands in for a brand's faces. The display face decides: a serif display falls back to
 * `classic` (Source Serif and Source Sans), a sans display to `modern` (Inter). Every built-in pair has a sans body, so
 * a serif body has no match and the pair is the nearest one.
 */
export function fallbackPair(display: Serifness, body: Serifness): { pair: FontPair; rule: string } {
  const pair: FontPair = display === "serif" ? "classic" : "modern";
  const rule = `the display face is a ${display}, so ${pair === "classic" ? "the serif pair classic" : "the sans pair modern"}`;
  return {
    pair,
    rule:
      body === "serif" ? `${rule}; no built-in pair has a serif body, so the body stands in as a sans` : rule,
  };
}

export interface Fonts {
  display: { family: string; kind: FaceKind };
  body: { family: string; kind: FaceKind };
  fallback: FontPair;
  fallbackRule: string;
}

const usable = (font: ThemeFont | undefined, what: string, notes: string[]): ThemeFont | undefined => {
  if (!font) return undefined;
  if (font.typeface.length > 64 || !FAMILY.test(font.typeface)) {
    // Quoted as JSON, and DEL too, which JSON leaves alone: a control character in the name is shown as an escape and
    // never reaches a terminal as it is.
    const shown = JSON.stringify(font.typeface).replaceAll("\u007f", "\\u007f");
    notes.push(
      `The theme's ${what} font ${shown} has a name a brand cannot carry (a quote, brace, semicolon or control character, or more than 64 characters), so it was not used.`,
    );
    return undefined;
  }
  return font;
};

/** The brand's faces from a theme's fonts, or undefined when the theme names no usable font. */
export function readFonts(fonts: { major?: ThemeFont; minor?: ThemeFont }): {
  fonts?: Fonts;
  notes: string[];
} {
  const notes: string[] = [];
  const major = usable(fonts.major, "heading", notes);
  const minor = usable(fonts.minor, "body", notes);
  const display = major ?? minor;
  const body = minor ?? major;
  if (!display || !body) {
    notes.push("The theme names no font that can be used, so the deck keeps its own font pair.");
    return { notes };
  }
  if (!major) notes.push("The theme has no heading font, so the body font is used for headings too.");
  if (!minor) notes.push("The theme has no body font, so the heading font is used for text too.");
  const [displayKind, bodyKind] = [classify(display), classify(body)];
  const { pair, rule } = fallbackPair(displayKind.kind, bodyKind.kind);
  return {
    fonts: {
      display: { family: display.typeface, kind: displayKind },
      body: { family: body.typeface, kind: bodyKind },
      fallback: pair,
      fallbackRule: rule,
    },
    notes,
  };
}
