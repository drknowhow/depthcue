// Turns the trial's result files in docs/trial/ into the tables in docs/TRIAL.md. The prose around the tables is
// written by hand; the numbers are not. `node tools/trial/report.mjs` rewrites the tables, `--check` fails when a
// table no longer matches its result file, and tools/trial/report.test.mjs runs that check in CI.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const TRIAL_DIR = join(root, "docs/trial");
export const TRIAL_DOC = join(root, "docs/TRIAL.md");

export const TOOLS = ["depthcue", "slidev", "stagecraft"];
const NAMES = { depthcue: "Depthcue", slidev: "Slidev", stagecraft: "Stagecraft" };

/** The targets in docs/PLAN.md § Speed budgets that a browser run can check. */
export const TARGETS = { coldOpenP95Ms: 1500, sceneChangeP95Ms: 50, tabMemoryMB: 200 };

/** The document with LF line ends, so a Windows checkout compares the same as CI. */
export const readDocument = () =>
  readFileSync(TRIAL_DOC, "utf8").replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10));

const read = (name) => JSON.parse(readFileSync(join(TRIAL_DIR, name), "utf8"));

export function load() {
  const verify = {};
  for (const tool of TOOLS) {
    const file = `verify-${tool}.json`;
    if (existsSync(join(TRIAL_DIR, file))) verify[tool] = read(file);
  }
  return {
    bench: read("bench.json"),
    agents: read("agents.json"),
    stale: read("stale.json"),
    edit: read("edit.json"),
    verify,
  };
}

const round = (value, places = 0) => {
  const scale = 10 ** places;
  return (Math.round(value * scale) / scale).toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
};
const ms = (value) => `${round(value)} ms`;
const mb = (value) => `${round(value)} MB`;
const mb1 = (value) => `${round(value, 1)} MB`;
const calls = (count) => `${count} ${count === 1 ? "call" : "calls"}`;
const kb = (bytes) => `${round(bytes / 1024, 1)} KB`;
const pair = (summary) => `${round(summary.p50)} / ${round(summary.p95)} ms`;
const yes = (value) => (value ? "yes" : "no");
/** A Markdown table with padded columns, the way Biome formats one, so `pnpm lint` has nothing to change. */
const table = (head, rows) => {
  const widths = head.map((title, column) =>
    Math.max(3, ...[title, ...rows.map((row) => row[column])].map((cell) => cell.length)),
  );
  const line = (cells) => `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [line(head), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
};

const wireTotal = (bytes) =>
  bytes.script + bytes.stylesheet + bytes.document + bytes.font + bytes.image + bytes.other;

function machine({ bench }) {
  const m = bench.machine;
  return [
    `Measured on ${bench.measuredAt}, on the build at commit ${bench.commit}: ${m.cpu} (${m.logicalCores} logical cores),`,
    `${m.memoryGB} GB of memory, ${m.gpu ?? "GPU not reported"}, ${m.os}, Chrome ${m.chrome}, Node ${m.node}.`,
    `Headless Chrome, a 1280 by 720 window, ${bench.scenes} scenes, the reference network (${bench.network}) for cold opens,`,
    `${bench.runs} cold opens and 3 traversals per tool.`,
  ].join(" ");
}

function agents({ agents: data }) {
  const cell = (tool, task) => {
    const row = data.tools[tool].results[task];
    return `${row.result}, ${calls(row.calls)}, ${row.seconds} s`;
  };
  const rows = data.tasks.map((task) => [task.title, ...TOOLS.map((tool) => cell(tool, task.id))]);
  rows.push([
    "Whole run",
    ...TOOLS.map((tool) => {
      const results = Object.values(data.tools[tool].results);
      return `${calls(results.reduce((sum, row) => sum + row.calls, 0))}, ${data.tools[tool].totalSeconds} s`;
    }),
  ]);
  return table(["Task", ...TOOLS.map((tool) => NAMES[tool])], rows);
}

function agentNotes({ agents: data }) {
  return data.tasks
    .map((task) =>
      [
        `**${task.title}**`,
        "",
        ...TOOLS.map((tool) => {
          const row = data.tools[tool].results[task.id];
          return `- ${NAMES[tool]} (${row.result}): ${row.note}`;
        }),
      ].join("\n"),
    )
    .join("\n\n");
}

function speed({ bench }) {
  const per = (pick) => TOOLS.map((tool) => pick(bench.results[tool], tool));
  const rows = [
    [
      "Cold open to the first scene, p50 / p95",
      ...per((r, tool) => {
        const failed = r.coldOpenMs.failed ? `, ${r.coldOpenMs.failed} failed` : "";
        const welcome = tool === "stagecraft" ? " (to its welcome screen)" : "";
        return `${pair(r.coldOpenMs)}${welcome}${failed}`;
      }),
    ],
    ["Key press that starts the deck, p50", ...per((r) => (r.beginMs ? ms(r.beginMs.p50) : "none needed"))],
    ["Scene change, key to painted heading, p50 / p95", ...per((r) => pair(r.sceneChangeMs))],
    [
      "Scene change with reduced motion, p50 / p95",
      ...per((r) => (r.sceneChangeReducedMotionMs ? pair(r.sceneChangeReducedMotionMs) : "not measured")),
    ],
    [
      "Frame interval after a key press, p95 (over 20 ms)",
      ...per(
        (r) =>
          `${round(r.frameIntervalMs.p95, 1)} ms (${r.frameIntervalMs.over20} of ${round(r.frameIntervalMs.n)})`,
      ),
    ],
    ["JS heap after 50 scenes", ...per((r) => mb1(r.memoryAfter50.jsHeapMB))],
    ["Renderer memory after 50 scenes", ...per((r) => mb(r.memoryAfter50.rendererMB))],
    ["Renderer memory after a round trip", ...per((r) => mb(r.memoryAfterRound.rendererMB))],
    [
      "Bytes on the wire at first scene (Brotli), requests",
      ...per((r) => `${kb(wireTotal(r.wireBytes))}, ${r.wireBytes.requests}`),
    ],
  ];
  const empty = bench.emptyPage
    ? `\n\nAn empty page in the same Chrome used ${mb(bench.emptyPage.rendererMB)} of renderer memory and ${mb1(bench.emptyPage.jsHeapMB)} of JS heap.`
    : "";
  return `${table(["Measure", ...TOOLS.map((tool) => NAMES[tool])], rows)}${empty}`;
}

function budgets({ bench }) {
  const d = bench.results.depthcue;
  const gates = bench.gates ?? [];
  const sizeRows = gates.map((gate) => [
    gate.name,
    `${kb(gate.actual)} ${gate.metric}`,
    kb(gate.limitBytes),
    gate.ok ? "within" : "over",
  ]);
  const verdict = (value, target) => (value <= target ? "within" : "over");
  const measured = [
    [
      "Cold open to usable first scene, p95",
      "1.5 s",
      ms(d.coldOpenMs.p95),
      verdict(d.coldOpenMs.p95, TARGETS.coldOpenP95Ms),
    ],
    [
      "Scene change to first visible response, p95",
      "50 ms",
      ms(d.sceneChangeMs.p95),
      verdict(d.sceneChangeMs.p95, TARGETS.sceneChangeP95Ms),
    ],
    [
      "Scene change with reduced motion, p95",
      "50 ms",
      d.sceneChangeReducedMotionMs ? ms(d.sceneChangeReducedMotionMs.p95) : "not measured",
      d.sceneChangeReducedMotionMs
        ? verdict(d.sceneChangeReducedMotionMs.p95, TARGETS.sceneChangeP95Ms)
        : "not measured",
    ],
    [
      "Tab memory after 50 scenes",
      "200 MB",
      `${mb(d.memoryAfter50.rendererMB)} renderer${bench.emptyPage ? `, ${mb(bench.emptyPage.rendererMB)} for an empty page` : ""}`,
      verdict(d.memoryAfter50.rendererMB, TARGETS.tabMemoryMB),
    ],
    [
      "Animation frame work in core, p95",
      "10 ms",
      `not measured; frame interval p95 ${round(d.frameIntervalMs.p95, 1)} ms`,
      "not measured",
    ],
  ];
  return [
    "Measured in a browser on this machine (Depthcue only):",
    "",
    table(["Budget", "Target", "Measured", "Verdict"], measured),
    "",
    "Size gates that CI enforces on every change, as built for this run:",
    "",
    table(["File", "Measured", "Limit", "Verdict"], sizeRows),
  ].join("\n");
}

function edit({ edit: data }) {
  const row = (name, arm) => [name, `${arm.passed} of ${arm.of}`, round(arm.chars)];
  const ratio = data.rewrite.chars / data.ops.chars;
  return [
    table(
      ["Way of answering", "Edits that worked", "Characters written"],
      [row("deck_apply operations", data.ops), row("Whole-file rewrites", data.rewrite)],
    ),
    "",
    `The operations are ${round(ratio, 1)} times smaller than the rewrites for the same twelve edits.`,
  ].join("\n");
}

function stale({ stale: data }) {
  const rows = TOOLS.map((tool) => {
    const r = data[tool];
    return [
      NAMES[tool],
      r.secondWasWarned ? `refused, exit ${r.secondExit}` : "saved without a warning",
      yes(r.firstEditKept),
      yes(r.secondEditKept),
    ];
  });
  return table(
    ["Tool", "Second writer's save", "First writer's edit kept", "Second writer's edit kept"],
    rows,
  );
}

function deliverables({ verify }) {
  const tools = TOOLS.filter((tool) => verify[tool]);
  const rows = [
    ["Opens from file:// with the network blocked", ...tools.map((tool) => yes(verify[tool].opens))],
    [
      "Requests blocked or failed",
      ...tools.map(
        (tool) => `${verify[tool].blockedRequests} blocked, ${verify[tool].failedRequests} failed`,
      ),
    ],
    ["Console errors on load", ...tools.map((tool) => String(verify[tool].problems.length))],
    ["Revised heading present", ...tools.map((tool) => yes(verify[tool].content.chartHeadingRevised))],
    [
      "Old numbers still anywhere in the folder",
      ...tools.map((tool) => yes(verify[tool].content.staleTextInFolder)),
    ],
    [
      "Scene 4 heading exactly as the brief wrote it",
      ...tools.map((tool) => yes(verify[tool].content.risksHeadingExact)),
    ],
    [
      "Speaker notes in the folder, shown on the slides",
      ...tools.map(
        (tool) =>
          `${verify[tool].notes.inDeliverable} of ${verify[tool].notes.found}, ${verify[tool].notes.visibleOnSlides}`,
      ),
    ],
    ["Text outside the viewport", ...tools.map((tool) => yes(verify[tool].offViewport.length > 0))],
  ];
  return table(["Check on the delivered folder", ...tools.map((tool) => NAMES[tool])], rows);
}

/** The headline numbers, lifted from the data so the text at the top of the document cannot drift from it. */
function summary({ bench, agents: data, stale: staleData }) {
  const each = (pick) => TOOLS.map((tool) => `${NAMES[tool]} ${pick(bench.results[tool], tool)}`).join(", ");
  const refused = TOOLS.filter((tool) => staleData[tool].secondWasWarned).map((tool) => NAMES[tool]);
  const depthcue = bench.results.depthcue;
  return [
    `- Cold open to the first scene, p95: ${each((r, tool) => `${ms(r.coldOpenMs.p95)}${tool === "stagecraft" ? " (to a welcome screen that then needs a key)" : ""}`)}.`,
    `- Scene change, p95: ${each((r) => ms(r.sceneChangeMs.p95))}. Depthcue with reduced motion: ${depthcue.sceneChangeReducedMotionMs ? ms(depthcue.sceneChangeReducedMotionMs.p95) : "not measured"}.`,
    `- Bytes on the wire at the first scene: ${each((r) => kb(wireTotal(r.wireBytes)))}.`,
    `- Agent runs, calls and seconds (one run each): ${TOOLS.map((tool) => `${NAMES[tool]} ${Object.values(data.tools[tool].results).reduce((sum, row) => sum + row.calls, 0)} and ${data.tools[tool].totalSeconds}`).join(", ")}.`,
    `- A save from a stale copy was refused by: ${refused.length ? refused.join(", ") : "none of the three"}.`,
  ].join("\n");
}

export function renderBlocks(data) {
  return {
    summary: summary(data),
    machine: machine(data),
    agents: agents(data),
    "agent-notes": agentNotes(data),
    speed: speed(data),
    budgets: budgets(data),
    edit: edit(data),
    stale: stale(data),
    deliverables: deliverables(data),
  };
}

const marker = (kind, name) => `<!-- trial:${kind} ${name} -->`;

/** Puts each block between its markers in the document text. A missing marker pair is an error, not a skip. */
export function splice(text, blocks) {
  let out = text;
  for (const [name, body] of Object.entries(blocks)) {
    const start = out.indexOf(marker("begin", name));
    const end = out.indexOf(marker("end", name));
    if (start < 0 || end < start) {
      throw new Error(`docs/TRIAL.md has no "${marker("begin", name)}" and "${marker("end", name)}" pair`);
    }
    const from = start + marker("begin", name).length;
    out = `${out.slice(0, from)}\n\n${body}\n\n${out.slice(end)}`;
  }
  return out;
}

/** The names of the generated blocks the document declares. */
export const declaredBlocks = (text) =>
  [...text.matchAll(/<!-- trial:begin ([a-z-]+) -->/g)].map((m) => m[1]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = readDocument();
  const next = splice(current, renderBlocks(load()));
  if (process.argv.includes("--check")) {
    if (next !== current) {
      console.error("docs/TRIAL.md is out of date with docs/trial/*.json. Run: node tools/trial/report.mjs");
      process.exit(1);
    }
    console.log("docs/TRIAL.md matches its result files");
  } else {
    writeFileSync(TRIAL_DOC, next);
    console.log("wrote docs/TRIAL.md");
  }
}
