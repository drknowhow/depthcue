import { type Deck, PALETTE_COLORS } from "@depthcue/core";

/** The part of a deck that decides how it looks: its theme preset, the palette's changes and its font pair. */
export type Look = Pick<Deck, "theme" | "palette" | "fonts">;

/**
 * Dresses an element in a deck's look. The theme and the font pair are attributes, which player.css and tokens.css
 * answer with the preset's colors and the pair's fonts. A color the palette names goes on the element as `--dc-<name>`,
 * which wins over the preset, and one it does not name is taken off again, so the same call also undoes a change.
 */
export function applyLook(element: HTMLElement, look: Look): void {
  element.dataset.theme = look.theme;
  if (look.fonts) element.dataset.fonts = look.fonts;
  else delete element.dataset.fonts;
  for (const color of PALETTE_COLORS) {
    const value = look.palette?.[color];
    if (value) element.style.setProperty(`--dc-${color}`, value);
    else element.style.removeProperty(`--dc-${color}`);
  }
}

/** A key that changes exactly when a deck's look does, for a drawing that has to know it is out of date. */
export const lookKey = (look: Look): string =>
  JSON.stringify([
    look.theme,
    look.fonts ?? null,
    ...PALETTE_COLORS.map((color) => look.palette?.[color] ?? null),
  ]);
