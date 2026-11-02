// `depthcue brand init`, `brand use`, `brand check` and `new`, through the real command line, on folders in a
// temporary directory. The render-backed checks are in brand-commands-e2e.test.ts; these need no browser.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESETS } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { checkBrandSource } from "../src/brand/check.ts";
import { idFromName, nameFromFolder, starterBrand } from "../src/brand/init.ts";
import { readUseRecord, USE_RECORD } from "../src/brand/record.ts";
import { BrandFolderError, readBrandFolder } from "../src/brand/source.ts";
import { run } from "../src/index.ts";
import { temporaryFolders } from "./brand-import-fixtures.ts";

const make = temporaryFolders();
const decks = fileURLToPath(new URL("../../../fixtures/decks", import.meta.url));
const harborBrand = join(decks, "v0-4-brand", "brand");
const tidewellBrand = join(decks, "tidewell-press", "brand");

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

/** Every file of a folder by its path from the folder, with its bytes as text. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(dir, full).split(sep).join("/")] = readFileSync(full, "latin1");
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const copyDeck = (name: string): string => {
  const dir = make();
  cpSync(join(decks, name), dir, { recursive: true });
  return dir;
};
const write = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};
// biome-ignore lint/suspicious/noExplicitAny: a test helper that reads the JSON file a test names
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

async function initBrand(name = "Acme Widgets"): Promise<string> {
  const dir = join(make(), "acme-brand");
  const made = await cli("brand", "init", dir, "--name", name);
  expect(made.code).toBe(0);
  return dir;
}

/** The deck's revision, and an ops file applied through `depthcue apply`. */
async function apply(deck: string, ops: unknown[]) {
  const rev = (await cli("rev", deck)).out;
  const file = join(make(), "ops.json");
  write(file, ops);
  return cli("apply", deck, file, "--base-rev", rev);
}

describe("the ids and names brand init makes", () => {
  it.each([
    ["Acme Widgets", "acme-widgets"],
    ["  Café  Société ", "cafe-societe"],
    ["2026 Annual", "brand-2026-annual"],
    ["!!", "brand"],
    ["A", "brand"],
    ["x".repeat(100), "x".repeat(64)],
    ["Harbor & Co. (UK)", "harbor-co-uk"],
  ])("makes %j into %j", (name, id) => {
    expect(idFromName(name)).toBe(id);
    expect(id).toMatch(/^[a-z][a-z0-9-]{1,63}$/);
  });

  it("names a brand for its folder", () => {
    expect(nameFromFolder("somewhere/acme-widgets")).toBe("Acme Widgets");
    expect(nameFromFolder("somewhere/brand_kit.2")).toBe("Brand Kit 2");
  });
});

describe("depthcue brand init", () => {
  it("writes brand.json with both presets' palettes and a built-in pair, and nothing else", async () => {
    const dir = join(make(), "acme-widgets");
    const { code, out } = await cli("brand", "init", dir);
    expect(code).toBe(0);
    expect(out).toContain('Made the brand "Acme Widgets" (acme-widgets)');
    expect(Object.keys(snapshot(dir))).toEqual(["brand.json"]);
    const brand = json(join(dir, "brand.json"));
    expect(brand).toEqual(starterBrand("Acme Widgets"));
    expect(brand.schemaVersion).toBe("0.4");
    expect(brand.fonts).toBe("editorial");
    expect(brand.logos).toBeUndefined();
    expect(brand.styles).toBeUndefined();
    for (const theme of ["paper", "ink"] as const) {
      const { state: _state, "on-state": _onState, ...seven } = PRESETS[theme] as Record<string, string>;
      expect(brand.colors[theme]).toEqual(seven);
    }
    expect(brand.chrome).toEqual({
      footer: { text: "Acme Widgets", place: "start" },
      number: { place: "end" },
      accent: "top",
    });
  });

  it("passes brand check with no errors and no warnings, and uses the name it is given", async () => {
    const dir = join(make(), "kit");
    expect((await cli("brand", "init", dir, "--name", "Harbor & Co.")).code).toBe(0);
    expect(json(join(dir, "brand.json")).id).toBe("harbor-co");
    const checked = await cli("brand", "check", dir);
    expect(checked.code).toBe(0);
    expect(checked.out).toBe("0 errors, 0 warnings");
  });

  it("makes a missing folder and uses an empty one", async () => {
    const root = make();
    expect((await cli("brand", "init", join(root, "a", "b", "c"))).code).toBe(0);
    mkdirSync(join(root, "empty"));
    expect((await cli("brand", "init", join(root, "empty"))).code).toBe(0);
  });

  it("refuses a folder with anything in it, and a file, and writes nothing", async () => {
    const root = make();
    write(join(root, "keep.txt"), "mine");
    const full = await cli("brand", "init", root);
    expect(full.code).toBe(2);
    expect(full.err).toContain("has files in it, so nothing was written");
    expect(snapshot(root)).toEqual({ "keep.txt": "mine" });
    const file = await cli("brand", "init", join(root, "keep.txt"));
    expect(file.code).toBe(2);
    expect(file.err).toContain("is a file");
  });

  it("refuses a name that is empty or too long", async () => {
    const dir = join(make(), "x");
    expect((await cli("brand", "init", dir, "--name", "   ")).code).toBe(2);
    expect((await cli("brand", "init", dir, "--name", "n".repeat(81))).err).toContain("--name needs 1 to 80");
    expect(existsSync(dir)).toBe(false);
  });

  it("answers --json with what it made, and with why it did not", async () => {
    const dir = join(make(), "acme-widgets");
    const made = JSON.parse((await cli("brand", "init", dir, "--json")).out);
    expect(made).toEqual({ ok: true, dir, id: "acme-widgets", name: "Acme Widgets", files: ["brand.json"] });
    const again = await cli("brand", "init", dir, "--json");
    expect(again.code).toBe(2);
    expect(JSON.parse(again.out)).toMatchObject({ ok: false });
  });
});

describe("depthcue brand check", () => {
  it("passes the Harbor fixture's brand folder and its deck", async () => {
    expect(await cli("brand", "check", harborBrand)).toMatchObject({ code: 0, out: "0 errors, 0 warnings" });
    expect(await cli("brand", "check", join(decks, "v0-4-brand"))).toMatchObject({
      code: 0,
      out: "0 errors, 0 warnings",
    });
  });

  it("passes the Tidewell fixture, with its own template over a built-in one", async () => {
    expect(await cli("brand", "check", tidewellBrand)).toMatchObject({
      code: 0,
      out: "0 errors, 0 warnings",
    });
  });

  it("says a deck has no brand, and still exits 0", async () => {
    const { code, out } = await cli("brand", "check", join(decks, "demo"));
    expect(code).toBe(0);
    expect(out).toBe("The deck has no brand.\n0 errors, 0 warnings");
  });

  it("reports a palette that cannot be read, on both of the presets it gives", async () => {
    const dir = await initBrand();
    const brand = json(join(dir, "brand.json"));
    brand.colors.paper.text = brand.colors.paper.bg;
    brand.colors.ink.text = brand.colors.ink.bg;
    write(join(dir, "brand.json"), brand);
    const { code, out } = await cli("brand", "check", dir);
    expect(code).toBe(1);
    expect(out).toMatch(/^brand\.json\/colors\/paper\/text {2}error {2}On paper slides/m);
    expect(out).toMatch(/^brand\.json\/colors\/ink\/text {2}error {2}On ink slides/m);
    expect(out).toMatch(/\d+ errors, 0 warnings$/);
  });

  it("reports a template file named for another id, from the brand folder, as a deck check does", async () => {
    const dir = await initBrand();
    write(join(dir, "templates", "wrong-name.json"), {
      schemaVersion: "0.4",
      id: "other",
      name: "Other",
      description: "A template whose file is named for another id.",
      slots: [
        {
          id: "title",
          role: "title",
          frame: { x: 6, y: 15, w: 88, h: 20 },
          accepts: ["heading"],
          hint: "A heading.",
        },
      ],
    });
    const { code, out } = await cli("brand", "check", dir);
    expect(code).toBe(1);
    expect(out).toContain("templates/wrong-name.json/id  error  The file is named for");
    expect(out).toMatch(/1 error, 0 warnings$/);
  });

  it("answers --json like a deck check does, with the brand's id", async () => {
    const found = JSON.parse((await cli("brand", "check", harborBrand, "--json")).out);
    expect(found).toMatchObject({
      ok: true,
      errors: 0,
      warnings: 0,
      kind: "brand",
      brand: { id: "harbor", name: "Harbor Analytics" },
      diagnostics: [],
    });
    const deck = JSON.parse((await cli("brand", "check", join(decks, "v0-4-brand"), "--json")).out);
    expect(deck).toMatchObject({ ok: true, kind: "deck", brand: { id: "harbor" } });
  });

  it("exits 2 for a folder that is not a brand, one that does not exist and a broken brand.json", async () => {
    const empty = make();
    expect((await cli("brand", "check", empty)).err).toContain(
      "has no brand.json, so it is not a brand folder",
    );
    expect((await cli("brand", "check", join(empty, "nope"))).code).toBe(2);
    write(join(empty, "brand.json"), "{ not json");
    const broken = await cli("brand", "check", empty);
    expect(broken.code).toBe(2);
    expect(broken.err).toContain("Could not read brand.json as JSON");
  });

  it("points a deck folder passed without its brand/ to the brand folder", () => {
    const dir = make();
    write(join(dir, "brand", "brand.json"), starterBrand("Acme"));
    expect(() => readBrandFolder(dir)).toThrow(/looks like a deck folder: give its brand folder/);
  });

  // A brand style named like one of Depthcue's own, made for headings only: the brand is sound, but the built-in
  // templates that give that style to a caption (`label` on the title template's byline) no longer fit it.
  const headingsOnlyLabel = {
    name: "Label",
    for: ["heading"],
    size: "l",
    tone: "text",
  };
  const withLabel = (extra: Record<string, unknown> = {}) => ({
    ...starterBrand("Acme"),
    styles: { label: headingsOnlyLabel },
    ...extra,
  });

  it("checks Depthcue's own templates under the brand's styles, as warnings only", () => {
    const { diagnostics } = checkBrandSource({ brand: withLabel(), templates: {}, binaries: new Map() });
    const built = diagnostics.filter((found) => found.code.startsWith("built-in-"));
    expect(built.length).toBeGreaterThan(0);
    expect(diagnostics.filter((found) => found.severity === "error")).toEqual([]);
    for (const found of built) {
      expect(found.severity).toBe("warning");
      expect(found.file).toBe("brand.json");
      expect(found.message).toMatch(/^Depthcue's own template "[a-z-]+"/);
    }
    expect(built.some((found) => found.message.startsWith('Depthcue\'s own template "title"'))).toBe(true);
  });

  it("reports them in brand check without failing it", async () => {
    const dir = make();
    write(join(dir, "brand.json"), withLabel());
    const { code, out } = await cli("brand", "check", dir);
    expect(code).toBe(0);
    expect(out).toContain('brand.json  warning  Depthcue\'s own template "title"');
    expect(out).toMatch(/0 errors, [1-9]\d* warnings?$/);
  });

  it("leaves a template out when the brand replaces it, and all of them when the brand hides them", () => {
    const own = {
      schemaVersion: "0.4",
      id: "title",
      name: "Title",
      description: "The brand's own opening slide.",
      slots: [
        {
          id: "name",
          role: "title",
          frame: { x: 8, y: 30, w: 84, h: 30 },
          accepts: ["heading"],
          hint: "The title.",
        },
      ],
    };
    const replaced = checkBrandSource({ brand: withLabel(), templates: { title: own }, binaries: new Map() });
    expect(replaced.diagnostics.filter((found) => found.message.includes('template "title"'))).toEqual([]);
    expect(replaced.diagnostics.some((found) => found.code.startsWith("built-in-"))).toBe(true);
    const hidden = checkBrandSource({
      brand: withLabel({ hideBuiltIn: ["templates"] }),
      templates: {},
      binaries: new Map(),
    });
    expect(hidden.diagnostics.filter((found) => found.code.startsWith("built-in-"))).toEqual([]);
  });
});

describe("the brand folder brand use reads", () => {
  it("reads brand.json, the templates and the files under fonts, logos and images, and nothing else", () => {
    const dir = make();
    write(join(dir, "brand.json"), starterBrand("Acme"));
    write(join(dir, "templates", "a-slide.json"), { id: "a-slide" });
    write(join(dir, "templates", "notes.txt"), "not a template");
    write(join(dir, "fonts", "Acme-Regular.woff2"), "font");
    write(join(dir, "logos", "deep", "mark.svg"), "<svg/>");
    write(join(dir, "images", "bg.png"), "png");
    write(join(dir, ".depthcue-brand-import"), "{}");
    write(join(dir, "README.md"), "mine");
    const source = readBrandFolder(dir);
    expect(Object.keys(source.templates)).toEqual(["a-slide"]);
    expect([...source.binaries.keys()].sort()).toEqual([
      "fonts/Acme-Regular.woff2",
      "images/bg.png",
      "logos/deep/mark.svg",
    ]);
  });

  it("refuses a link inside the folder, a name a brand cannot carry, and a folder that is a file", () => {
    const dir = make();
    const elsewhere = make();
    write(join(elsewhere, "secret.txt"), "not part of any brand");
    write(join(dir, "brand.json"), starterBrand("Acme"));
    symlinkSync(elsewhere, join(dir, "fonts"), "junction");
    expect(() => readBrandFolder(dir)).toThrow(BrandFolderError);
    expect(() => readBrandFolder(dir)).toThrow(/fonts is a link/);
    rmSync(join(dir, "fonts"), { recursive: true });
    write(join(dir, "logos", ".hidden.svg"), "x");
    expect(() => readBrandFolder(dir)).toThrow(/has a name a brand cannot carry/);
    rmSync(join(dir, "logos"), { recursive: true });
    write(join(dir, "images"), "a file");
    expect(() => readBrandFolder(dir)).toThrow(/images is not a folder/);
  });
});

describe("depthcue brand use", () => {
  it("copies a brand into a deck as the deck's own files and leaves a record of each", async () => {
    const deck = copyDeck("v0-3");
    const before = snapshot(deck);
    const brand = await initBrand();
    const { code, out } = await cli("brand", "use", brand, deck);
    expect(code).toBe(0);
    expect(out).toContain('Brand "Acme Widgets" (acme-widgets) is now the brand of');
    const after = snapshot(deck);
    // Scenes and assets are as they were; deck.json names the brand; brand.json is the brand's, normalized.
    for (const [path, text] of Object.entries(before)) {
      if (path !== "deck.json") expect(after[path], path).toBe(text);
    }
    expect(json(join(deck, "deck.json"))).toMatchObject({ brand: "acme-widgets", schemaVersion: "0.4" });
    expect(json(join(deck, "brand", "brand.json"))).toEqual(starterBrand("Acme Widgets"));
    const record = readUseRecord(deck);
    expect(record?.brand).toBe("acme-widgets");
    expect([...(record?.files ?? [])]).toEqual([["brand.json", [sha(after["brand/brand.json"] as string)]]]);
    expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");
  });

  it("copies fonts, logos and images byte for byte, as plain files, and not the import marker or other files", async () => {
    const deck = copyDeck("demo");
    const brand = make();
    cpSync(harborBrand, brand, { recursive: true });
    write(join(brand, ".depthcue-brand-import"), '{"format":"depthcue-brand-import/1","files":{}}');
    write(join(brand, "NOTES.md"), "the author's own");
    const { code, out } = await cli("brand", "use", brand, deck);
    expect(code).toBe(0);
    expect(out).toContain("copied brand/fonts/HarborSans-Bold.woff2");
    expect(out).toContain("copied brand/logos/harbor.svg");
    const files = snapshot(deck);
    expect(files).not.toHaveProperty([".depthcue-brand-import"]);
    expect(Object.keys(files).filter((path) => path.startsWith("brand/"))).toEqual([
      "brand/.depthcue-brand-use",
      "brand/brand.json",
      "brand/fonts/HarborSans-Bold.woff2",
      "brand/fonts/HarborSans-Regular.woff2",
      "brand/fonts/OFL.txt",
      "brand/logos/harbor.svg",
      "brand/templates/chart-and-note.json",
      "brand/templates/cover.json",
    ]);
    for (const path of [
      "fonts/HarborSans-Bold.woff2",
      "fonts/HarborSans-Regular.woff2",
      "logos/harbor.svg",
    ]) {
      expect(readFileSync(join(deck, "brand", path)).equals(readFileSync(join(brand, path)))).toBe(true);
      const found = lstatSync(join(deck, "brand", path));
      expect(found.isFile() && !found.isSymbolicLink()).toBe(true);
    }
    // The record has the hash of every file, as written into the deck.
    const record = readUseRecord(deck);
    for (const [path, accepted] of record?.files ?? []) {
      expect(accepted, path).toEqual([sha(readFileSync(join(deck, "brand", path)))]);
    }
    expect([...(record?.files.keys() ?? [])]).toEqual([
      "brand.json",
      "fonts/HarborSans-Bold.woff2",
      "fonts/HarborSans-Regular.woff2",
      "fonts/OFL.txt",
      "logos/harbor.svg",
      "templates/chart-and-note.json",
      "templates/cover.json",
    ]);
    expect((await cli("check", deck)).code).toBe(0);
  });

  it("goes through the revision guard, so the revision moves, and starts a review of what it did", async () => {
    const deck = copyDeck("demo");
    const brand = await initBrand();
    const before = (await cli("rev", deck)).out;
    const used = JSON.parse((await cli("brand", "use", brand, deck, "--json")).out);
    expect(used).toMatchObject({ ok: true, replaced: null, upToDate: false, prevRev: before });
    expect(used.rev).toBe((await cli("rev", deck)).out);
    expect(used.rev).not.toBe(before);
    expect(used.written).toEqual(["brand/brand.json", "deck.json"]);
    // The agent's way in is the way into the review: the brand change is listed with the scenes' own.
    const listed = await cli("diff", deck);
    expect(listed.out).toContain("brand");
  });

  it("does nothing the second time, and says so", async () => {
    const deck = copyDeck("demo");
    const brand = make();
    cpSync(harborBrand, brand, { recursive: true });
    expect((await cli("brand", "use", brand, deck)).code).toBe(0);
    const once = snapshot(deck);
    const again = await cli("brand", "use", brand, deck);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Nothing to do:");
    expect(snapshot(deck)).toEqual(once);
    expect(JSON.parse((await cli("brand", "use", brand, deck, "--json")).out)).toMatchObject({
      ok: true,
      upToDate: true,
      written: [],
      copied: [],
      removed: [],
    });
  });

  it("replaces a brand it copied, and removes the files of the old one the new one lacks", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    expect(existsSync(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"))).toBe(true);
    // Harbor has no scene on its own templates in this deck, so another brand can take its place.
    const acme = await initBrand();
    const replaced = await cli("brand", "use", acme, deck);
    expect(replaced.code).toBe(0);
    expect(replaced.out).toContain(
      'Brand "Acme Widgets" (acme-widgets) replaced "Harbor Analytics" (harbor)',
    );
    expect(replaced.out).toContain("removed brand/fonts/HarborSans-Bold.woff2");
    expect(Object.keys(snapshot(deck)).filter((path) => path.startsWith("brand/"))).toEqual([
      "brand/.depthcue-brand-use",
      "brand/brand.json",
    ]);
    expect(existsSync(join(deck, "brand", "templates"))).toBe(false);
    expect(json(join(deck, "deck.json")).brand).toBe("acme-widgets");
    expect((await cli("check", deck)).code).toBe(0);
    // The record is the final one: only what is in the deck now, each file with the one hash it has, no hash for a
    // file that was removed or one under way.
    expect(readUseRecord(deck)).toEqual({
      brand: "acme-widgets",
      files: new Map([["brand.json", [sha(readFileSync(join(deck, "brand", "brand.json")))]]]),
    });
  });

  it("keeps a file of the old brand that was changed since, and says so", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    writeFileSync(join(deck, "brand", "fonts", "OFL.txt"), "edited by hand");
    const acme = await initBrand();
    const forced = await cli("brand", "use", acme, deck, "--force");
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("kept brand/fonts/OFL.txt (was changed after it was copied)");
    // --force allowed for it, and it was not replaced.
    expect(forced.out).not.toContain("although it was changed after it was copied");
    expect(readFileSync(join(deck, "brand", "fonts", "OFL.txt"), "utf8")).toBe("edited by hand");
    expect(readUseRecord(deck)?.files.has("fonts/OFL.txt")).toBe(false);
  });

  describe("refuses to replace a brand that is not as brand use left it", () => {
    async function branded() {
      const deck = copyDeck("demo");
      const brand = make();
      cpSync(harborBrand, brand, { recursive: true });
      expect((await cli("brand", "use", brand, deck)).code).toBe(0);
      return { deck, brand };
    }

    it("naming a template changed with apply, and replaces it with --force", async () => {
      const { deck, brand } = await branded();
      const edited = await apply(deck, [
        { op: "style.set", id: "loud", style: { name: "Loud", for: ["heading"], weight: "bold" } },
      ]);
      expect(edited.code).toBe(0);
      const before = snapshot(deck);
      const refused = await cli("brand", "use", brand, deck);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('The deck\'s brand "harbor" is not as brand use left it');
      expect(refused.out).toContain("brand/brand.json  was changed after it was copied");
      expect(refused.out).toContain("--force");
      expect(snapshot(deck)).toEqual(before);
      const forced = await cli("brand", "use", brand, deck, "--force");
      expect(forced.code).toBe(0);
      expect(forced.out).toContain("replaced brand/brand.json although it was changed after it was copied");
      expect(json(join(deck, "brand", "brand.json")).styles.loud).toBeUndefined();
    });

    it("naming a font and a template added after the copy", async () => {
      const { deck, brand } = await branded();
      writeFileSync(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"), "not the font");
      const added = await apply(deck, [
        {
          op: "template.set",
          id: "extra",
          template: {
            name: "Extra",
            description: "A template added after the copy.",
            slots: [
              {
                id: "title",
                role: "title",
                frame: { x: 6, y: 15, w: 88, h: 20 },
                accepts: ["heading"],
                hint: "A heading.",
              },
            ],
          },
        },
      ]);
      expect(added.code).toBe(0);
      const refused = await cli("brand", "use", brand, deck);
      expect(refused.code).toBe(1);
      expect(refused.out).toContain("brand/fonts/HarborSans-Bold.woff2  was changed after it was copied");
      expect(refused.out).toContain("brand/templates/extra.json  was added after the brand was copied");
      expect(refused.out).not.toContain("HarborSans-Regular");
      const json_ = JSON.parse((await cli("brand", "use", brand, deck, "--json")).out);
      expect(json_.ok).toBe(false);
      expect(json_.code).toBe("changed-files");
      expect(json_.files.map((file: { path: string }) => file.path)).toEqual([
        "brand/fonts/HarborSans-Bold.woff2",
        "brand/templates/extra.json",
      ]);
    });

    it("naming every file of a brand that has no record, which may have been made by hand", async () => {
      const deck = copyDeck("v0-4-brand");
      // A brand that has the deck's templates, so it is the missing record that stops it.
      const next = make();
      cpSync(harborBrand, next, { recursive: true });
      write(join(next, "brand.json"), { ...json(join(next, "brand.json")), name: "Harbor Two" });
      const before = snapshot(deck);
      const refused = await cli("brand", "use", next, deck);
      expect(refused.code).toBe(1);
      expect(snapshot(deck)).toEqual(before);
      expect(refused.out).toContain(
        "brand/brand.json  has no record of being copied by brand use, so it may have been edited",
      );
      expect(refused.out).toContain("brand/templates/chart-and-note.json  has no record");
      expect(refused.out).toContain("brand/templates/cover.json  has no record");
    });

    it("also when a font of the new brand would overwrite one the deck already has, that brand use did not copy", async () => {
      const deck = copyDeck("demo");
      write(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"), "somebody's own file");
      const refused = await cli("brand", "use", harborBrand, deck);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("would be overwritten and are not as brand use copied them");
      expect(refused.out).toContain(
        "brand/fonts/HarborSans-Bold.woff2  is in the deck already, was not copied by brand use and differs from the brand's",
      );
      expect(readFileSync(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"), "utf8")).toBe(
        "somebody's own file",
      );
      expect(existsSync(join(deck, "brand", "brand.json"))).toBe(false);
    });
  });

  describe("refuses, with no way past it, a scene that uses a template the new brand lacks", () => {
    it("naming each scene and the operations that move it, which then let the brand in", async () => {
      const deck = copyDeck("v0-4-brand");
      const acme = await initBrand();
      const before = snapshot(deck);
      for (const args of [[], ["--force"]]) {
        const refused = await cli("brand", "use", acme, deck, ...args);
        expect(refused.code).toBe(1);
        expect(refused.err).toContain('2 scenes use a template the brand "acme-widgets" does not have');
        expect(refused.out).toContain('scene "welcome" uses the template "cover"');
        expect(refused.out).toContain('scene "growth" uses the template "chart-and-note"');
        expect(refused.out).toContain("depthcue apply");
        expect(snapshot(deck)).toEqual(before);
      }
      const found = JSON.parse((await cli("brand", "use", acme, deck, "--json", "--force")).out);
      expect(found).toMatchObject({
        ok: false,
        code: "missing-templates",
        rev: (await cli("rev", deck)).out,
      });
      expect(found.scenes.map((scene: { scene: string }) => scene.scene)).toEqual(["welcome", "growth"]);
      // The operations it names are ones apply takes, and after them the brand can go in (the deck's own brand is
      // Harbor's, with no record, so --force replaces it).
      const ops = found.scenes.flatMap((scene: { move: { ops: unknown[] } }) => scene.move.ops);
      expect((await apply(deck, ops)).code).toBe(0);
      // A style only Harbor has is a different thing: the deck would be invalid, and apply names the block.
      const styled = await cli("brand", "use", acme, deck, "--force");
      expect(styled.code).toBe(1);
      expect(styled.err).toContain("The brand does not fit this deck");
      expect(styled.out).toContain(
        'scenes/context.json/blocks/2/style  error  There is no style "quiet-panel"',
      );
      expect(
        (await apply(deck, [{ op: "block.set", scene: "context", id: "context-body", set: { style: null } }]))
          .code,
      ).toBe(0);
      const used = await cli("brand", "use", acme, deck, "--force");
      expect(used.code).toBe(0);
      expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");
    });

    it("also refuses an unbranded deck's scene on a template of a brand that is not the new one", async () => {
      const deck = copyDeck("v0-4-brand");
      // The deck is Harbor's: a brand with Harbor's own `cover` takes it, one without does not.
      const refused = await cli("brand", "use", tidewellBrand, deck, "--force");
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('scene "welcome" uses the template "cover"');
      expect(refused.out).not.toContain('scene "context"');
    });

    it("lists the blocks a move leaves without a slot, to decide before applying", async () => {
      const deck = copyDeck("v0-4-brand");
      const acme = await initBrand();
      const found = JSON.parse((await cli("brand", "use", acme, deck, "--json")).out);
      for (const scene of found.scenes) expect(Array.isArray(scene.move.unplaced)).toBe(true);
    });
  });

  it("refuses a brand that fails brand check, naming what is wrong, and copies nothing", async () => {
    const deck = copyDeck("demo");
    const brand = await initBrand();
    const file = json(join(brand, "brand.json"));
    file.fonts = {
      display: {
        family: "Own",
        license: "OFL-1.1",
        files: [{ file: "fonts/Gone.woff2", weight: 400, style: "normal" }],
      },
      body: { family: "Own Body" },
      fallback: "modern",
    };
    write(join(brand, "brand.json"), file);
    const before = snapshot(deck);
    const refused = await cli("brand", "use", brand, deck);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("fails brand check, so nothing was copied");
    expect(refused.out).toContain("brand/fonts/Gone.woff2 does not exist");
    expect(snapshot(deck)).toEqual(before);
  });

  it("refuses a brand that does not fit the deck, as apply would, and puts nothing in the folder", async () => {
    const deck = copyDeck("v0-3");
    const brand = await initBrand();
    const file = json(join(brand, "brand.json"));
    file.lock = true;
    write(join(brand, "brand.json"), file);
    const before = snapshot(deck);
    // The deck sets its own palette and fonts, which a locked brand refuses.
    const refused = await cli("brand", "use", brand, deck);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("The brand does not fit this deck");
    expect(refused.out).toContain(
      'The brand "acme-widgets" is locked, so the deck cannot set its own colors.',
    );
    expect(snapshot(deck)).toEqual(before);
  });

  it("puts back the fonts it copied when the save is refused, and leaves no folder behind", async () => {
    const deck = copyDeck("demo");
    // brand.json from an earlier brand lies in a deck that names none: making a brand there would take it in unread.
    write(join(deck, "brand", "brand.json"), starterBrand("Leftover"));
    const before = snapshot(deck);
    const refused = await cli("brand", "use", harborBrand, deck);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("Nothing was copied");
    expect(snapshot(deck)).toEqual(before);
    expect(existsSync(join(deck, "brand", "fonts"))).toBe(false);
    expect(existsSync(join(deck, "brand", "logos"))).toBe(false);
  });

  it("refuses to write through a brand folder that is a link, and leaves the other folder alone", async () => {
    const deck = copyDeck("demo");
    const elsewhere = make();
    symlinkSync(elsewhere, join(deck, "brand"), "junction");
    const refused = await cli("brand", "use", harborBrand, deck);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("brand in the deck is a link");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("exits 2 for a folder that is not a brand, a deck that does not exist and a deck with errors", async () => {
    const deck = copyDeck("demo");
    const empty = make();
    expect((await cli("brand", "use", empty, deck)).err).toContain("has no brand.json");
    expect((await cli("brand", "use", harborBrand, join(empty, "nope"))).err).toContain("is not a folder");
    write(join(deck, "scenes", "opening.json"), "{ broken");
    const broken = await cli("brand", "use", harborBrand, deck);
    expect(broken.code).toBe(2);
    expect(broken.err).toContain("has errors that must be fixed first");
  });

  it("never copies the brand into the folder it came from", async () => {
    const dir = await initBrand();
    // A brand folder is not a deck; it has no deck.json, so it is not a folder `use` can write into.
    const refused = await cli("brand", "use", dir, dir);
    expect(refused.code).toBe(2);
  });
});

describe("the review of a brand's files", () => {
  it("names the template change that a refused accept of a scene is waiting for", async () => {
    const deck = copyDeck("v0-4-brand");
    expect((await cli("diff", deck, "accept", "--all")).code).toBe(0);
    const {
      schemaVersion: _version,
      id: _id,
      ...cover
    } = json(join(deck, "brand", "templates", "cover.json"));
    const edited = await apply(deck, [
      { op: "template.set", id: "note", template: { ...cover, name: "Note" } },
      { op: "scene.set", id: "welcome", set: { template: "note" } },
    ]);
    expect(edited.code).toBe(0);
    const listed = JSON.parse((await cli("diff", deck, "--json")).out);
    expect(listed.changes.map((change: { id: string }) => change.id)).toEqual([
      "deck/template:note",
      "scene:welcome/template",
    ]);
    const refused = await cli("diff", deck, "accept", "scene:welcome/template", "--json");
    expect(refused.code).toBe(1);
    const found = JSON.parse(refused.out);
    expect(found).toMatchObject({ ok: false, code: "invalid-deck" });
    expect(found.hint).toContain('It may be waiting for "deck/template:note": name them in the same call.');
    const both = await cli("diff", deck, "accept", "deck/template:note", "scene:welcome/template");
    expect(both.code).toBe(0);
    expect(JSON.parse((await cli("diff", deck, "--json")).out).changes).toEqual([]);
    // Everything at once has nothing left to name.
    expect((await cli("diff", deck, "revert", "--all")).code).toBe(0);
  });
});

describe("the record brand use keeps", () => {
  it("is read only when it is whole, and names only the files a brand folder holds", () => {
    const deck = make();
    const hash = "a".repeat(64);
    const put = (value: unknown) => write(join(deck, ...USE_RECORD.split("/")), value);
    put({
      format: "depthcue-brand-use/1",
      brand: "acme",
      files: { "brand.json": hash, "fonts/A.woff2": [hash, hash] },
    });
    expect(readUseRecord(deck)?.files.size).toBe(2);
    for (const files of [
      { "../deck.json": hash },
      { "scenes/opening.json": hash },
      { "templates/Bad Name.json": hash },
      { "brand.json": "short" },
      { "brand.json": [hash, hash, hash] },
      { "brand.json": [] },
    ]) {
      put({ format: "depthcue-brand-use/1", brand: "acme", files });
      expect(readUseRecord(deck), JSON.stringify(files)).toBeUndefined();
    }
    put({ format: "other/1", brand: "acme", files: {} });
    expect(readUseRecord(deck)).toBeUndefined();
    write(join(deck, ...USE_RECORD.split("/")), "{ not json");
    expect(readUseRecord(deck)).toBeUndefined();
  });
});

describe("depthcue new", () => {
  it("makes a deck on Depthcue's title template that checks clean", async () => {
    const dir = join(make(), "autumn-review");
    const { code, out } = await cli("new", dir);
    expect(code).toBe(0);
    expect(out).toContain('Made the deck "Autumn Review"');
    expect(Object.keys(snapshot(dir)).sort()).toEqual(["deck.json", "scenes/opening.json"]);
    expect(json(join(dir, "deck.json"))).toEqual({
      schemaVersion: "0.4",
      id: "autumn-review",
      title: "Autumn Review",
      language: "en",
      theme: "paper",
      scenes: ["opening"],
    });
    expect(json(join(dir, "scenes", "opening.json"))).toEqual({
      schemaVersion: "0.4",
      id: "opening",
      title: "Autumn Review",
      template: "title",
      blocks: [{ id: "opening-title", type: "text", role: "heading", text: "Autumn Review", slot: "title" }],
    });
    expect((await cli("check", dir)).out).toBe("0 errors, 0 warnings");
  });

  it("names the deck with --name, and answers --json", async () => {
    const dir = join(make(), "q4");
    const made = JSON.parse((await cli("new", dir, "--name", "The fourth quarter", "--json")).out);
    expect(made).toEqual({ ok: true, dir, files: ["deck.json", "scenes/opening.json"], brand: null });
    expect(json(join(dir, "deck.json")).title).toBe("The fourth quarter");
  });

  it("copies a brand in with the code brand use runs, and puts the first scene on the brand's own title template", async () => {
    const dir = join(make(), "harbor-review");
    const { code, out } = await cli("new", dir, "--brand", tidewellBrand);
    expect(code).toBe(0);
    expect(out).toContain('in the brand "Tidewell Press" (tidewell)');
    expect(json(join(dir, "deck.json"))).toMatchObject({ brand: "tidewell", scenes: ["opening"] });
    expect(json(join(dir, "scenes", "opening.json"))).toMatchObject({ template: "title" });
    expect(json(join(dir, "scenes", "opening.json")).layout).toBeUndefined();
    const files = snapshot(dir);
    const given = snapshot(tidewellBrand);
    expect(Object.keys(given).length).toBeGreaterThan(5);
    for (const [path, text] of Object.entries(given)) {
      // JSON is copied in the form a deck writes it, everything else byte for byte.
      if (path.endsWith(".json"))
        expect(JSON.parse(files[`brand/${path}`] ?? "null"), path).toEqual(JSON.parse(text));
      else expect(files[`brand/${path}`], path).toBe(text);
    }
    expect(files["brand/fonts/TidewellText-Bold.woff2"]).toBeDefined();
    expect(readUseRecord(dir)?.brand).toBe("tidewell");
    // No review is started for a deck that has only just been made.
    expect(files["review.json"]).toBeUndefined();
    expect((await cli("check", dir)).out).toBe("0 errors, 0 warnings");
    expect((await cli("brand", "check", dir)).code).toBe(0);
  });

  it("fills what the brand's title template requires, so the deck passes its checks", async () => {
    const brand = await initBrand();
    write(join(brand, "templates", "title.json"), {
      schemaVersion: "0.4",
      id: "title",
      name: "Title",
      description: "A title with a byline that must be filled.",
      slots: [
        {
          id: "name",
          role: "title",
          frame: { x: 8, y: 30, w: 84, h: 30 },
          accepts: ["heading"],
          required: true,
          hint: "The title.",
        },
        {
          id: "byline",
          role: "body",
          frame: { x: 8, y: 66, w: 70, h: 10 },
          accepts: ["caption"],
          required: true,
          hint: "Who presents, and when.",
        },
      ],
    });
    const dir = join(make(), "deck");
    expect((await cli("new", dir, "--brand", brand)).code).toBe(0);
    const scene = json(join(dir, "scenes", "opening.json"));
    expect(scene.blocks.map((block: { slot: string }) => block.slot)).toEqual(["name", "byline"]);
    expect(scene.blocks[1].text).toBe("Who presents, and when.");
    expect((await cli("check", dir)).out).toBe("0 errors, 0 warnings");
  });

  it("refuses a title template needing something a new deck cannot start with, and leaves no deck", async () => {
    const brand = await initBrand();
    write(join(brand, "templates", "title.json"), {
      schemaVersion: "0.4",
      id: "title",
      name: "Title",
      description: "A title over a picture that must be there.",
      slots: [
        {
          id: "name",
          role: "title",
          frame: { x: 8, y: 20, w: 84, h: 20 },
          accepts: ["heading"],
          required: true,
          hint: "The title.",
        },
        {
          id: "picture",
          role: "picture",
          frame: { x: 8, y: 45, w: 84, h: 40 },
          accepts: ["image"],
          required: true,
          hint: "A picture.",
        },
      ],
    });
    const dir = join(make(), "deck");
    const refused = await cli("new", dir, "--brand", brand);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('needs something in "picture" that a new deck cannot start with');
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses a brand that hides Depthcue's own templates and has no title of its own, and leaves no deck", async () => {
    const brand = await initBrand();
    write(join(brand, "brand.json"), { ...json(join(brand, "brand.json")), hideBuiltIn: ["templates"] });
    const dir = join(make(), "deck");
    const refused = await cli("new", dir, "--brand", brand);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("has no title template");
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses a brand that fails brand check, one that is not a folder, and a folder with files in it", async () => {
    const broken = await initBrand();
    write(join(broken, "brand.json"), {
      ...json(join(broken, "brand.json")),
      colors: { paper: { bg: "red" } },
    });
    const dir = join(make(), "deck");
    const refused = await cli("new", dir, "--brand", broken);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("fails brand check, so no deck was made");
    expect(existsSync(dir)).toBe(false);
    expect((await cli("new", dir, "--brand", join(make(), "nope"))).code).toBe(2);
    const full = make();
    write(join(full, "keep.txt"), "mine");
    const taken = await cli("new", full);
    expect(taken.code).toBe(2);
    expect(taken.err).toContain("has files in it, so nothing was written");
    expect(snapshot(full)).toEqual({ "keep.txt": "mine" });
  });

  it("uses an empty folder that is there, and leaves it empty if the brand is refused", async () => {
    const empty = make();
    const refused = await cli("new", empty, "--brand", join(make(), "nope"));
    expect(refused.code).toBe(2);
    expect(readdirSync(empty)).toEqual([]);
    expect((await cli("new", empty)).code).toBe(0);
    expect(existsSync(join(empty, "deck.json"))).toBe(true);
  });
});

describe("the options the brand commands take", () => {
  it.each([
    [["brand"], "brand needs a subcommand: brand init, brand use, brand check or brand import."],
    [["brand", "init"], "brand init needs a folder to make the brand in."],
    [["brand", "init", "a", "b"], "Unexpected argument b."],
    [["brand", "init", "a", "--force"], "brand init takes --name and --json, not --force."],
    [["brand", "init", "a", "--out", "b"], "brand init takes --name and --json, not --out."],
    [["brand", "use", "a"], "brand use needs a brand folder and a deck folder."],
    [["brand", "use", "a", "b", "c"], "Unexpected argument c."],
    [["brand", "use", "a", "b", "--name", "x"], "brand use takes --force and --json, not --name."],
    [["brand", "use", "a", "b", "--brand", "x"], "--brand belongs to new."],
    [["brand", "check"], "brand check needs a brand folder or a deck folder."],
    [["brand", "check", "a", "--force"], "brand check takes --json, not --force."],
    [["brand", "check", "a", "--port", "3"], "brand check takes --json."],
    [["new"], "new needs a folder to make the deck in."],
    [["new", "a", "b"], "Unexpected argument b."],
    [["new", "a", "--force"], "--force belongs to brand use."],
    [["new", "a", "--out", "b"], "new takes --brand and --name and --json, not --out."],
    [["check", "a", "--force"], "--force belongs to brand use."],
    [["check", "a", "--brand", "b"], "--brand belongs to new."],
    [["render", "a", "--name", "b"], "--name, --quality, --scale and --kine belong to clip build."],
  ])("refuses %j with exit 2: %s", async (args, message) => {
    const { code, err, out } = await cli(...args);
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(out).toBe("");
  });

  it("lists the commands in the usage text", async () => {
    const { err } = await cli("nonsense");
    for (const text of [
      "depthcue brand init <dir> [--name <name>] [--json]",
      "depthcue brand use <brand-folder> <deck-folder> [--force] [--json]",
      "depthcue brand check <brand-folder | deck-folder> [--json]",
      "depthcue new <dir> [--brand <brand-folder>] [--name <title>] [--json]",
      "brand  init writes a starter brand",
      "A scene\n       that uses a template the new brand lacks is always refused",
    ]) {
      expect(err).toContain(text);
    }
  });
});
