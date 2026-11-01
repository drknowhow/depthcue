/**
 * A deck's look for the player: its colors, chart colors, fonts, chrome, and the templates and styles its scenes use,
 * resolved from deck.json, its brand and Depthcue's own. The server and the export call this; the player only reads
 * what it returns, so the built-in registry never reaches the player's bundle.
 */
import { type BrandPart, blockStylesOf, brandFilePath, templatesOf } from "./brand.ts";
import type { DeckLook, LookFace } from "./exported.ts";
import { styleOf } from "./style.ts";
import type { BlockStyle, Brand, BrandFace, Deck, Scene, Template } from "./types.ts";

const faceOf = (face: BrandFace): LookFace => ({
  family: face.family,
  files: (face.files ?? []).map((entry) => ({
    path: brandFilePath(entry.file),
    weight: entry.weight,
    style: entry.style,
  })),
});

/** The logo for slides of a theme: the light one on paper and the dark one on ink, or the only one there is. */
const logoFor = (brand: Brand, theme: Deck["theme"]): string | undefined =>
  theme === "ink" ? (brand.logos?.dark ?? brand.logos?.light) : (brand.logos?.light ?? brand.logos?.dark);

function chromeOf(brand: Brand, theme: Deck["theme"]): DeckLook["chrome"] {
  const chrome = brand.chrome;
  if (chrome === undefined) return undefined;
  const logo = logoFor(brand, theme);
  return {
    ...(chrome.logo && logo && brand.logos
      ? { logo: { path: brandFilePath(logo), alt: brand.logos.alt, ...chrome.logo } }
      : {}),
    ...(chrome.footer ? { footer: { ...chrome.footer } } : {}),
    ...(chrome.number ? { number: { ...chrome.number } } : {}),
    accent: chrome.accent ?? "none",
  };
}

/** What `lookOf` reads: a Doc has all of it. */
export interface LookSource extends BrandPart {
  readonly deck: Deck;
  readonly scenes: Readonly<Record<string, Scene>>;
}

/**
 * The look of a deck, as one plain object the player can take as it is. Only the templates its scenes use and the
 * styles its blocks and those templates' slots name come along, so a page carries no more than it draws.
 */
export function lookOf(source: LookSource): DeckLook {
  const { deck, brand } = source;
  const style = styleOf(deck, brand);
  const allTemplates = templatesOf(source);
  const allStyles = blockStylesOf(source);
  const templates: Record<string, Template> = {};
  const styles: Record<string, BlockStyle> = {};
  const useStyle = (id: string | undefined) => {
    const found = id === undefined ? undefined : allStyles[id];
    if (id !== undefined && found) styles[id] = found;
  };
  for (const id of deck.scenes) {
    const scene = source.scenes[id];
    if (!scene) continue;
    const template = scene.template === undefined ? undefined : allTemplates[scene.template];
    if (scene.template !== undefined && template) {
      templates[scene.template] = template;
      for (const slot of template.slots) useStyle(slot.style);
    }
    for (const block of scene.blocks) useStyle(block.style);
  }
  const fonts = brand?.lock || deck.fonts === undefined ? brand?.fonts : undefined;
  const chrome = brand ? chromeOf(brand, deck.theme) : undefined;
  return {
    theme: style.theme,
    colors: { ...style.colors },
    chart: [...(brand?.chart ?? [])],
    fonts: style.fonts,
    ...(typeof fonts === "object"
      ? {
          faces: {
            display: faceOf(fonts.display),
            body: faceOf(fonts.body),
            ...(fonts.mono ? { mono: faceOf(fonts.mono) } : {}),
          },
        }
      : {}),
    ...(chrome ? { chrome } : {}),
    styles,
    templates,
  };
}
