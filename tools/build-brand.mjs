import { readFileSync, writeFileSync } from "node:fs";
import { brandFiles, parseFont } from "./brand.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const tokens = JSON.parse(read("brand/tokens.json").toString("utf8"));
const fonts = {
  display: parseFont(read("brand/fonts/InstrumentSerif-Regular.ttf")),
  ui: parseFont(read("brand/fonts/SpaceGrotesk-Medium.ttf")),
  mono: parseFont(read("brand/fonts/IBMPlexMono-Regular.ttf")),
};
for (const [path, text] of brandFiles(tokens, fonts)) {
  writeFileSync(new URL(path, root), text);
  console.log(`brand: wrote ${path}`);
}
