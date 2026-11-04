#!/usr/bin/env node
/**
 * Assembles the npm package `depthcue` in release/depthcue: the CLI, the MCP server and the packages they use, built
 * and bundled as @depthcue/* inside node_modules so one `npm install -g depthcue` has everything. Run `pnpm build`
 * first. Usage: node tools/build-release.mjs [--version 1.2.3]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "release", "depthcue");
const bundled = ["core", "player", "editor", "cli", "mcp"];

const flag = process.argv.indexOf("--version");
const version =
  flag > 0 ? process.argv[flag + 1] : JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error(`"${version}" is not a version such as 0.1.0.`);
  process.exit(1);
}

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const outside = {};
for (const name of bundled) {
  const from = join(root, "packages", name);
  const manifest = read(join(from, "package.json"));
  for (const entry of manifest.files ?? []) {
    if (!existsSync(join(from, entry))) {
      console.error(`packages/${name}/${entry} is missing. Run pnpm build first.`);
      process.exit(1);
    }
  }
  const to = join(stage, "node_modules", "@depthcue", name);
  mkdirSync(to, { recursive: true });
  for (const entry of manifest.files ?? []) cpSync(join(from, entry), join(to, entry), { recursive: true });
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!dependency.startsWith("@depthcue/")) outside[dependency] = range;
  }
  const {
    private: _private,
    scripts: _scripts,
    devDependencies: _dev,
    dependencies: _deps,
    ...rest
  } = manifest;
  writeFileSync(join(to, "package.json"), `${JSON.stringify({ ...rest, version }, null, 2)}\n`);
}

const manifest = {
  name: "depthcue",
  version,
  description:
    "Decks that are built from structured files, edited in a browser, and exported to PowerPoint, PDF or a page that works offline.",
  license: "MIT",
  type: "module",
  bin: {
    depthcue: "node_modules/@depthcue/cli/dist/main.js",
    "depthcue-mcp": "node_modules/@depthcue/mcp/dist/main.js",
  },
  engines: { node: ">=22.12" },
  repository: { type: "git", url: "git+https://github.com/drknowhow/depthcue.git" },
  dependencies: {
    ...Object.fromEntries(Object.entries(outside).sort(([a], [b]) => a.localeCompare(b))),
    ...Object.fromEntries(bundled.map((name) => [`@depthcue/${name}`, version])),
  },
  bundleDependencies: bundled.map((name) => `@depthcue/${name}`),
  files: ["README.md", "LICENSE"],
};
writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of ["LICENSE", "README.md"]) cpSync(join(root, file), join(stage, file));
console.log(
  `release/depthcue is ready: depthcue@${version}, ${Object.keys(outside).length} outside packages.`,
);
