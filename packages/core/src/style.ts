/**
 * A deck's look: the colors of its theme preset, with its brand's palette for that preset on top and then its own
 * palette's changes, and its font pair. Colors are always named, never written on a block as hex, so a change to the
 * palette restyles the whole deck. The checks here hold every color that text is drawn in to WCAG 2's contrast minimum
 * on both backgrounds a slide uses.
 */
import { type SceneKit, textOn } from "./brand.ts";
import { type Flow, parseText, type Span } from "./inline.ts";
import { own } from "./own.ts";
import type { FONT_PAIRS, PALETTE_COLORS, THEME_COLORS, THEMES } from "./schema.ts";
import type { Block, Brand, Deck, Diagnostic, Scene } from "./types.ts";
import { readsMarkup } from "./versions.ts";

export type ThemeName = (typeof THEMES)[number];
export type ThemeColor = (typeof THEME_COLORS)[number];
export type PaletteColor = (typeof PALETTE_COLORS)[number];
export type FontPair = (typeof FONT_PAIRS)[number];
export type { Tone } from "./inline.ts";

type Colors = Readonly<Record<ThemeColor, string>>;

/** The two presets, as brand/tokens.json has them under `color.theme`; a test keeps the two the same. */
export const PRESETS: Readonly<Record<ThemeName, Colors>> = {
  paper: {
    bg: "#F5F2EA",
    surface: "#FBF9F4",
    line: "#D8D3C4",
    text: "#14161B",
    muted: "#4B505B",
    action: "#C73A18",
    evidence: "#2B55E6",
    state: "#B9F45D",
    "on-state": "#14161B",
  },
  ink: {
    bg: "#0C0E12",
    surface: "#161A21",
    line: "#2A303A",
    text: "#F2EFE6",
    muted: "#A5ABB8",
    action: "#FF633F",
    evidence: "#7C9BFF",
    state: "#B9F45D",
    "on-state": "#0C0E12",
  },
};

export const DEFAULT_FONTS: FontPair = "editorial";

/** The colors and fonts a deck is drawn with. */
export interface DeckStyle {
  theme: ThemeName;
  colors: Colors;
  fonts: FontPair;
}

/** What of a brand decides a deck's colors and fonts. */
export type BrandLook = Pick<Brand, "colors" | "fonts" | "lock">;

/** The built-in pair a brand's fonts come to: the pair it names, or the one its own faces fall back to. */
export const brandPair = (brand: BrandLook | undefined): FontPair | undefined =>
  typeof brand?.fonts === "string" ? brand.fonts : brand?.fonts?.fallback;

/**
 * What a deck's colors and fonts come to: its theme's preset, then its brand's palette for that preset, then each color
 * its own palette names, and its own font pair before its brand's. A brand that locks the deck keeps both its own.
 */
export function styleOf(deck: Pick<Deck, "theme" | "palette" | "fonts">, brand?: BrandLook): DeckStyle {
  const own: Pick<Deck, "palette" | "fonts"> = brand?.lock ? {} : deck;
  // The brand's chart colors sit in its palette, but are no theme color.
  const { chart: _, ...branded } = brand?.colors?.[deck.theme] ?? {};
  return {
    theme: deck.theme,
    colors: { ...PRESETS[deck.theme], ...branded, ...own.palette },
    fonts: own.fonts ?? brandPair(brand) ?? DEFAULT_FONTS,
  };
}

/** The minimum contrast for text: 4.5 to 1, and 3 to 1 for large text, as WCAG 2 level AA asks. */
export const CONTRAST = { text: 4.5, large: 3 } as const;

/** The colors text sits on: the slide, and the panels and cards drawn on it. */
const BACKGROUNDS = ["bg", "surface"] as const;
/** Colors the player itself draws small text in: body text, captions and source links. */
const SMALL_TEXT = ["text", "muted", "evidence"] as const;

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2 relative luminance of a `#rrggbb` color, from 0 for black to 1 for white. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2 contrast ratio of two `#rrggbb` colors, from 1 to 21. The order does not matter. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** A ratio as people read it, rounded down so that one just under the minimum never prints as the minimum. */
const shown = (ratio: number): string => `${Math.floor(ratio * 100) / 100}:1`;

/** The lowest contrast `color` has against the backgrounds, and which background that is. */
function worst(style: DeckStyle, color: ThemeColor): { against: ThemeColor; ratio: number } {
  const [first, second] = BACKGROUNDS.map((against) => ({
    against,
    ratio: contrastRatio(style.colors[color], style.colors[against]),
  })) as [{ against: ThemeColor; ratio: number }, { against: ThemeColor; ratio: number }];
  return second.ratio < first.ratio ? second : first;
}

/**
 * The pairs of colors that miss the contrast minimum, as errors under `palette-low-contrast`. `own` gives the path of
 * a color the file being checked sets, and `fallback` the path for a pair whose colors it sets neither of, or nothing
 * to leave such a pair to the file that does set them.
 */
function contrastProblems(
  colors: Colors,
  own: (name: ThemeColor) => string | undefined,
  file: string,
  fallback: string | undefined,
  where = "",
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const color of [...SMALL_TEXT, "action"] as const) {
    const need = color === "action" ? CONTRAST.large : CONTRAST.text;
    for (const against of BACKGROUNDS) {
      const ratio = contrastRatio(colors[color], colors[against]);
      if (ratio >= need) continue;
      const mine = own(color);
      const theirs = own(against);
      const path = mine ?? theirs ?? fallback;
      if (path === undefined) continue;
      const lighter = luminance(colors[color]) > luminance(colors[against]);
      const fore = `make "${color}" ${lighter ? "lighter" : "darker"}`;
      const back = `make "${against}" ${lighter ? "darker" : "lighter"}`;
      const both = (mine === undefined) === (theirs === undefined);
      const change = both ? `${fore}, or ${back},` : mine ? fore : back;
      out.push({
        severity: "error",
        code: "palette-low-contrast",
        file,
        path,
        message: `${where}"${color}" (${colors[color]}) on "${against}" (${colors[against]}) has a contrast of ${shown(ratio)}, under the ${need}:1 that ${color === "action" ? "even large text" : "text"} needs.`,
        fix: `${change.charAt(0).toUpperCase()}${change.slice(1)} until the two reach ${need}:1.`,
      });
    }
  }
  return out;
}

/**
 * Checks a valid deck's colors, in deck.json, as errors under `palette-low-contrast`. Text, muted and evidence need
 * 4.5:1 on bg and on surface, because the player draws body text, captions and source links in them. Action needs
 * 3:1, the minimum for large text: a block that uses it for smaller text is held to 4.5:1 by `checkTones`. The line
 * color is not text, and the state colors are not the palette's. In a branded deck a pair the deck's palette has no
 * part in is the brand's to answer for, and `checkBrandColors` reports it in brand.json.
 */
export function checkPalette(deck: Deck, file = "deck.json", brand?: BrandLook): Diagnostic[] {
  const own = (name: string): string | undefined =>
    !brand?.lock && deck.palette !== undefined && Object.hasOwn(deck.palette, name)
      ? `/palette/${name}`
      : undefined;
  return contrastProblems(styleOf(deck, brand).colors, own, file, brand ? undefined : "/theme");
}

/** Checks a brand's palette for each preset it changes, by the same rules as `checkPalette`, in brand.json. */
export function checkBrandColors(brand: BrandLook, file: string): Diagnostic[] {
  return (Object.keys(PRESETS) as ThemeName[]).flatMap((theme) => {
    const palette = brand.colors?.[theme];
    if (palette === undefined) return [];
    const own = (name: string): string | undefined =>
      Object.hasOwn(palette, name) ? `/colors/${theme}/${name}` : undefined;
    return contrastProblems({ ...PRESETS[theme], ...palette }, own, file, undefined, `On ${theme} slides, `);
  });
}

/**
 * Large text, which WCAG lets get by on 3:1: a heading, or text of size l or xl. The player draws headings and both
 * of those sizes at 24 CSS pixels or more on a 16 by 9 slide.
 */
export const isLargeText = (block: Extract<Block, { type: "text" }>): boolean =>
  block.role === "heading" || block.size === "l" || block.size === "xl";

function spanTones(spans: readonly Span[], into: Set<string>) {
  for (const span of spans) {
    if (span.type === "text") continue;
    if (span.type === "tone") into.add(span.tone);
    spanTones(span.children, into);
  }
}

/** The tones a text block's own spans name, in a scene that reads markup. */
export function tonesInText(flow: readonly Flow[]): Set<string> {
  const found = new Set<string>();
  for (const block of flow) {
    if (block.type === "paragraph") spanTones(block.children, found);
    else for (const item of block.items) spanTones(item, found);
  }
  return found;
}

/**
 * Checks the tones a scene's text uses against the deck's colors, as errors under `tone-low-contrast`: text that is
 * not large needs 4.5:1 on bg and on surface. `checkPalette` holds every tone to at least 3:1 already, so this matters
 * for a block that colors small text with a tone only large text may use, such as an accent between 3:1 and 4.5:1.
 *
 * Given the deck's kit, a text block that takes a style (its own, or its slot's) or sits on a template's colored
 * background is checked on the colors it resolves to, under `block-low-contrast`: its own tone and size win over the
 * style's, it sits on the style's fill or else on the template's background, and with no tone of its own it is drawn
 * in the style's tone or in the one that reads on what it sits on. The template's own text color is the template's to
 * answer for (`template-low-contrast`), so a block that changes nothing of it is not checked again.
 */
export function checkTones(scene: Scene, style: DeckStyle, file: string, kit?: SceneKit): Diagnostic[] {
  const out: Diagnostic[] = [];
  const template = kit && scene.template !== undefined ? own(kit.templates, scene.template) : undefined;
  const backdrop = template?.background?.image === undefined ? template?.background?.color : undefined;
  scene.blocks.forEach((block, i) => {
    if (block.type !== "text") return;
    const id = block.style ?? template?.slots.find((slot) => slot.id === block.slot)?.style;
    const look = kit && id !== undefined ? own(kit.styles, id) : undefined;
    const spans = () =>
      readsMarkup(scene)
        ? tonesInText(parseText(block.text, { lists: block.role === "body" }))
        : new Set<string>();
    if (look || backdrop) {
      const fill = look?.fill === "none" ? undefined : look?.fill;
      const grounds: readonly ThemeColor[] = fill ? [fill] : backdrop ? [backdrop] : BACKGROUNDS;
      const size = block.size ?? look?.size;
      const large = block.role === "heading" || size === "l" || size === "xl";
      const need = large ? CONTRAST.large : CONTRAST.text;
      const tone = block.tone ?? look?.tone ?? textOn(fill ?? backdrop ?? "bg");
      const used = [...spans()].filter((span) => span !== tone).map((span) => [span, "/text"]);
      if (block.tone || look)
        used.unshift([tone, block.tone ? "/tone" : block.style ? "/style" : block.slot ? "/slot" : ""]);
      for (const [name, at] of used as Array<[ThemeColor, string]>) {
        const ground = grounds.find(
          (against) => contrastRatio(style.colors[name], style.colors[against]) < need,
        );
        if (ground === undefined) continue;
        out.push({
          severity: "error",
          code: "block-low-contrast",
          file,
          path: `/blocks/${i}${at}`,
          message: `The text is drawn in "${name}" (${style.colors[name]}) on "${ground}" (${style.colors[ground]}), a contrast of ${shown(contrastRatio(style.colors[name], style.colors[ground]))}, under the ${need}:1 that ${large ? "large text" : "text of this size"} needs.`,
          fix: `Give the block another tone${large ? "" : " or size l or xl"}, or pick another style.`,
        });
      }
      return;
    }
    if (isLargeText(block)) return;
    const used: Array<{ tone: string; path: string }> = [];
    if (block.tone) used.push({ tone: block.tone, path: `/blocks/${i}/tone` });
    for (const tone of spans()) {
      if (tone !== block.tone) used.push({ tone, path: `/blocks/${i}/text` });
    }
    for (const { tone, path } of used) {
      const { against, ratio } = worst(style, tone as ThemeColor);
      if (ratio >= CONTRAST.text) continue;
      out.push({
        severity: "error",
        code: "tone-low-contrast",
        file,
        path,
        message: `"${tone}" (${style.colors[tone as ThemeColor]}) on "${against}" has a contrast of ${shown(ratio)}, under the ${CONTRAST.text}:1 that text of this size needs.`,
        fix: `Use another tone, make the block a heading or size l or xl, or change "${tone}" in the deck's palette.`,
      });
    }
  });
  return out;
}

/** A key that changes exactly when a deck's colors do, to tell whether its scenes need their tones checked again. */
export const colorsKey = (deck: Pick<Deck, "theme" | "palette">, brand?: BrandLook): string =>
  JSON.stringify(
    styleOf({ theme: deck.theme, ...(deck.palette ? { palette: deck.palette } : {}) }, brand).colors,
  );
