import type { FromSchema } from "json-schema-to-ts";
import type { deckSchema, sceneSchema } from "./schema.ts";

export type Deck = FromSchema<typeof deckSchema>;
export type Scene = FromSchema<typeof sceneSchema>;
export type Block = Scene["blocks"][number];
export type BlockType = Block["type"];

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  /** Deck-relative file, for example `scenes/demand.json`. */
  file: string;
  /** JSON pointer inside the file; empty for the whole file. */
  path: string;
  message: string;
  /** What to change, when the fix is known. */
  fix?: string;
}
