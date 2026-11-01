import type { FromSchema } from "json-schema-to-ts";
import type {
  BLOCK_KINDS,
  blockStyleSchema,
  brandSchema,
  deckSchema,
  FONT_PAIRS,
  facesSchema,
  sceneSchema,
  templateSchema,
} from "./schema.ts";

export type Deck = FromSchema<typeof deckSchema>;
export type Scene = FromSchema<typeof sceneSchema>;
export type Block = Scene["blocks"][number];
export type BlockType = Block["type"];

/** A brand's own faces, with the built-in pair they fall back to. */
export type BrandFaces = FromSchema<typeof facesSchema>;
export type BrandFace = BrandFaces["display"];
/**
 * `brand/brand.json`. Its fonts are written out by hand: the schema chooses between a pair and faces with if and then,
 * which reads better in an error than oneOf, and which the type generator does not follow.
 */
export type Brand = Omit<FromSchema<typeof brandSchema>, "fonts"> & {
  fonts?: (typeof FONT_PAIRS)[number] | BrandFaces;
};
/** A template: a file under `brand/templates/`, or one of Depthcue's own. */
export type Template = FromSchema<typeof templateSchema>;
export type TemplateSlot = Template["slots"][number];
/** A component style: one of a brand's `styles`, or one of Depthcue's own. */
export type BlockStyle = FromSchema<typeof blockStyleSchema>;
/** What a slot accepts and a style is for: a text block by its role, any other block by its type. */
export type BlockKind = (typeof BLOCK_KINDS)[number];

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
