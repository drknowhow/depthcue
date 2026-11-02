import { type Deck, FAMILY_PATTERN, type LookFace, PALETTE_COLORS, type PageLook } from "@depthcue/core";
import { brandUrl } from "./safe.ts";

/**
 * What decides how a deck looks. A deck alone gives its theme preset, the palette's changes and the font pair, which is
 * all a deck before schema 0.4 has. A `PageLook` is the same worked out, with every color, the brand's faces, chart
 * colors and chrome, and the templates and styles the deck uses, cut to the fields the player reads (`pageLook` in
 * core); the player draws what it is given and never reads a brand file or knows which templates are Depthcue's own.
 */
export type Look = Pick<Deck, "theme" | "palette" | "fonts"> | PageLook;

export const isPageLook = (look: Look | undefined): look is PageLook =>
  look !== undefined && "colors" in look;

/** The colors set as `--dc-<name>`: the seven a palette may change, and the two Depthcue's own controls use. */
const COLOR_NAMES = [...PALETTE_COLORS, "state", "on-state"] as const;
const FACE_KINDS = ["display", "body", "mono"] as const;
/** A chart takes up to six series colors from the brand. */
const CHART_SERIES = 6;
// A family name core lets into a brand: no quote, backslash, semicolon, brace, angle bracket or control character.
const FAMILY = new RegExp(FAMILY_PATTERN);

/** The weight nearest 700 that a face has a file for: the bold of a family that has one, else its heaviest. */
const headingWeight = (face: LookFace): number | undefined =>
  face.files
    .map((file) => file.weight)
    .sort((a, b) => Math.abs(a - 700) - Math.abs(b - 700) || a - b)
    .at(0);

/** A face's family when it is safe to put in a stylesheet, otherwise undefined and the face is left out. */
const familyOf = (face: LookFace | undefined): string | undefined =>
  face && FAMILY.test(face.family) ? face.family : undefined;

/** The `@font-face` rules for a look's faces, one per file, with the deck's folder as `base`. Empty when there is none. */
export function faceCss(look: Look | undefined, base: string): string {
  if (!isPageLook(look) || !look.faces) return "";
  // A rule per distinct file: a face the brand uses for two jobs would otherwise be declared twice.
  const rules = new Set<string>();
  for (const kind of FACE_KINDS) {
    const face = look.faces[kind];
    const family = familyOf(face);
    for (const file of family ? (face?.files ?? []) : []) {
      const url = brandUrl(base, file.path);
      if (url) {
        rules.add(
          `@font-face{font-family:"${family}";src:url("${url}");font-weight:${file.weight};font-style:${file.style};font-display:swap}`,
        );
      }
    }
  }
  return [...rules].join("\n");
}

/** The sheet of brand faces each document holds, so one look at a time is loaded and a change replaces it. */
const sheets = new WeakMap<Document, { sheet: CSSStyleSheet; css: string }>();

/**
 * Loads a look's faces into the document. They go in a constructed stylesheet, which a page's style policy lets
 * through where it refuses a `<style>` element; a browser without them keeps the built-in pair.
 */
function loadFaces(document: Document, css: string): void {
  const held = sheets.get(document);
  if (held ? held.css === css : css === "") return;
  try {
    const sheet = held?.sheet ?? new CSSStyleSheet();
    sheet.replaceSync("");
    // One rule at a time: a rule the browser refuses costs that face, not every face of the look. A look with no face
    // splits into one empty rule, which is refused and passed over the same way. The order of the rules means nothing.
    for (const rule of css.split("\n")) {
      try {
        sheet.insertRule(rule);
      } catch {}
    }
    if (!held) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    sheets.set(document, { sheet, css });
  } catch {
    // The deck is drawn in the pair's fonts instead.
  }
}

/**
 * Dresses an element in a look. The theme and the font pair are attributes, which player.css and tokens.css answer with
 * the preset's colors and the pair's fonts. A color goes on the element as `--dc-<name>`, which wins over the preset:
 * with a deck, the palette's; with a `PageLook`, all nine. A brand's faces are named first in the pair's stacks and
 * loaded from `base`. What an earlier look set that this one does not is taken off, so the same call also undoes a change.
 */
export function applyLook(element: HTMLElement, look: Look, base = "."): void {
  element.dataset.theme = look.theme;
  if (look.fonts) element.dataset.fonts = look.fonts;
  else delete element.dataset.fonts;
  const full = isPageLook(look);
  const set = (name: string, value: string | undefined) =>
    value ? element.style.setProperty(`--dc-${name}`, value) : element.style.removeProperty(`--dc-${name}`);
  for (const color of COLOR_NAMES) {
    set(color, full ? look.colors[color] : (look.palette as Record<string, string> | undefined)?.[color]);
  }
  for (let at = 1; at <= CHART_SERIES; at++) set(`chart-${at}`, full ? look.chart[at - 1] : undefined);
  for (const kind of FACE_KINDS) {
    const family = full ? familyOf(look.faces?.[kind]) : undefined;
    set(`face-${kind}`, family && `"${family}",`);
  }
  const display = full ? look.faces?.display : undefined;
  const weight = display && familyOf(display) ? headingWeight(display) : undefined;
  set("display-weight", weight?.toString());
  loadFaces(element.ownerDocument, faceCss(look, base));
}

/** A key that changes exactly when a look does, for a drawing that has to know it is out of date. */
export const lookKey = (look: Look): string =>
  isPageLook(look)
    ? JSON.stringify(look)
    : JSON.stringify([
        look.theme,
        look.fonts ?? null,
        ...PALETTE_COLORS.map((color) => look.palette?.[color] ?? null),
      ]);
