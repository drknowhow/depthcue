// The tool-description trial. An agent sees only the MCP tool definitions and real deck_get replies, and writes the
// deck_apply operations for twelve edits. It then writes the same edits again as whole-file rewrites. This script
// prepares what the agent sees and scores both answers against the real CLI, so the tool descriptions and the op
// format are measured on whether a model can use them without running anything.
//
//   node tools/trial/edit-tasks.mjs prepare <folder>   writes the agent's inputs
//   node tools/trial/edit-tasks.mjs score <folder>     reads <folder>/answers-ops.json and answers-rewrite.json
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(root, "packages/cli/dist/main.js");
const DEMO = join(root, "fixtures/decks/v0-1");

const read = (dir, path) => JSON.parse(readFileSync(join(dir, path), "utf8"));
const block = (dir, scene, id) =>
  read(dir, `scenes/${scene}.json`).blocks.find((candidate) => candidate.id === id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Each check reads the deck folder after the edit and says whether the edit did what the instruction asked. */
export const TASKS = [
  {
    id: "chart-values",
    instruction: "In the demand scene's chart, change Channel A to 45 and Channel B to 55. Keep the labels.",
    check: (dir) =>
      same(block(dir, "demand", "chart-demand")?.data, [
        { label: "Channel A", value: 45 },
        { label: "Channel B", value: 55 },
      ]),
  },
  {
    id: "claim-text",
    instruction:
      'Change the demand scene\'s summary text to "Channel B now leads, 55 to 45." Keep the evidence it points to.',
    check: (dir) => {
      const { summary } = read(dir, "scenes/demand.json");
      return summary.text === "Channel B now leads, 55 to 45." && same(summary.evidenceIds, ["chart-demand"]);
    },
  },
  {
    id: "speaker-notes",
    instruction: 'Set the opening scene\'s speaker notes to "Start with the answer."',
    check: (dir) => read(dir, "scenes/opening.json").notes === "Start with the answer.",
  },
  {
    id: "add-scene",
    instruction:
      'Add a scene with id "risks" after the method scene. Use the title layout, lead human. Its heading is "What could change this" and its body is "The sample leans toward web buyers." Give it a reading text.',
    check: (dir) => {
      if (!same(read(dir, "deck.json").scenes, ["opening", "demand", "method", "risks"])) return false;
      const scene = read(dir, "scenes/risks.json");
      const texts = scene.blocks.map((candidate) => candidate.text);
      return (
        scene.layout === "title" &&
        texts.includes("What could change this") &&
        texts.includes("The sample leans toward web buyers.")
      );
    },
  },
  {
    id: "remove-scene",
    instruction: "Remove the method scene.",
    check: (dir) =>
      same(read(dir, "deck.json").scenes, ["opening", "demand"]) &&
      !existsSync(join(dir, "scenes/method.json")),
  },
  {
    id: "move-scene",
    instruction: "Move the method scene so it comes before the demand scene.",
    check: (dir) => same(read(dir, "deck.json").scenes, ["opening", "method", "demand"]),
  },
  {
    id: "deck-title",
    instruction: 'Change the deck title to "Why channel B now leads, Q3".',
    check: (dir) => read(dir, "deck.json").title === "Why channel B now leads, Q3",
  },
  {
    id: "add-bar",
    instruction:
      "Add a third bar to the demand chart: label Channel C, value 10. Leave the other two bars as they are.",
    check: (dir) =>
      same(block(dir, "demand", "chart-demand")?.data, [
        { label: "Channel A", value: 40 },
        { label: "Channel B", value: 60 },
        { label: "Channel C", value: 10 },
      ]),
  },
  {
    id: "alt-text",
    instruction:
      'Change the alt text of the method scene\'s diagram to "Orders flow into one deduplicated count."',
    check: (dir) =>
      block(dir, "method", "method-diagram")?.alt === "Orders flow into one deduplicated count.",
  },
  {
    id: "lead",
    instruction: "Hand the method scene to the agent: set its lead to agent.",
    check: (dir) => read(dir, "scenes/method.json").lead === "agent",
  },
  {
    id: "heading-text",
    instruction:
      'Change the opening scene\'s heading to "Why channel B leads now". Leave its other text alone.',
    check: (dir) => {
      const { blocks } = read(dir, "scenes/opening.json");
      return (
        blocks.find((candidate) => candidate.id === "opening-title")?.text === "Why channel B leads now" &&
        blocks.find((candidate) => candidate.id === "opening-sub")?.text ===
          "A five-minute walk through the numbers, the method, and what to check next."
      );
    },
  },
  {
    id: "add-step",
    instruction:
      'Add a step with id "show-all" to the demand scene that reveals both the claim (claim-shift) and the chart (chart-demand) at once. Keep the two existing steps.',
    check: (dir) => {
      const { steps } = read(dir, "scenes/demand.json");
      return (
        same(steps.slice(0, 2), [
          { id: "show-claim", reveal: ["claim-shift"] },
          { id: "show-evidence", reveal: ["chart-demand"] },
        ]) &&
        steps.some((step) => step.id === "show-all" && same(step.reveal, ["claim-shift", "chart-demand"]))
      );
    },
  },
];

const cli = (args, cwd = root) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
const revisionOf = (dir) => cli(["rev", dir]).stdout.trim();

function copyDemo() {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-edit-trial-"));
  cpSync(DEMO, join(dir, "deck"), { recursive: true });
  return { dir, deck: join(dir, "deck") };
}

/** What an agent connected through MCP would see: the tool definitions and real deck_get replies. */
function prepare(folder, tools) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "tools.json"), `${JSON.stringify(tools, null, 2)}\n`);
  writeFileSync(
    join(folder, "tasks.json"),
    `${JSON.stringify(
      TASKS.map(({ id, instruction }) => ({ id, instruction })),
      null,
      2,
    )}\n`,
  );
  cpSync(DEMO, join(folder, "deck"), { recursive: true });
}

function scoreOps(answers) {
  return TASKS.map((task) => {
    const answer = answers[task.id];
    const { dir, deck } = copyDemo();
    try {
      if (!answer || !Array.isArray(answer.ops))
        return { id: task.id, ok: false, reason: "no ops given", chars: 0 };
      const chars = JSON.stringify(answer.ops).length;
      writeFileSync(join(dir, "ops.json"), JSON.stringify(answer.ops));
      const applied = cli(["apply", deck, join(dir, "ops.json"), "--base-rev", revisionOf(deck), "--json"]);
      if (applied.status !== 0)
        return {
          id: task.id,
          ok: false,
          reason: `apply exit ${applied.status}: ${applied.stdout.slice(0, 200)}`,
          chars,
        };
      return {
        id: task.id,
        ok: task.check(deck) === true,
        reason: task.check(deck) ? "" : "applied, but the result is wrong",
        chars,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function scoreRewrite(answers) {
  return TASKS.map((task) => {
    const answer = answers[task.id];
    const { dir, deck } = copyDemo();
    try {
      if (!answer || typeof answer.files !== "object")
        return { id: task.id, ok: false, reason: "no files given", chars: 0 };
      let chars = 0;
      for (const [path, text] of Object.entries(answer.files)) {
        if (text === null) {
          rmSync(join(deck, path), { force: true });
          continue;
        }
        chars += String(text).length;
        mkdirSync(dirname(join(deck, path)), { recursive: true });
        writeFileSync(join(deck, path), String(text));
      }
      const checked = cli(["check", deck, "--json"]);
      if (checked.status !== 0)
        return {
          id: task.id,
          ok: false,
          reason: `check exit ${checked.status}: ${checked.stdout.slice(0, 200)}`,
          chars,
        };
      return {
        id: task.id,
        ok: task.check(deck) === true,
        reason: task.check(deck) ? "" : "valid, but the result is wrong",
        chars,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, folder] = process.argv.slice(2);
  if (command === "prepare") {
    const tools = JSON.parse(readFileSync(join(root, "scratch/trial/tools.json"), "utf8"));
    prepare(folder, tools);
    console.log(`prepared ${folder}`);
  } else if (command === "score") {
    const ops = scoreOps(JSON.parse(readFileSync(join(folder, "answers-ops.json"), "utf8")));
    const rewrite = scoreRewrite(JSON.parse(readFileSync(join(folder, "answers-rewrite.json"), "utf8")));
    const total = (rows) => ({
      passed: rows.filter((row) => row.ok).length,
      of: rows.length,
      chars: rows.reduce((sum, row) => sum + row.chars, 0),
    });
    const result = { ops: { ...total(ops), rows: ops }, rewrite: { ...total(rewrite), rows: rewrite } };
    writeFileSync(join(folder, "scores.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ ops: total(ops), rewrite: total(rewrite) }));
    for (const row of [
      ...ops.map((r) => ({ arm: "ops", ...r })),
      ...rewrite.map((r) => ({ arm: "rewrite", ...r })),
    ]) {
      if (!row.ok) console.log(`FAIL ${row.arm} ${row.id}: ${row.reason}`);
    }
  } else {
    console.error("Usage: node tools/trial/edit-tasks.mjs prepare|score <folder>");
    process.exit(2);
  }
}
