import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { IMPORT_FORMAT, IMPORT_MARKER, WriteError, writeBrand } from "../src/brand-import/write.ts";
import { temporaryFolders } from "./brand-import-fixtures.ts";

const make = temporaryFolders();

const SOURCE = "Z:\\elsewhere\\Harbor.potx";

/** Every file under a folder, by path from it with forward slashes. */
function listing(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

const files = (...paths: string[]) =>
  new Map<string, string | Uint8Array>(paths.map((path) => [path, `content of ${path}`]));
const marker = (out: string) => JSON.parse(readFileSync(join(out, IMPORT_MARKER), "utf8"));

const failure = (run: () => void): WriteError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WriteError);
    return error as WriteError;
  }
  throw new Error("It did not throw.");
};

describe("writeBrand", () => {
  it("writes the files and a marker listing them, into a folder that is not there yet", () => {
    const out = join(make(), "brand");
    writeBrand(out, SOURCE, files("brand.json", "templates/a.json", "logos/logo.png"));
    expect(listing(out)).toEqual([IMPORT_MARKER, "brand.json", "logos/logo.png", "templates/a.json"]);
    expect(marker(out)).toEqual({
      format: IMPORT_FORMAT,
      files: ["brand.json", "logos/logo.png", "templates/a.json"],
    });
    expect(readFileSync(join(out, "templates", "a.json"), "utf8")).toBe("content of templates/a.json");
  });

  it("writes bytes as they are and text as text", () => {
    const out = join(make(), "brand");
    writeBrand(
      out,
      SOURCE,
      new Map<string, string | Uint8Array>([
        ["a.bin", Uint8Array.from([0, 255, 10, 13])],
        ["b.txt", "é\n"],
      ]),
    );
    expect(new Uint8Array(readFileSync(join(out, "a.bin")))).toEqual(Uint8Array.from([0, 255, 10, 13]));
    expect(readFileSync(join(out, "b.txt"), "utf8")).toBe("é\n");
  });

  it("writes into a folder that exists and is empty", () => {
    const out = make();
    writeBrand(out, SOURCE, files("brand.json"));
    expect(listing(out)).toEqual([IMPORT_MARKER, "brand.json"]);
  });

  it("replaces what an earlier import wrote: new content over old, and the files it no longer has removed", () => {
    const out = join(make(), "brand");
    writeBrand(
      out,
      SOURCE,
      files("brand.json", "templates/a.json", "templates/b.json", "logos/logo.png", "images/bg.jpg"),
    );
    writeBrand(
      out,
      SOURCE,
      new Map([
        ["brand.json", "second"],
        ["templates/a.json", "second a"],
        ["templates/c.json", "c"],
      ]),
    );
    expect(listing(out)).toEqual([IMPORT_MARKER, "brand.json", "templates/a.json", "templates/c.json"]);
    expect(readFileSync(join(out, "brand.json"), "utf8")).toBe("second");
    expect(marker(out).files).toEqual(["brand.json", "templates/a.json", "templates/c.json"]);
    // The folders the removed files were in went with them.
    expect(existsSync(join(out, "logos"))).toBe(false);
    expect(existsSync(join(out, "images"))).toBe(false);
  });

  it("leaves a person's own files beside the brand alone when it replaces one", () => {
    const out = join(make(), "brand");
    writeBrand(out, SOURCE, files("brand.json", "templates/a.json", "logos/logo.png"));
    writeFileSync(join(out, "notes.txt"), "mine");
    writeFileSync(join(out, "logos", "extra.svg"), "mine too");
    writeBrand(out, SOURCE, files("brand.json"));
    expect(listing(out)).toEqual([IMPORT_MARKER, "brand.json", "logos/extra.svg", "notes.txt"]);
  });

  it("refuses a folder with other files in it, and writes nothing", () => {
    const out = make();
    writeFileSync(join(out, "mine.txt"), "mine");
    const before = listing(out);
    const error = failure(() => writeBrand(out, SOURCE, files("brand.json")));
    expect(error.code).toBe("out-not-ours");
    expect(error.message).toContain("was not made by depthcue brand import, so nothing was written");
    expect(listing(out)).toEqual(before);
  });

  it("refuses an earlier import's folder when a file it would write is somebody else's, and writes nothing", () => {
    const out = join(make(), "brand");
    writeBrand(out, SOURCE, files("brand.json"));
    mkdirSync(join(out, "templates"));
    writeFileSync(join(out, "templates", "mine.json"), "mine");
    const before = listing(out);
    const markerBefore = readFileSync(join(out, IMPORT_MARKER), "utf8");
    const error = failure(() => writeBrand(out, SOURCE, files("brand.json", "templates/mine.json")));
    expect(error.code).toBe("out-not-ours");
    expect(error.message).toContain("the earlier import did not write it, so nothing was written");
    expect(listing(out)).toEqual(before);
    expect(readFileSync(join(out, IMPORT_MARKER), "utf8")).toBe(markerBefore);
    expect(readFileSync(join(out, "templates", "mine.json"), "utf8")).toBe("mine");
  });

  it("refuses a file in the place of the folder", () => {
    const out = join(make(), "brand");
    writeFileSync(out, "a file");
    const error = failure(() => writeBrand(out, SOURCE, files("brand.json")));
    expect(error.code).toBe("out-is-file");
    expect(readFileSync(out, "utf8")).toBe("a file");
  });

  it("refuses a folder that holds the file being imported", () => {
    const out = make();
    const source = join(out, "sub", "Harbor.potx");
    expect(failure(() => writeBrand(out, source, files("brand.json"))).code).toBe("out-in-source");
    expect(failure(() => writeBrand(out, join(out, "Harbor.potx"), files("brand.json"))).code).toBe(
      "out-in-source",
    );
    expect(listing(out)).toEqual([]);
    // A sibling whose name starts the same is not inside.
    writeBrand(join(out, "a"), join(out, "ab", "Harbor.potx"), files("brand.json"));
    expect(listing(out)).toEqual(["a/.depthcue-brand-import", "a/brand.json"]);
  });

  describe("a marker it does not trust", () => {
    const withMarker = (text: string) => {
      const out = make();
      writeFileSync(join(out, IMPORT_MARKER), text);
      writeFileSync(join(out, "brand.json"), "kept");
      return out;
    };

    it.each([
      ["not JSON", "{ nope"],
      ["another format", JSON.stringify({ format: "other/1", files: ["brand.json"] })],
      ["no list of files", JSON.stringify({ format: IMPORT_FORMAT })],
      ["a path that climbs out", JSON.stringify({ format: IMPORT_FORMAT, files: ["../x"] })],
      ["a path with a backslash", JSON.stringify({ format: IMPORT_FORMAT, files: ["a\\b"] })],
      ["a path with a drive", JSON.stringify({ format: IMPORT_FORMAT, files: ["C:/x"] })],
      ["an empty path", JSON.stringify({ format: IMPORT_FORMAT, files: [""] })],
      ["a path that is not text", JSON.stringify({ format: IMPORT_FORMAT, files: [3] })],
      ["a dot segment", JSON.stringify({ format: IMPORT_FORMAT, files: ["a/./b"] })],
    ])("is not followed when it is %s: the folder counts as somebody else's", (_, text) => {
      const out = withMarker(text);
      expect(failure(() => writeBrand(out, SOURCE, files("brand.json"))).code).toBe("out-not-ours");
      expect(readFileSync(join(out, "brand.json"), "utf8")).toBe("kept");
    });
  });

  it("can be replaced by the next import when it stopped half-way", () => {
    const out = join(make(), "brand");
    // A file and a folder of the same name: the second write fails after the marker is down.
    const error = failure(() =>
      writeBrand(
        out,
        SOURCE,
        new Map([
          ["a", "x"],
          ["a/b", "y"],
        ]),
      ),
    );
    expect(error.code).toBe("write-failed");
    expect(existsSync(join(out, IMPORT_MARKER))).toBe(true);
    writeBrand(out, SOURCE, files("brand.json"));
    expect(listing(out)).toEqual([IMPORT_MARKER, "brand.json"]);
  });
});
