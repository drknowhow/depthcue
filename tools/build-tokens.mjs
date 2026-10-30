import { readFileSync, writeFileSync } from "node:fs";
import { buildCss } from "./tokens.mjs";

const root = new URL("../", import.meta.url);
const tokens = JSON.parse(readFileSync(new URL("brand/tokens.json", root), "utf8"));
writeFileSync(new URL("brand/tokens.css", root), buildCss(tokens));
console.log("tokens: wrote brand/tokens.css");
