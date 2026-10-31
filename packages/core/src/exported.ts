import type { Deck, Scene } from "./types.ts";

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
