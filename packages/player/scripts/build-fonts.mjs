// Builds dist/fonts: the deck font files, one stylesheet per font pair, and `all.css` with every pair.
//
// The faces, their weights and the pairs all come from brand/fonts/manifest.json, so a font file added there is the
// only change a new face needs. Vite is not used for this: it would rename the files with a hash and inline the small
// ones, and an export has to copy a pair's stylesheet and the files it names without rewriting a line of it.
//
// A page that edits or serves a deck links `fonts/all.css`. An exported page links `fonts/<pair>.css` for the one
// pair its deck uses, and carries only the files that stylesheet names (see packages/cli/src/export.ts).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "..", "brand", "fonts");
// An argument names another folder to write into, which a test uses; it is never cleared first, only the built one is.
const custom = process.argv[2];
const out = custom ? resolve(custom) : join(here, "..", "dist", "fonts");

const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));

/**
 * The stylesheet for a set of families: one `@font-face` per file, in the order the manifest lists them. A file that
 * covers only a range of characters, as IBM's split files do, says so with `unicode-range`, so a page fetches the
 * files for the characters it shows.
 */
function css(families) {
  const faces = manifest.files.filter((file) => families.has(file.family));
  return faces
    .map(
      (file) =>
        `@font-face {\n  font-family: "${file.family}";\n  font-style: ${file.style};\n  font-weight: ${file.weight};\n  font-display: swap;\n  src: url("${file.file}") format("woff2");\n${file.unicodeRange ? `  unicode-range: ${file.unicodeRange};\n` : ""}}\n`,
    )
    .join("\n");
}

if (!custom) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of manifest.files) copyFileSync(join(source, file.file), join(out, file.file));

const banner =
  "/* Built from brand/fonts/manifest.json by packages/player/scripts/build-fonts.mjs. Do not edit. */\n";
const pairs = Object.keys(manifest.pairs);
for (const name of pairs) {
  writeFileSync(join(out, `${name}.css`), `${banner}${css(new Set(Object.values(manifest.pairs[name])))}`);
}
writeFileSync(join(out, "all.css"), `${banner}${css(new Set(manifest.files.map((file) => file.family)))}`);
console.log(`fonts: ${manifest.files.length} files and ${pairs.length + 1} stylesheets in ${out}`);
