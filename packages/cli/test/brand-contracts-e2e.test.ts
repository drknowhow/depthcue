// A branded deck through the real CLI: `depthcue check`, `rev` and `apply` on a copy of fixtures/decks/v0-4-brand, with
// the files on disk checked after each step. The brand operations an agent sends through `depthcue apply` must write
// exactly what the same operations applied in core produce, so the CLI cannot grow its own idea of a brand.
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps, docToFiles, loadDoc, type Op, revisionOf } from "@depthcue/core";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));
const plain = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copy(from = fixture): string {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-brand-"));
  temps.push(dir);
  cpSync(from, dir, { recursive: true });
  return dir;
}

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, lines, errors, text: [...lines, ...errors].join("\n") };
}

function opsFile(ops: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-ops-"));
  temps.push(dir);
  const file = join(dir, "ops.json");
  writeFileSync(file, JSON.stringify(ops));
  return file;
}

const rev = async (dir: string) => (await cli("rev", dir)).lines[0] as string;
const apply = async (dir: string, ops: Op[]) => cli("apply", dir, opsFile(ops), "--base-rev", await rev(dir));
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const readJson = (dir: string, path: string) => JSON.parse(read(dir, path));

/** Every file of a deck folder, by deck-relative path, with its text. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

const STYLE: Op = {
  op: "style.set",
  id: "figure",
  style: { name: "Figure", for: ["chart", "table"], pad: "s" },
};
const TEMPLATE: Op = {
  op: "template.set",
  id: "quote-wall",
  template: {
    name: "Quote wall",
    description: "Up to two things customers said, large, with nothing else on the slide.",
    background: { color: "surface" },
    slots: [
      {
        id: "quotes",
        frame: { x: 8, y: 16, w: 84, h: 68 },
        accepts: ["quote"],
        max: 2,
        required: true,
        hint: "What a customer said, in their words.",
      },
    ],
  },
};
const BRAND_OPS: Op[] = [
  { op: "brand.set", set: { name: "Harbor Group", chart: ["#0B6E6E", "#2D4BB8"] } },
  STYLE,
  TEMPLATE,
  { op: "block.set", scene: "growth", id: "growth-chart", set: { style: "figure" } },
];
/** Moves the growth scene off the brand's chart-and-note template, onto Depthcue's own two-column one. */
const OFF_CHART_AND_NOTE: Op[] = [
  { op: "scene.set", id: "growth", set: { template: "two-column" } },
  { op: "block.set", scene: "growth", id: "growth-chart", set: { slot: "left" } },
  { op: "block.set", scene: "growth", id: "growth-note", set: { slot: "right" } },
];

describe("a branded deck through the CLI", () => {
  it("checks clean, and prints the revision core computes", async () => {
    const dir = copy();
    const check = await cli("check", dir);
    expect(check.code).toBe(0);
    expect(check.lines.at(-1)).toBe("0 errors, 0 warnings");
    const { doc } = loadDoc(loadDeckDir(dir));
    expect(await rev(dir)).toBe(revisionOf(doc as NonNullable<typeof doc>));
  });

  it("applies brand.set, style.set and template.set and writes only the files they change", async () => {
    const dir = copy();
    const before = snapshot(dir);
    const result = await apply(dir, BRAND_OPS);
    expect(result.code, result.text).toBe(0);
    expect(result.lines.slice(1).sort()).toEqual(
      [
        "  wrote brand/brand.json",
        "  wrote brand/templates/quote-wall.json",
        "  wrote scenes/growth.json",
      ].sort(),
    );
    const brand = readJson(dir, "brand/brand.json");
    expect(brand).toMatchObject({ name: "Harbor Group", chart: ["#0B6E6E", "#2D4BB8"] });
    expect(brand.styles.figure).toEqual({ name: "Figure", for: ["chart", "table"], pad: "s" });
    expect(readJson(dir, "brand/templates/quote-wall.json")).toMatchObject({
      schemaVersion: "0.4",
      id: "quote-wall",
    });
    expect(readJson(dir, "scenes/growth.json").blocks[1].style).toBe("figure");
    const after = snapshot(dir);
    for (const path of [
      "deck.json",
      "scenes/welcome.json",
      "brand/templates/cover.json",
      "brand/logos/harbor.svg",
    ]) {
      expect(after[path], path).toBe(before[path]);
    }
    expect((await cli("check", dir)).lines.at(-1)).toBe("0 errors, 0 warnings");
  });

  it("writes exactly what the same operations applied in core write", async () => {
    const dir = copy();
    const ops = [
      ...BRAND_OPS,
      ...OFF_CHART_AND_NOTE,
      { op: "template.set", id: "chart-and-note", template: null },
    ];
    const { doc } = loadDoc(loadDeckDir(fixture));
    if (!doc) throw new Error("the fixture should load");
    const core = applyOps(doc, ops, revisionOf(doc));
    if (!core.ok) throw new Error(JSON.stringify(core.diagnostics));
    expect((await apply(dir, ops as Op[])).code).toBe(0);
    // review.json is the review the agent's first edit starts, beside the deck rather than part of it.
    const { "review.json": review, ...disk } = snapshot(dir);
    expect(review).toBeDefined();
    const expected = docToFiles(core.doc);
    const was = docToFiles(doc);
    expect(
      Object.keys(disk)
        .filter((path) => path.endsWith(".json"))
        .sort(),
    ).toEqual(Object.keys(expected).sort());
    // A file the operations changed has core's text to the byte; one they did not keep is left as it was formatted.
    for (const [path, text] of Object.entries(expected)) {
      if (text !== was[path]) expect(disk[path], path).toBe(text);
      else expect(JSON.parse(disk[path] as string), path).toEqual(JSON.parse(text));
    }
    expect(await rev(dir)).toBe(core.rev);
  });

  it("removes a template file only when an operation removed the template", async () => {
    const dir = copy();
    writeFileSync(join(dir, "brand", "templates", "notes.txt"), "Kept: not a template.");
    const result = await apply(dir, [
      ...OFF_CHART_AND_NOTE,
      { op: "template.set", id: "chart-and-note", template: null },
    ]);
    expect(result.code, result.text).toBe(0);
    expect(result.lines).toContain("  wrote brand/templates/chart-and-note.json");
    expect(existsSync(join(dir, "brand", "templates", "chart-and-note.json"))).toBe(false);
    expect(existsSync(join(dir, "brand", "templates", "cover.json"))).toBe(true);
    expect(read(dir, "brand/templates/notes.txt")).toBe("Kept: not a template.");
    expect((await cli("check", dir)).code).toBe(0);
  });

  it("reads every JSON file of the templates folder, and refuses one not named for a template id", async () => {
    const dir = copy();
    writeFileSync(join(dir, "brand", "templates", "__proto__.json"), JSON.stringify({ evil: 1 }));
    expect(loadDeckDir(dir).text["brand/templates/__proto__.json"]).toBe('{"evil":1}');
    const check = await cli("check", dir);
    expect(check.code).toBe(1);
    expect(check.text).toContain(
      'brand/templates/__proto__.json  error  "__proto__" is not a template id, so this file holds no template.',
    );
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it("refuses an operation that leaves a scene on a removed template, and writes nothing", async () => {
    const dir = copy();
    const before = snapshot(dir);
    const result = await apply(dir, [{ op: "template.set", id: "cover", template: null }]);
    expect(result.code).toBe(1);
    expect(result.text).toContain('scenes/welcome.json/template  error  There is no template "cover".');
    expect(snapshot(dir)).toEqual(before);
  });

  it("takes the brand off with brand.set null, keeping the brand's binary files", async () => {
    const dir = copy();
    const result = await apply(dir, [
      { op: "scene.set", id: "welcome", set: { template: "section" } },
      { op: "block.set", scene: "welcome", id: "welcome-byline", set: { slot: "lede" } },
      { op: "scene.set", id: "growth", set: { template: null, layout: "text-media" } },
      ...["growth-title", "growth-chart", "growth-note"].map(
        (id): Op => ({ op: "block.set", scene: "growth", id, set: { slot: null } }),
      ),
      { op: "block.set", scene: "context", id: "context-kicker", set: { style: null } },
      { op: "block.set", scene: "context", id: "context-body", set: { style: null } },
      { op: "brand.set", set: null },
    ]);
    expect(result.code, result.text).toBe(0);
    expect(readJson(dir, "deck.json").brand).toBeUndefined();
    for (const path of [
      "brand/brand.json",
      "brand/templates/cover.json",
      "brand/templates/chart-and-note.json",
    ]) {
      expect(existsSync(join(dir, path)), path).toBe(false);
    }
    expect(existsSync(join(dir, "brand", "logos", "harbor.svg"))).toBe(true);
    expect((await cli("check", dir)).lines.at(-1)).toBe("0 errors, 0 warnings");
  });

  it("gives a deck without a brand one with brand.set, and warns of a brand folder deck.json does not name", async () => {
    const dir = copy(plain);
    const result = await apply(dir, [{ op: "brand.set", set: { id: "acme", name: "Acme" } }]);
    expect(result.code, result.text).toBe(0);
    expect(readJson(dir, "deck.json")).toMatchObject({ schemaVersion: "0.4", brand: "acme" });
    expect(readJson(dir, "brand/brand.json")).toEqual({ schemaVersion: "0.4", id: "acme", name: "Acme" });
    expect((await cli("check", dir)).lines.at(-1)).toBe("0 errors, 0 warnings");

    const stray = copy(plain);
    cpSync(join(fixture, "brand"), join(stray, "brand"), { recursive: true });
    const check = await cli("check", stray);
    expect(check.code).toBe(0);
    expect(check.text).toContain(
      "brand/brand.json  warning  The deck folder has brand files, but deck.json names no brand, so none of it is used.",
    );
    expect(check.lines.at(-1)).toBe("0 errors, 1 warning");
  });
});
