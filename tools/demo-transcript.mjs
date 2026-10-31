// What the demo video's terminal shows. It is the built CLI's own output on a copy of the demo deck, so the video
// cannot quote a message the program no longer prints. The revisions are hashes of the deck's content, so they stay
// the same until the deck or the way it is hashed changes, and tools/demo.test.mjs says when that happens.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
export const CLI = fileURLToPath(new URL("packages/cli/dist/main.js", root));
export const DECK = fileURLToPath(new URL("fixtures/decks/demo", root));

/** The edit the agent makes: one operation, naming the scene by its id. */
export const OPS = [{ op: "scene.set", id: "demand", set: { title: "Demand is shifting fast" } }];

/** Runs the built CLI and returns what it printed, stdout then stderr, without the trailing newline. */
export function depthcue(cwd, args) {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: run.status, text: `${run.stdout}${run.stderr}`.trimEnd() };
}

/**
 * Runs rev, apply and a stale apply on a scratch copy of the demo deck. With `delivery` it also renders and exports the
 * deck, which needs Chrome and whose output holds sizes that change with the player, so the test leaves those out. The
 * scratch folder is taken out of the paths so the lines read the same wherever they were made.
 */
export function transcript({ delivery = false } = {}) {
  if (!existsSync(CLI))
    throw new Error("The demo's terminal text comes from the built CLI. Run pnpm build first.");
  const dir = mkdtempSync(join(tmpdir(), "depthcue-demo-"));
  try {
    cpSync(DECK, join(dir, "demo"), { recursive: true });
    writeFileSync(join(dir, "ops.json"), JSON.stringify(OPS));
    const before = depthcue(dir, ["rev", "demo"]).text;
    const applied = depthcue(dir, ["apply", "demo", "ops.json", "--base-rev", before]);
    const stale = depthcue(dir, ["apply", "demo", "ops.json", "--base-rev", before]);
    const result = {
      ops: JSON.stringify(OPS),
      before,
      applied: applied.text,
      appliedCode: applied.code,
      stale: stale.text,
      staleCode: stale.code,
    };
    if (delivery) {
      result.render = depthcue(dir, ["render", "demo"]).text;
      const exported = depthcue(dir, ["export", "demo", "--out", "demo-export"]);
      const plain = (text) => text.replaceAll(`${dir}\\`, "").replaceAll(`${dir}/`, "").replaceAll("\\", "/");
      result.delivery = plain(exported.text);
      result.deliveryCode = exported.code;
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
