import type {
  ACCENTS,
  CHROME_PLACES,
  FONT_PAIRS,
  FONT_STYLES,
  LOGO_CORNERS,
  LOGO_SIZES,
  THEME_COLORS,
  THEMES,
} from "./schema.ts";
import type { BlockStyle, Deck, Scene, Template } from "./types.ts";

/** The format name an exported page carries, so the page can tell whether it understands its data. */
export const EXPORT_FORMAT = "depthcue-export/1";

/**
 * What `depthcue export` embeds in the page: the whole deck, so a page opened from a folder needs no request
 * to show it. `files` holds the JSON files the player reads beside the deck, by deck-relative path.
 */
export interface ExportData {
  format: typeof EXPORT_FORMAT;
  deck: Deck;
  scenes: Scene[];
  files: Record<string, unknown>;
}

/** A face of a brand's own, ready to load: its family, and its files by deck-relative path. */
export interface LookFace {
  family: string;
  files: Array<{ path: string; weight: number; style: (typeof FONT_STYLES)[number] }>;
}

type Place = (typeof CHROME_PLACES)[number];

/**
 * How a deck looks, worked out by `lookOf` from deck.json, its brand and its scenes, so the player draws a branded deck
 * without reading a brand file or knowing Depthcue's own templates and styles. Paths are relative to the deck folder.
 */
export interface DeckLook {
  theme: (typeof THEMES)[number];
  /** Every color of the theme: its preset, then the brand's palette for it, then the deck's own. */
  colors: Record<(typeof THEME_COLORS)[number], string>;
  /** Series colors for charts, in order; empty when charts take theirs from the palette. */
  chart: string[];
  /** The built-in pair the deck is drawn in, and that the brand's faces fall back to while they load. */
  fonts: (typeof FONT_PAIRS)[number];
  /** The brand's own faces. */
  faces?: { display: LookFace; body: LookFace; mono?: LookFace };
  /** What the brand draws on every slide that a template does not turn off, with the logo for the deck's theme. */
  chrome?: {
    logo?: {
      path: string;
      alt: string;
      corner: (typeof LOGO_CORNERS)[number];
      size: (typeof LOGO_SIZES)[number];
    };
    footer?: { text: string; place: Place };
    number?: { place: Place };
    accent: (typeof ACCENTS)[number];
  };
  /** The component styles the deck's blocks and its templates' slots name, by id. */
  styles: Record<string, BlockStyle>;
  /** The templates the deck's scenes use, by id. */
  templates: Record<string, Template>;
}
