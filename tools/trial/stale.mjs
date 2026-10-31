// Task 5 of the trial, run for real: two writers start from the same copy of a deck, one saves first, and the other
// saves from its older copy. It reports whether the second save was refused, and whose edit is in the file after.
//
//   node tools/trial/stale.mjs <depthcue-deck> <slidev-folder> <stagecraft-folder> [out.json]
//
// The folders are what the agents in the trial delivered. Everything is copied first; nothing in them changes.
// Slidev and Stagecraft keep a deck in plain files and give a writer no revision to send, so for them the second
// writer does what an editor or an agent with a stale copy does: it saves its whole file. A version-control
// system would catch this in either tool, and the report says so; the question here is what the tool itself offers.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(root, "packages/cli/dist/main.js");

const FIRST_HEADING = "Channel B now leads, 55 to 45";
const SECOND_SOURCE = "Q3 demand survey, n = 1,204, weighted by region";

const scratch = () => mkdtempSync(join(tmpdir(), "depthcue-stale-"));
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

function depthcue(deckFolder) {
  const dir = scratch();
  try {
    const deck = join(dir, "deck");
    cpSync(deckFolder, deck, { recursive: true });
    const base = cli(["rev", deck]).stdout.trim();
    const write = (name, ops) => {
      const file = join(dir, name);
      writeFileSync(file, JSON.stringify(ops));
      return file;
    };
    const first = cli([
      "apply",
      deck,
      write("first.json", [
        {
          op: "scene.set",
          id: "demand",
          set: { summary: { id: "claim-lead", text: FIRST_HEADING, evidenceIds: ["chart-demand"] } },
        },
      ]),
      "--base-rev",
      base,
      "--json",
    ]);
    const second = cli([
      "apply",
      deck,
      write("second.json", [
        {
          op: "scene.set",
          id: "demand",
          set: { sources: [{ id: "source-survey", title: SECOND_SOURCE }] },
        },
      ]),
      "--base-rev",
      base,
      "--json",
    ]);
    const scene = JSON.parse(readFileSync(join(deck, "scenes/demand.json"), "utf8"));
    return {
      firstExit: first.status,
      secondExit: second.status,
      secondReply: second.stdout.trim().slice(0, 300),
      firstEditKept: scene.summary.text === FIRST_HEADING,
      secondEditKept: scene.sources?.[0]?.title === SECOND_SOURCE,
      secondWasWarned: second.status !== 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Two writers on one plain file. `heading` and `source` are lines both decks have; each edit swaps one literal. */
function plainFile(folder, file, heading, source) {
  const dir = scratch();
  try {
    cpSync(folder, dir, { recursive: true, filter: (from) => !from.includes("node_modules") });
    const path = join(dir, file);
    const original = readFileSync(path, "utf8");
    // Both writers read the file now.
    const firstCopy = original;
    const secondCopy = original;
    // The first writer saves.
    if (!firstCopy.includes(heading.from)) throw new Error(`${file} has no ${heading.from}`);
    writeFileSync(path, firstCopy.replace(heading.from, heading.to));
    // The second writer saves its whole copy, which does not have the first edit.
    if (!secondCopy.includes(source.from)) throw new Error(`${file} has no ${source.from}`);
    writeFileSync(path, secondCopy.replace(source.from, source.to));
    const after = readFileSync(path, "utf8");
    return {
      firstExit: 0,
      secondExit: 0,
      secondReply: "",
      firstEditKept: after.includes(heading.to),
      secondEditKept: after.includes(source.to),
      secondWasWarned: false,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function stale(depthcueDeck, slidevFolder, stagecraftFolder) {
  return {
    depthcue: depthcue(depthcueDeck),
    slidev: plainFile(
      slidevFolder,
      "slides.md",
      { from: "# Channel B leads demand, 55 to 45", to: `# ${FIRST_HEADING}` },
      { from: "Source: Q3 demand survey, n = 1,204", to: `Source: ${SECOND_SOURCE}` },
    ),
    stagecraft: plainFile(
      stagecraftFolder,
      "slides/02-claim.js",
      { from: "heading: 'Channel B leads demand, 55 to 45'", to: `heading: '${FIRST_HEADING}'` },
      { from: "source: 'Source: Q3 demand survey, n = 1,204'", to: `source: 'Source: ${SECOND_SOURCE}'` },
    ),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [depthcueDeck, slidevFolder, stagecraftFolder, out] = process.argv.slice(2);
  if (!depthcueDeck || !slidevFolder || !stagecraftFolder) {
    console.error(
      "Usage: node tools/trial/stale.mjs <depthcue-deck> <slidev-folder> <stagecraft-folder> [out.json]",
    );
    process.exit(2);
  }
  const text = `${JSON.stringify(stale(depthcueDeck, slidevFolder, stagecraftFolder), null, 2)}\n`;
  if (out) writeFileSync(out, text);
  console.log(text);
}
