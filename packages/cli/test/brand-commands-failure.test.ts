// What `brand use` does when the disk fails it. A file system that fails on cue stands in for the full disk, the virus
// scanner and the locked file: before the save is done every file goes back as it was and the deck passes its check;
// after it, the deck is the new brand's and each step that did not finish is a warning, not a lost record.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  rename: undefined as undefined | ((from: string, to: string) => void),
  remove: undefined as undefined | ((path: string) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      hooks.rename?.(String(from), String(to));
      return actual.renameSync(from, to);
    },
    rmSync: (path: string, options?: import("node:fs").RmOptions) => {
      hooks.remove?.(String(path));
      return actual.rmSync(path, options);
    },
  };
});

import { readUseRecord } from "../src/brand/record.ts";
import { readBrandFolder } from "../src/brand/source.ts";
import { useBrand } from "../src/brand/use.ts";
import { run } from "../src/index.ts";
import { loadReviewDir } from "../src/review-file.ts";
import { temporaryFolders } from "./brand-import-fixtures.ts";

const make = temporaryFolders();
const decks = fileURLToPath(new URL("../../../fixtures/decks", import.meta.url));
const harborBrand = join(decks, "v0-4-brand", "brand");
const tidewellBrand = join(decks, "tidewell-press", "brand");

afterEach(() => {
  hooks.rename = undefined;
  hooks.remove = undefined;
});

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

/** Every file and folder under a folder by its path from the folder: a file with its bytes, a folder as "/". */
function snapshot(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const key = relative(dir, full).split(sep).join("/");
      if (statSync(full).isDirectory()) {
        found[key] = "/";
        walk(full);
      } else found[key] = readFileSync(full, "latin1");
    }
  };
  walk(dir);
  return found;
}

const copyDeck = (name: string): string => {
  const dir = make();
  cpSync(join(decks, name), dir, { recursive: true });
  return dir;
};
const ends = (path: string, tail: string) => path.replaceAll("\\", "/").endsWith(tail);
const denied = (what: string) =>
  Object.assign(new Error(`EPERM: operation not permitted, ${what}`), { code: "EPERM" });

describe("a disk that fails before the save is done", () => {
  it("puts back a deck that had no brand, folders and all, and the deck passes its check", async () => {
    const deck = copyDeck("demo");
    const before = snapshot(deck);
    // deck.json is the last file of the save: the brand's own files and the scenes are written by then.
    hooks.rename = (_from, to) => {
      if (ends(to, "/deck.json")) throw denied("rename");
    };
    const used = await cli("brand", "use", harborBrand, deck);
    expect(used.code, used.out + used.err).toBe(2);
    expect(used.err + used.out).toContain("Nothing was changed.");
    hooks.rename = undefined;
    expect(snapshot(deck)).toEqual(before);
    expect(existsSync(join(deck, "brand"))).toBe(false);
    expect((await cli("check", deck)).code).toBe(0);
  });

  it("puts back a deck that had another brand, record and all", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", tidewellBrand, deck)).code).toBe(0);
    const before = snapshot(deck);
    hooks.rename = (_from, to) => {
      if (ends(to, "/deck.json")) throw denied("rename");
    };
    const used = await cli("brand", "use", harborBrand, deck);
    expect(used.code, used.out + used.err).toBe(2);
    hooks.rename = undefined;
    expect(snapshot(deck)).toEqual(before);
    expect((await cli("check", deck)).code).toBe(0);
    // And the earlier brand is still the deck's, so the same use runs the same way once the disk is back.
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
  });

  it("puts back the fonts when a copy of one fails", async () => {
    const deck = copyDeck("demo");
    const before = snapshot(deck);
    let copies = 0;
    hooks.rename = (_from, to) => {
      if (ends(to, ".woff2") && ++copies === 2) throw denied("rename");
    };
    const used = await cli("brand", "use", harborBrand, deck);
    expect(used.code, used.out + used.err).toBe(2);
    expect(copies).toBeGreaterThanOrEqual(2);
    hooks.rename = undefined;
    expect(snapshot(deck)).toEqual(before);
  });

  it("leaves no temporary file behind when a rename fails", async () => {
    const deck = copyDeck("demo");
    hooks.rename = (_from, to) => {
      if (ends(to, "/deck.json")) throw denied("rename");
    };
    await cli("brand", "use", harborBrand, deck);
    hooks.rename = undefined;
    expect(Object.keys(snapshot(deck)).filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("names the files it could not put back, and exits 2", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", tidewellBrand, deck)).code).toBe(0);
    // The same brand with both its templates changed, so that the save writes two files.
    const next = make();
    cpSync(tidewellBrand, next, { recursive: true });
    for (const name of ["feature", "quote"]) {
      const file = join(next, "templates", `${name}.json`);
      writeFileSync(
        file,
        `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), description: "Changed." }, null, 2)}\n`,
      );
    }
    let templates = 0;
    hooks.rename = (_from, to) => {
      // The first template is written, the second fails, and the restore of the first fails too.
      if (ends(to, ".json") && to.replaceAll("\\", "/").includes("/templates/") && ++templates >= 2)
        throw denied("rename");
    };
    const used = useBrand(deck, readBrandFolder(next), { force: false });
    hooks.rename = undefined;
    expect(used.ok).toBe(false);
    if (used.ok) return;
    expect(used.code).toBe("write-failed");
    expect(used.message).toContain("could not be put back");
    expect(used.message).toMatch(/(feature|quote)\.json/);
  });
});

describe("a disk that fails after the save is done", () => {
  it("warns about a file it could not remove, keeps it in the record and still writes the review", async () => {
    const deck = copyDeck("demo");
    expect((await cli("brand", "use", harborBrand, deck)).code).toBe(0);
    hooks.remove = (path) => {
      if (ends(path, "/fonts/HarborSans-Bold.woff2")) throw denied("unlink");
    };
    const used = useBrand(deck, readBrandFolder(tidewellBrand), { force: false });
    hooks.remove = undefined;
    expect(used.ok, JSON.stringify(used)).toBe(true);
    if (!used.ok) return;
    const warnings = used.diagnostics.filter((found) => found.code === "brand-use-incomplete");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("brand/fonts/HarborSans-Bold.woff2 could not be removed");
    expect(used.removed).not.toContain("brand/fonts/HarborSans-Bold.woff2");
    expect(existsSync(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"))).toBe(true);
    // The record still lists it, so the next use takes it away without --force.
    expect(readUseRecord(deck)?.files.has("fonts/HarborSans-Bold.woff2")).toBe(true);
    const review = loadReviewDir(deck);
    expect(review.ok && review.review !== undefined).toBe(true);
    expect((await cli("check", deck)).code).toBe(0);

    const next = await cli("brand", "use", tidewellBrand, deck, "--json");
    expect(next.code, next.out + next.err).toBe(0);
    expect(JSON.parse(next.out).removed).toContain("brand/fonts/HarborSans-Bold.woff2");
    expect(existsSync(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"))).toBe(false);
  });

  it("warns when the final record cannot be written, and the next use still goes without --force", async () => {
    const deck = copyDeck("demo");
    let records = 0;
    hooks.rename = (_from, to) => {
      // The first write of the record is before the save, with each file as it was or will be. The second is the last.
      if (ends(to, "/.depthcue-brand-use") && ++records === 2) throw denied("rename");
    };
    const used = useBrand(deck, readBrandFolder(harborBrand), { force: false });
    hooks.rename = undefined;
    expect(used.ok, JSON.stringify(used)).toBe(true);
    if (!used.ok) return;
    expect(records).toBe(2);
    expect(used.diagnostics.map((found) => found.message).join("\n")).toContain(
      "record of the files brand use copied",
    );
    const review = loadReviewDir(deck);
    expect(review.ok && review.review !== undefined).toBe(true);
    expect((await cli("check", deck)).code).toBe(0);
    const again = await cli("brand", "use", harborBrand, deck);
    expect(again.code, again.out + again.err).toBe(0);
  });
});
