// What `brand use` must not do to a deck folder: delete through a link, lose a file to a change of letter case, leave a
// half-copied brand behind, take away what a review needs, or let a brand through that a computer cannot hold. Real
// folders in a temporary directory, through the command line unless a test says otherwise.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkBrandSource } from "../src/brand/check.ts";
import { readUseRecord } from "../src/brand/record.ts";
import { BrandFolderError, carriable, MAX_BYTES, MAX_FILES, readBrandFolder } from "../src/brand/source.ts";
import { useBrand } from "../src/brand/use.ts";
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

const copyDeck = (name: string): string => {
  const dir = make();
  cpSync(join(decks, name), dir, { recursive: true });
  return dir;
};
const copyBrand = (from = harborBrand): string => {
  const dir = make();
  cpSync(from, dir, { recursive: true });
  return dir;
};
const write = (path: string, value: string | Uint8Array) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};
// biome-ignore lint/suspicious/noExplicitAny: a test helper that reads the JSON file a test names
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

/** Harbor without its fonts folder, for a brand whose system fonts need no files. */
function harborWithoutFonts(): string {
  const dir = copyBrand();
  rmSync(join(dir, "fonts"), { recursive: true });
  const brand = json(join(dir, "brand.json"));
  brand.fonts = undefined;
  write(join(dir, "brand.json"), `${JSON.stringify(brand, null, 2)}\n`);
  return dir;
}

describe("a deck whose fonts folder is a link to a folder elsewhere", () => {
  for (const force of [false, true]) {
    it(`is not emptied by a brand without fonts${force ? ", with --force" : ""}`, async () => {
      const deck = copyDeck("demo");
      expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
      // Another deck's fonts and this one's are the same folder, as a person sharing fonts would set it up.
      const shared = make();
      cpSync(join(deck, "brand", "fonts"), shared, { recursive: true });
      write(join(shared, "someone-elses.woff2"), "another deck's font");
      rmSync(join(deck, "brand", "fonts"), { recursive: true });
      symlinkSync(shared, join(deck, "brand", "fonts"), "junction");
      const before = snapshot(shared);
      expect(Object.keys(before)).toHaveLength(4);

      const used = await cli("brand", "use", harborWithoutFonts(), deck, ...(force ? ["--force"] : []));
      expect(used.code, used.out + used.err).toBe(0);
      expect(snapshot(shared)).toEqual(before);
      expect(used.out).toContain("kept brand/fonts/HarborSans-Bold.woff2 (is behind the link brand/fonts");
      expect(used.out).not.toContain("removed brand/fonts");
      expect((await cli("check", deck)).code).toBe(0);
    });
  }
});

describe("a font renamed by letter case alone", () => {
  function renamedByCase(): string {
    const dir = copyBrand();
    renameSync(join(dir, "fonts", "HarborSans-Bold.woff2"), join(dir, "fonts", "tmp.woff2"));
    const bytes = readFileSync(join(dir, "fonts", "tmp.woff2"));
    write(join(dir, "fonts", "harborsans-bold.woff2"), Buffer.concat([bytes, Buffer.from("more")]));
    rmSync(join(dir, "fonts", "tmp.woff2"));
    const text = readFileSync(join(dir, "brand.json"), "utf8");
    write(join(dir, "brand.json"), text.replaceAll("HarborSans-Bold.woff2", "harborsans-bold.woff2"));
    return dir;
  }

  it("is in the deck under the new name with the new bytes, the deck still checks, and a second use does nothing", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    const next = renamedByCase();
    expect((await cli("brand", "check", next)).code).toBe(0);

    const used = await cli("brand", "use", next, deck);
    expect(used.code, used.out + used.err).toBe(0);
    const fonts = readdirSync(join(deck, "brand", "fonts"));
    expect(fonts).toContain("harborsans-bold.woff2");
    expect(
      readFileSync(join(deck, "brand", "fonts", "harborsans-bold.woff2")).equals(
        readFileSync(join(next, "fonts", "harborsans-bold.woff2")),
      ),
    ).toBe(true);
    expect((await cli("check", deck)).code).toBe(0);
    expect(json(join(deck, "brand", "brand.json")).fonts.display.files[0].file).toBe(
      "fonts/harborsans-bold.woff2",
    );

    const again = await cli("brand", "use", next, deck);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Nothing to do:");
  });

  it("never removes the only copy as the old brand's file that the new one lacks", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    const used = await cli("brand", "use", renamedByCase(), deck, "--json");
    expect(used.code, used.out + used.err).toBe(0);
    expect(JSON.parse(used.out).removed).not.toContain("brand/fonts/HarborSans-Bold.woff2");
    // Whichever computer this is, some file of the deck answers to the name brand.json gives.
    expect(existsSync(join(deck, "brand", "fonts", "harborsans-bold.woff2"))).toBe(true);
  });

  it("is refused when the brand folder holds both names, which are one file on some computers", () => {
    const source = readBrandFolder(harborBrand);
    const binaries = new Map(source.binaries);
    binaries.set("fonts/harborsans-bold.woff2", new Uint8Array([1, 2, 3]));
    const found = checkBrandSource({ brand: source.brand, templates: source.templates, binaries });
    expect(found.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "brand-file-case",
        file: "fonts/harborsans-bold.woff2",
      }),
    );
    const deck = copyDeck("demo");
    const before = snapshot(deck);
    expect(useBrand(deck, { ...source, binaries }, { force: false })).toMatchObject({
      ok: false,
      code: "brand-invalid",
    });
    expect(snapshot(deck)).toEqual(before);
  });

  it("is refused when the deck holds a file under the other case that brand use did not copy", async () => {
    const deck = copyDeck("demo");
    write(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"), "the deck's own, and not the brand's");
    // brand.json is not there yet, so the deck has a brand folder only by this one stray file.
    const used = await cli("brand", "use", renamedByCase(), deck);
    // On a computer that ignores case this file is the one the brand would overwrite; where case counts it is another
    // file, and the copy goes ahead beside it.
    const ignoresCase = existsSync(join(deck, "brand", "fonts", "harborsans-bold.woff2"));
    if (used.code === 0) expect(ignoresCase).toBe(false);
    else expect(used.err + used.out).toContain("differs only in letter case");
  });
});

describe("a brand use that fails partway", () => {
  it("keeps the files of the deck it found when the deck changes while the brand is being prepared", async () => {
    const deck = copyDeck("demo");
    const before = snapshot(deck);
    const sceneId = (JSON.parse(before["deck.json"] as string) as { scenes: string[] }).scenes[0] as string;
    const scene = join(deck, "scenes", `${sceneId}.json`);
    const result = useBrand(deck, readBrandFolder(tidewellBrand), {
      force: false,
      after: () => {
        // A person saves the scene in the editor after the deck was read and before the brand is written.
        const edited = json(scene);
        edited.title = `${edited.title} (edited by a person)`;
        writeFileSync(scene, `${JSON.stringify(edited, null, 2)}\n`);
        return [];
      },
    });
    expect(result).toMatchObject({ ok: false, code: "changed-on-disk" });
    const after = snapshot(deck);
    // Only the person's edit differs: the fonts, the logos and the record that were copied before the save are gone.
    const differing = Object.keys({ ...before, ...after }).filter((path) => before[path] !== after[path]);
    expect(differing).toEqual([`scenes/${sceneId}.json`]);
    expect(existsSync(join(deck, "brand"))).toBe(false);
  });
});

describe("a brand folder the reviewer still needs", () => {
  it("is kept while the review holds the earlier brand, so a revert brings it back whole", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    expect((await cli("diff", deck, "accept", "--all")).code).toBe(0);
    const used = await cli("brand", "use", tidewellBrand, deck, "--force");
    expect(used.code).toBe(0);
    for (const file of [
      "fonts/HarborSans-Bold.woff2",
      "fonts/HarborSans-Regular.woff2",
      "logos/harbor.svg",
    ]) {
      expect(used.out).toContain(
        `kept brand/${file} (is named by the brand under review, which a revert brings back)`,
      );
      expect(existsSync(join(deck, "brand", file)), file).toBe(true);
    }

    const reverted = await cli("diff", deck, "revert", "--all");
    expect(reverted.code, reverted.out + reverted.err).toBe(0);
    expect(json(join(deck, "deck.json")).brand).toBe("harbor");
    expect(json(join(deck, "brand", "brand.json")).id).toBe("harbor");
    expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");

    // The known limit: the record still describes the brand the revert took away, so the next use asks for --force.
    const next = await cli("brand", "use", tidewellBrand, deck);
    expect(next.code, next.out + next.err).toBe(1);
    expect((await cli("brand", "use", tidewellBrand, deck, "--force")).code).toBe(0);
    expect((await cli("check", deck)).code).toBe(0);
  });

  it("goes with the next brand use after the review has taken the later brand", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    expect((await cli("diff", deck, "accept", "--all")).code).toBe(0);
    expect((await cli("brand", "use", tidewellBrand, deck, "--force")).code).toBe(0);
    expect(existsSync(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"))).toBe(true);
    // The record still lists the files that were kept, so the next use knows they are its to remove.
    expect(readUseRecord(deck)?.files.has("fonts/HarborSans-Bold.woff2")).toBe(true);

    expect((await cli("diff", deck, "accept", "--all")).code).toBe(0);
    const third = join(make(), "acme");
    expect((await cli("brand", "init", third)).code).toBe(0);
    const next = await cli("brand", "use", third, deck, "--json");
    expect(next.code, next.out).toBe(0);
    const removed = JSON.parse(next.out).removed as string[];
    expect(removed).toEqual(
      expect.arrayContaining([
        "brand/fonts/HarborSans-Bold.woff2",
        "brand/fonts/HarborSans-Regular.woff2",
        "brand/logos/harbor.svg",
      ]),
    );
    expect(existsSync(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"))).toBe(false);
  });
});

describe("depthcue brand check on a deck folder", () => {
  it("exits 2, and reports the load errors, for a deck.json that is not JSON", async () => {
    const deck = copyDeck("tidewell-press");
    writeFileSync(join(deck, "deck.json"), "{ not json");
    const checked = await cli("brand", "check", deck);
    expect(checked.code).toBe(2);
    expect(checked.out).toContain("deck.json");
    expect(checked.out).toContain("error");
    expect(checked.err).toContain("could not be read as a deck");
    const asJson = JSON.parse((await cli("brand", "check", deck, "--json")).out);
    expect(asJson).toMatchObject({ ok: false, kind: "deck", code: "deck-unreadable" });
    expect(asJson.errors).toBeGreaterThan(0);
  });

  it("exits 2 for a brand.json inside the deck that cannot be read, where a brand folder's would be 1", async () => {
    const deck = copyDeck("tidewell-press");
    writeFileSync(join(deck, "brand", "brand.json"), '{ "id": "tidewell-press"');
    expect((await cli("brand", "check", deck)).code).toBe(2);
  });

  it("always prints JSON with --json, for a folder that is not there too", async () => {
    const missing = join(make(), "nowhere");
    const answer = await cli("brand", "check", missing, "--json");
    expect(answer.code).toBe(2);
    expect(answer.err).toBe("");
    expect(JSON.parse(answer.out)).toMatchObject({ ok: false, message: `${missing} is not a folder.` });
    const plain = await cli("brand", "check", missing);
    expect(plain.code).toBe(2);
    expect(plain.err).toContain("is not a folder");
    expect(plain.out).toBe("");
  });
});

describe("the names and the size a brand folder may carry", () => {
  it.each([
    "con",
    "CON",
    "prn",
    "aux.svg",
    "NUL.png",
    "nul",
    "com1.woff2",
    "COM9",
    "lpt1",
    "Lpt3.svg",
    "logo.",
    "logo..",
  ])("does not carry %s", (name) => {
    expect(carriable(name)).toBe(false);
  });

  it.each(["logo.svg", "console.svg", "auxiliary.png", "com10.png", "com.svg", "a-b_c.1.woff2", "Harbor9"])(
    "carries %s",
    (name) => {
      expect(carriable(name)).toBe(true);
    },
  );

  // These names cannot be made on Windows at all, which is the reason to refuse them.
  it.skipIf(process.platform === "win32")("refuses a folder that has one", () => {
    for (const name of ["con", "nul.svg", "lpt1.png", "aux", "trailing."]) {
      const dir = copyBrand();
      write(join(dir, "images", name), "x");
      expect(() => readBrandFolder(dir), name).toThrow(/has a name a brand cannot carry/);
    }
  });

  it("takes 200 files, and refuses a 201st", () => {
    const dir = copyBrand();
    const room = MAX_FILES - readBrandFolder(dir).binaries.size;
    for (let i = 0; i < room; i++) write(join(dir, "images", `f${i}.png`), "x");
    expect(readBrandFolder(dir).binaries.size).toBe(MAX_FILES);
    write(join(dir, "images", "one-too-many.png"), "x");
    expect(() => readBrandFolder(dir)).toThrow(BrandFolderError);
    expect(() => readBrandFolder(dir)).toThrow(/more than 200 files or 64 MB/);
  });

  it("refuses more than 64 MB of files, without reading the file that goes over", () => {
    const dir = copyBrand();
    write(join(dir, "images", "big.png"), Buffer.alloc(MAX_BYTES + 1));
    expect(() => readBrandFolder(dir)).toThrow(/more than 200 files or 64 MB/);
  });
});

describe("what the commands print", () => {
  it("says a template file the save took away was removed, not written", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    const replaced = await cli("brand", "use", copyBrand(tidewellBrand), deck);
    expect(replaced.code, replaced.out + replaced.err).toBe(0);
    expect(replaced.out).toContain("removed brand/templates/cover.json");
    expect(replaced.out).not.toContain("wrote brand/templates/cover.json");
    expect(replaced.out).toContain("wrote brand/brand.json");
  });

  it("says --force removed a template, where it did", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    // A template of the deck's brand changed by hand: replacing it needs --force, and the new brand has no such file.
    const cover = join(deck, "brand", "templates", "cover.json");
    const edited = json(cover);
    edited.description = "Edited by hand.";
    writeFileSync(cover, `${JSON.stringify(edited, null, 2)}\n`);
    const forced = await cli("brand", "use", copyBrand(tidewellBrand), deck, "--force");
    expect(forced.code, forced.out + forced.err).toBe(0);
    expect(forced.out).toContain(
      "removed brand/templates/cover.json although it was changed after it was copied (--force)",
    );
    expect(forced.out).not.toContain("replaced brand/templates/cover.json");
  });
});

describe("the files brand use leaves are tidy", () => {
  it("leaves no temporary file anywhere in a deck after a use, a replacement and a refusal", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    expect((await cli("brand", "use", tidewellBrand, deck, "--force")).code).toBe(0);
    // A refusal, because a template of the deck was changed by hand.
    const quote = join(deck, "brand", "templates", "quote.json");
    const edited = json(quote);
    edited.description = "Edited by hand.";
    writeFileSync(quote, `${JSON.stringify(edited, null, 2)}\n`);
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(1);
    expect(Object.keys(snapshot(deck)).filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });
});
