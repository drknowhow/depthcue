// `depthcue brand import` end to end: every kind of test file is imported through the real CLI, the folder it writes is
// put in a deck as that deck's brand, and `depthcue check` (the same brand checks an agent runs) holds the result. The
// scenes use every template the import made, with a block in each slot that takes text, so a slot the import drew wrongly
// or a template the contract refuses shows up as a failing check here and not in front of a reader.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import {
  DARK,
  type Imported,
  importFixture,
  jpeg,
  LAYOUTS,
  type PackageSpec,
  svg,
  temporaryFolders,
  writeFixture,
} from "./brand-import-fixtures.ts";

const make = temporaryFolders();
const decks = fileURLToPath(new URL("../../../fixtures/decks", import.meta.url));

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, lines, errors, out: lines.join("\n"), err: errors.join("\n") };
}

/** Every file of a folder by its path from the folder, with its text. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(dir, full).split(sep).join("/")] = readFileSync(full, "latin1");
    }
  };
  walk(dir);
  return files;
}

const TEXT_KINDS = ["body", "caption", "quote", "heading"] as const;

/**
 * A deck that uses an imported brand: the brand folder copied in as it was written (marker and all), one scene for each
 * template, and in each scene a short text block in every slot that takes text.
 */
function deckWith(imported: Imported, templates = imported.report.templates): string {
  const dir = make();
  cpSync(imported.out, join(dir, "brand"), { recursive: true });
  const scenes = templates.map((template) => template.id);
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
  };
  write("deck.json", {
    schemaVersion: "0.4",
    id: "imported-brand",
    title: "A deck in an imported brand",
    language: "en",
    theme: imported.report.preset.name,
    brand: imported.report.brand.id,
    scenes,
  });
  for (const template of templates) {
    const blocks = template.slots.flatMap((slot) => {
      const role = TEXT_KINDS.find((kind) => slot.accepts.includes(kind));
      if (!role) return [];
      return [
        {
          id: `${template.id}-${slot.id}`,
          type: "text",
          role: slot.role === "title" ? "heading" : role,
          text: slot.role === "title" ? `A slide made from ${template.name}` : "A short line for this slot.",
          slot: slot.id,
        },
      ];
    });
    write(`scenes/${template.id}.json`, {
      schemaVersion: "0.4",
      id: template.id,
      title: template.name,
      template: template.id,
      blocks,
    });
  }
  return dir;
}

/** Imports through the CLI, as a person would, and returns what came out. */
async function importWithCli(spec: PackageSpec, name = "Harbor") {
  const folder = make();
  const { file, out } = await writeFixture(folder, spec, name);
  const result = await cli("brand", "import", file, "--out", out, "--json");
  return { folder, file, out, result };
}

const FILES: Array<[string, PackageSpec]> = [
  ["a light template", {}],
  ["a dark template", { dark: true, colors: DARK }],
  ["a presentation with slides", { kind: "pptx", slides: 3 }],
  ["a theme file the way PowerPoint saves it", { kind: "thmx", variants: 2 }],
  ["a 4:3 template", { size: { cx: 9144000, cy: 6858000 } }],
  ["a template with embedded fonts", { embeddedFonts: ["Harbor Sans"] }],
  ["a template whose logo is an SVG", { media: { "logo.png": svg() } }],
  ["a template whose logo is a JPEG", { media: { "logo.png": jpeg(120, 48) } }],
  [
    "a template with a muted color that fails and goes back to the preset's",
    { colors: { ...DARK, dk2: "9A9A9A" } },
  ],
];

describe("an imported brand in a deck", () => {
  it.each(FILES)("%s passes depthcue check with every one of its templates in use", async (_name, spec) => {
    const imported = await importFixture(make, spec);
    expect(imported.report.templates.length).toBeGreaterThan(0);
    const dir = deckWith(imported);
    const check = await cli("check", dir);
    expect(check.err).toBe("");
    expect(check.lines.at(-1)).toMatch(/^0 errors, \d+ warnings$/);
    expect(check.code).toBe(0);
  });

  it("has no warning but the one about a face the folder holds no file for", async () => {
    const imported = await importFixture(make, { fonts: { major: "Arial", minor: "Arial" } });
    const check = await cli("check", deckWith(imported));
    const warnings = check.lines.filter((line) => /\bwarning\b/.test(line));
    expect(warnings).toHaveLength(2);
    for (const line of warnings) expect(line).toContain('The deck carries no file for "Arial"');
    expect(check.lines.at(-1)).toBe("0 errors, 2 warnings");
    expect(check.code).toBe(0);
  });

  it("is the brand the deck names, with the templates the report lists", async () => {
    const imported = await importFixture(make);
    const dir = deckWith(imported);
    const written = readdirSync(join(dir, "brand", "templates")).map((name) => name.replace(/\.json$/, ""));
    expect(written.sort()).toEqual(imported.report.templates.map((template) => template.id).sort());
    expect(JSON.parse(readFileSync(join(dir, "brand", "brand.json"), "utf8")).id).toBe(
      imported.report.brand.id,
    );
  });

  it("keeps the marker file in the deck's brand folder without upsetting depthcue check", async () => {
    const imported = await importFixture(make);
    const dir = deckWith(imported);
    expect(existsSync(join(dir, "brand", ".depthcue-brand-import"))).toBe(true);
    expect((await cli("check", dir)).code).toBe(0);
  });

  it("checks the same through the CLI's own import as through importBrand", async () => {
    const { out, result } = await importWithCli({});
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.ok).toBe(true);
    expect(report.errors).toBe(0);
    expect(readdirSync(out).sort()).toEqual([".depthcue-brand-import", "brand.json", "logos", "templates"]);
    const direct = await importFixture(make, {});
    expect(snapshot(out)).toEqual(snapshot(direct.out));
  });

  it("can be changed with the operations any brand takes", async () => {
    const imported = await importFixture(make);
    const dir = deckWith(imported);
    const folder = make();
    const ops = join(folder, "ops.json");
    writeFileSync(
      ops,
      JSON.stringify([
        { op: "style.set", id: "figure", style: { name: "Figure", for: ["chart", "table"], pad: "s" } },
      ]),
    );
    const rev = (await cli("rev", dir)).lines[0] as string;
    const applied = await cli("apply", dir, ops, "--base-rev", rev);
    expect(applied.code, applied.err).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "brand", "brand.json"), "utf8")).styles.figure.pad).toBe("s");
    expect((await cli("check", dir)).code).toBe(0);
  });
});

describe("a second import into the same folder", () => {
  it("replaces the first, so nothing of it stays, and the deck made from the second checks clean", async () => {
    const folder = make();
    const first = await writeFixture(folder, {}, "First");
    const second = await writeFixture(
      folder,
      { layouts: [LAYOUTS[0] as (typeof LAYOUTS)[number]], kind: "thmx" },
      "Second",
    );
    const out = first.out;

    expect((await cli("brand", "import", first.file, "--out", out)).code).toBe(0);
    expect(readdirSync(join(out, "templates")).sort()).toEqual([
      "title-and-content.json",
      "title-slide.json",
      "two-content.json",
    ]);

    const again = await cli("brand", "import", second.file, "--out", out, "--json");
    expect(again.code, again.err).toBe(0);
    const report = JSON.parse(again.out);
    expect(readdirSync(join(out, "templates"))).toEqual(["title-slide.json"]);
    expect(JSON.parse(readFileSync(join(out, "brand.json"), "utf8")).id).toBe("second");
    expect(readdirSync(out).sort()).toEqual(
      [...new Set(report.files.map((file: string) => file.split("/")[0]))].sort() as string[],
    );

    const imported: Imported = {
      report,
      diagnostics: [],
      file: second.file,
      out,
      read: (path) => readFileSync(join(out, path), "utf8"),
      bytes: (path) => new Uint8Array(readFileSync(join(out, path))),
      json: (path) => JSON.parse(readFileSync(join(out, path), "utf8")),
    };
    expect((await cli("check", deckWith(imported))).code).toBe(0);
  });

  it("leaves a folder that is not its own, and a folder it could not finish with, exactly as they were", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "notes.txt"), "the owner's notes");
    const before = snapshot(out);
    const refused = await cli("brand", "import", file, "--out", out);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain(out);
    expect(snapshot(out)).toEqual(before);

    const portrait = await writeFixture(make(), { size: { cx: 6858000, cy: 12192000 } }, "Tall");
    const good = await cli("brand", "import", file, "--out", portrait.out);
    expect(good.code).toBe(0);
    const imported = snapshot(portrait.out);
    expect((await cli("brand", "import", portrait.file, "--out", portrait.out)).code).toBe(1);
    expect(snapshot(portrait.out)).toEqual(imported);
  });
});

describe("the decks that were here before", () => {
  const old = ["v0-1", "v0-2", "v0-3", "demo", "charts", "v0-4-brand"];

  it.each(old)(
    "%s still checks clean, and importing a brand next to it changes nothing in it",
    async (name) => {
      const dir = make();
      cpSync(join(decks, name), dir, { recursive: true });
      const before = snapshot(dir);
      expect((await cli("check", dir)).out).toBe("0 errors, 0 warnings");

      const folder = make();
      const { file, out } = await writeFixture(folder);
      expect((await cli("brand", "import", file, "--out", out)).code).toBe(0);
      expect((await cli("check", dir)).out).toBe("0 errors, 0 warnings");
      expect(snapshot(dir)).toEqual(before);
    },
  );
});
