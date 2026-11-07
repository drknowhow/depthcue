/**
 * A deck's look for the player: its colors, chart colors, fonts, chrome, and the templates and styles its scenes use,
 * resolved from deck.json, its brand and Depthcue's own. The server and the export call this; the player only reads
 * what it returns, so the built-in registry never reaches the player's bundle.
 */

import { type BrandPart, blockStylesOf, brandFilePath, templatesOf } from "./brand.ts";
import { bandsOf, type ChromeDeck } from "./chrome.ts";
import type { DeckLook, LookFace, PageLook } from "./exported.ts";
import { own } from "./own.ts";
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

const hasBands = (chrome: NonNullable<Brand["chrome"]>): boolean => {
  const { header, footer } = bandsOf(chrome);
  return Object.keys(header).length + Object.keys(footer).length > 0;
};

/** What the header and footer read of the deck, so any page that has the look can say what a slide shows. */
function chromeDeckOf(source: LookSource, templates: Readonly<Record<string, Template>>): ChromeDeck {
  const { deck } = source;
  const slides = deck.scenes.flatMap((id) => {
    const scene = own(source.scenes, id);
    return scene ? [{ id, title: scene.title, template: scene.template, chrome: scene.chrome }] : [];
  });
  const templateChrome = Object.fromEntries(
    Object.entries(templates).flatMap(([id, template]) => (template.chrome ? [[id, template.chrome]] : [])),
  );
  return { title: deck.title, date: deck.date, numbering: deck.numbering, slides, templateChrome };
}

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
    ...(hasBands(chrome) ? { bands: bandsOf(chrome) } : {}),
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
    const found = id === undefined ? undefined : own(allStyles, id);
    if (id !== undefined && found) styles[id] = found;
  };
  for (const id of deck.scenes) {
    const scene = own(source.scenes, id);
    if (!scene) continue;
    const template = scene.template === undefined ? undefined : own(allTemplates, scene.template);
    if (scene.template !== undefined && template) {
      templates[scene.template] = template;
      for (const slot of template.slots) useStyle(slot.style);
    }
    for (const block of scene.blocks) useStyle(block.style);
  }
  const fonts = brand?.lock || deck.fonts === undefined ? brand?.fonts : undefined;
  const chrome = brand ? chromeOf(brand, deck.theme) : undefined;
  const reads =
    chrome?.bands !== undefined ||
    deck.scenes.some((id) => own(source.scenes, id)?.blocks.some((block) => block.type === "contents"));
  return {
    theme: style.theme,
    colors: { ...style.colors },
    chart: [...(brand?.colors?.[deck.theme]?.chart ?? [])],
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
    ...(reads ? { outline: chromeDeckOf(source, allTemplates) } : {}),
    styles,
    templates,
  };
}

/** What a template, a slot or a style says that the player does not read: it is for the tools that fill a template. */
const UNREAD = {
  template: ["schemaVersion", "id", "name", "description"],
  slot: ["accepts", "hint", "max", "required"],
  style: ["name", "for"],
} as const;

const without = (value: object, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/**
 * A look as the page carries it: the templates without their names, descriptions, hints, accepted kinds, limits and
 * required marks, and the styles without their names and kinds, so a page holds what it draws with and no more. The
 * list is of what is left out, so a field added later still reaches the page; `PageLook` is the type the player reads,
 * and a test draws the same scenes from both.
 */
export function pageLook(look: DeckLook): PageLook {
  const entries = <T>(set: Record<string, T>, keep: (value: T) => unknown) =>
    Object.fromEntries(Object.entries(set).map(([id, value]) => [id, keep(value)]));
  return {
    ...look,
    styles: entries(look.styles, (style) => without(style, UNREAD.style)),
    templates: entries(look.templates, (template) => ({
      ...without(template, UNREAD.template),
      slots: template.slots.map((slot) => without(slot, UNREAD.slot)),
    })),
  } as PageLook;
}
