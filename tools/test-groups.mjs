#!/usr/bin/env node
/**
 * Runs one group of the test files, so CI can run the groups as parallel jobs. The slow browser files are named here
 * and split so each group takes about five minutes on a CI runner; every other test file is in `rest`, so a new file
 * is never left out. Usage: node tools/test-groups.mjs <group> [vitest options...]
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GROUPS = {
  editor: ["packages/cli/test/edit-e2e.test.ts"],
  brand: [
    "packages/cli/test/brand-commands-e2e.test.ts",
    "packages/cli/test/export-pptx-e2e.test.ts",
    "packages/cli/test/brand-player-e2e.test.ts",
  ],
  panels: [
    "packages/cli/test/edit-chart-e2e.test.ts",
    "packages/cli/test/editor-brand-define-e2e.test.ts",
    "packages/cli/test/edit-text-e2e.test.ts",
    "packages/cli/test/editor-brand-use-e2e.test.ts",
    "packages/cli/test/edit-table-e2e.test.ts",
    "packages/cli/test/pptx-extras-e2e.test.ts",
  ],
};

export const GROUP_NAMES = [...Object.keys(GROUPS), "rest"];

/** The vitest arguments that pick a group's files: its own, or for `rest` every file no other group names. */
export function selection(group) {
  if (group === "rest")
    return Object.values(GROUPS).flatMap((files) => files.map((file) => `--exclude=${file}`));
  const files = GROUPS[group];
  if (!files)
    throw new Error(`There is no test group "${group}". The groups are: ${GROUP_NAMES.join(", ")}.`);
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [group, ...options] = process.argv.slice(2);
  let picked;
  try {
    picked = selection(group);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [vitest, "run", ...picked, ...options], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}
