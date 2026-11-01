// Writes the published JSON Schema files from src/schema.ts. Run with `pnpm schema`; CI re-runs it and fails if the
// committed output differs. Nothing is compiled: src/schemacheck.ts checks files against these same schema objects at
// run time, and test/schemacheck.test.ts holds it to Ajv.
import { mkdirSync, writeFileSync } from "node:fs";
import {
  brandSchema,
  commentOpsSchema,
  commentsSchema,
  deckSchema,
  opsSchema,
  sceneSchema,
  templateSchema,
} from "../src/schema.ts";

const root = new URL("../", import.meta.url);

mkdirSync(new URL("schema/", root), { recursive: true });

for (const [name, schema] of [
  ["deck", deckSchema],
  ["scene", sceneSchema],
  ["ops", opsSchema],
  ["comments", commentsSchema],
  ["comment-ops", commentOpsSchema],
  ["brand", brandSchema],
  ["template", templateSchema],
]) {
  writeFileSync(new URL(`schema/${name}.schema.json`, root), `${JSON.stringify(schema, null, 2)}\n`);
}

console.log("schema: wrote schema/*.schema.json");
