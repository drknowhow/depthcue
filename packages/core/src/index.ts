export type { RawError } from "./diagnostics.ts";
export { explain } from "./diagnostics.ts";
export {
  ASSET_PATTERN,
  deckSchema,
  ID_PATTERN,
  LAYOUTS,
  LEADS,
  SCHEMA_VERSION,
  sceneSchema,
  TEXT_LIMITS,
  TEXT_ROLES,
  THEMES,
} from "./schema.ts";
export type { Block, BlockType, Deck, Diagnostic, Scene, Severity } from "./types.ts";
export type { DeckFiles } from "./validate.ts";
export { checkDeckFiles, checkManifest, checkScene, MANIFEST_FILE, scenePath } from "./validate.ts";
