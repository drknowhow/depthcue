// Fails when a generated file is out of date: regenerates everything and compares with what was on disk.
// This works on a dirty tree and in CI alike, because it never consults git.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { staleFiles } from "./generated.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const DIRECTORIES = ["packages/core/schema", "packages/core/src/generated"];
const FILES = ["brand/tokens.css"];

function snapshot() {
  const paths = [...FILES];
  for (const directory of DIRECTORIES) {
    const full = join(root, directory);
    if (existsSync(full)) for (const name of readdirSync(full)) paths.push(`${directory}/${name}`);
  }
  return new Map(paths.map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

const before = snapshot();
execSync("pnpm schema && pnpm tokens", { cwd: root, stdio: "inherit" });
const stale = staleFiles(before, snapshot());

if (stale.length > 0) {
  console.error("Generated files are out of date:");
  for (const path of stale) console.error(`  ${path}`);
  console.error("Run `pnpm schema` and `pnpm tokens`, then commit the result.");
  process.exit(1);
}
console.log("ok   generated files are current");
