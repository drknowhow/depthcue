import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
/** The SHA-256 of a text, as a marker holds it. */
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

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
      files: {
        "brand.json": sha("content of brand.json"),
        "logos/logo.png": sha("content of logos/logo.png"),
        "templates/a.json": sha("content of templates/a.json"),
      },
    });
    expect(readFileSync(join(out, "templates", "a.json"), "utf8")).toBe("content of templates/a.json");
  });

  it("writes bytes as they are and text as text", () => {
    const out = join(make(), "brand");
    writeBrand(
      out,
      SOURCE,
      new Map<string, string | Uint8Array>([
        ["logos/logo.png", Uint8Array.from([0, 255, 10, 13])],
        ["brand.json", "é\n"],
      ]),
    );
    expect(new Uint8Array(readFileSync(join(out, "logos", "logo.png")))).toEqual(
      Uint8Array.from([0, 255, 10, 13]),
    );
    expect(readFileSync(join(out, "brand.json"), "utf8")).toBe("é\n");
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
    expect(Object.keys(marker(out).files)).toEqual(["brand.json", "templates/a.json", "templates/c.json"]);
    expect(marker(out).files["brand.json"]).toBe(sha("second"));
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
    const listing1 = (files: unknown) => JSON.stringify({ format: IMPORT_FORMAT, files });
    const KEPT = sha("kept");

    it.each([
      ["not JSON", "{ nope"],
      ["another format", JSON.stringify({ format: "other/1", files: { "brand.json": KEPT } })],
      ["no list of files", JSON.stringify({ format: IMPORT_FORMAT })],
      ["a list of names with no hashes, as no import writes", listing1(["brand.json"])],
      ["no files at all", listing1(null)],
      ["a path that climbs out", listing1({ "../x": KEPT })],
      ["a path with a backslash", listing1({ "a\\b": KEPT })],
      ["a path with a drive", listing1({ "C:/x": KEPT })],
      ["an empty path", listing1({ "": KEPT })],
      ["a dot segment", listing1({ "templates/./a.json": KEPT })],
      ["a hash that is not a SHA-256", listing1({ "brand.json": "kept" })],
      ["a hash that is not text", listing1({ "brand.json": 3 })],
      ["an empty list of hashes", listing1({ "brand.json": [] })],
      ["three hashes", listing1({ "brand.json": [KEPT, KEPT, KEPT] })],
      ["a name an import does not write", listing1({ "thesis.docx": KEPT })],
      ["a name in a folder an import does not write", listing1({ "photos/kid.jpg": KEPT })],
      ["a name that only looks like a template's", listing1({ "templates/a.json.bak": KEPT })],
      ["a template in a folder of a template", listing1({ "templates/x/a.json": KEPT })],
      ["a picture that is not one an import makes", listing1({ "images/a.gif": KEPT })],
    ])("is not followed when it is %s: the folder counts as somebody else's", (_, text) => {
      const out = withMarker(text);
      expect(failure(() => writeBrand(out, SOURCE, files("brand.json"))).code).toBe("out-not-ours");
      expect(readFileSync(join(out, "brand.json"), "utf8")).toBe("kept");
    });

    it("cannot be made to remove a person's files, whatever hash it gives them", () => {
      const out = make();
      mkdirSync(join(out, "photos"));
      writeFileSync(join(out, "thesis.docx"), "years of work");
      writeFileSync(join(out, "photos", "kid.jpg"), "a photo");
      writeFileSync(
        join(out, IMPORT_MARKER),
        listing1({
          "thesis.docx": sha("years of work"),
          "photos/kid.jpg": sha("a photo"),
          "brand.json": sha("anything"),
        }),
      );
      const before = listing(out);
      expect(failure(() => writeBrand(out, SOURCE, files("templates/a.json"))).code).toBe("out-not-ours");
      expect(listing(out)).toEqual(before);
      expect(readFileSync(join(out, "thesis.docx"), "utf8")).toBe("years of work");
      expect(readFileSync(join(out, "photos", "kid.jpg"), "utf8")).toBe("a photo");
    });

    it("cannot be made to remove a file of an allowed name that is not what the import wrote", () => {
      const out = make();
      writeFileSync(join(out, "brand.json"), "a person's brand");
      writeFileSync(join(out, IMPORT_MARKER), listing1({ "brand.json": sha("what an import wrote") }));
      const error = failure(() => writeBrand(out, SOURCE, files("templates/a.json")));
      expect(error.code).toBe("out-edited");
      expect(readFileSync(join(out, "brand.json"), "utf8")).toBe("a person's brand");
      expect(existsSync(join(out, "templates"))).toBe(false);
    });
  });

  describe("a file changed since the import wrote it", () => {
    const imported = (...paths: string[]) => {
      const out = join(make(), "brand");
      writeBrand(out, SOURCE, files(...paths));
      return out;
    };
    /** Everything in the folder, with its content, to compare before and after a refusal. */
    const snapshot = (out: string) =>
      listing(out).map((path) => [path, readFileSync(join(out, ...path.split("/")), "utf8")]);

    it("stops the next import, which writes nothing and removes nothing", () => {
      const out = imported("brand.json", "templates/a.json", "logos/logo.png");
      writeFileSync(join(out, "brand.json"), "content of brand.json, with a style added by apply");
      const before = snapshot(out);
      const error = failure(() => writeBrand(out, SOURCE, files("brand.json", "templates/b.json")));
      expect(error.code).toBe("out-edited");
      expect(error.message).toContain(join(out, "brand.json"));
      expect(error.message).toContain("nothing was written and nothing was removed");
      expect(snapshot(out)).toEqual(before);
    });

    it("stops the import too when the file is one the import would only have removed", () => {
      const out = imported("brand.json", "templates/a.json", "logos/logo.png");
      writeFileSync(join(out, "logos", "logo.png"), "my own logo");
      const before = snapshot(out);
      expect(failure(() => writeBrand(out, SOURCE, files("brand.json"))).code).toBe("out-edited");
      expect(snapshot(out)).toEqual(before);
    });

    it("stops the import when a file has been replaced by a folder", () => {
      const out = imported("brand.json", "templates/a.json");
      rmSync(join(out, "templates", "a.json"));
      mkdirSync(join(out, "templates", "a.json"));
      writeFileSync(join(out, "templates", "a.json", "mine.txt"), "mine");
      expect(failure(() => writeBrand(out, SOURCE, files("brand.json"))).code).toBe("out-edited");
      expect(readFileSync(join(out, "templates", "a.json", "mine.txt"), "utf8")).toBe("mine");
    });

    it("stops the import when a file has been replaced by a link, even to a file with the same content", (context) => {
      const out = imported("brand.json", "templates/a.json");
      const target = join(make(), "elsewhere.json");
      writeFileSync(target, "content of templates/a.json");
      rmSync(join(out, "templates", "a.json"));
      try {
        symlinkSync(target, join(out, "templates", "a.json"));
      } catch {
        // Links need a privilege on some systems; where there is none, there is nothing to test.
        context.skip();
      }
      expect(failure(() => writeBrand(out, SOURCE, files("brand.json", "templates/a.json"))).code).toBe(
        "out-edited",
      );
      // What the link points at was not written through.
      expect(readFileSync(target, "utf8")).toBe("content of templates/a.json");
    });

    it("does not stop the import for a file that has been deleted, or for files the import never wrote", () => {
      const out = imported("brand.json", "templates/a.json", "logos/logo.png");
      rmSync(join(out, "logos", "logo.png"));
      writeFileSync(join(out, "notes.txt"), "mine");
      const done = writeBrand(out, SOURCE, files("brand.json", "templates/a.json"));
      expect(done.removed).toEqual([]);
      expect(listing(out)).toEqual([IMPORT_MARKER, "brand.json", "notes.txt", "templates/a.json"]);
    });

    it("lets the next import replace a file that has not been changed, and says what it removed", () => {
      const out = imported("brand.json", "templates/a.json", "templates/b.json", "images/bg.jpg");
      const done = writeBrand(out, SOURCE, files("brand.json", "templates/a.json"));
      expect(done.removed).toEqual(["images/bg.jpg", "templates/b.json"]);
      expect(listing(out)).toEqual([IMPORT_MARKER, "brand.json", "templates/a.json"]);
    });

    it("removes nothing, and says so, when the files are the same", () => {
      const out = imported("brand.json", "templates/a.json");
      expect(writeBrand(out, SOURCE, files("brand.json", "templates/a.json")).removed).toEqual([]);
    });

    it("is not stopped by an import that stopped half-way, whether or not it had replaced the file yet", () => {
      const out = imported("brand.json", "templates/a.json");
      // A file named like the folder the picture goes in makes the second write fail, after the marker is down.
      writeFileSync(join(out, "images"), "a person's file");
      const second = new Map<string, string>([
        ["images/bg.png", "picture"],
        ["brand.json", "second"],
      ]);
      expect(failure(() => writeBrand(out, SOURCE, second)).code).toBe("write-failed");
      // brand.json is still the first import's, and the marker was already about the second. The next import still
      // knows both are the import's own.
      expect(readFileSync(join(out, "brand.json"), "utf8")).toBe("content of brand.json");
      rmSync(join(out, "images"));
      const done = writeBrand(out, SOURCE, files("brand.json"));
      expect(done.removed).toEqual([]);
      expect(listing(out)).toEqual([IMPORT_MARKER, "brand.json"]);
    });

    it("is stopped by a file changed after an import stopped half-way", () => {
      const out = imported("brand.json");
      writeFileSync(join(out, "images"), "a person's file");
      failure(() =>
        writeBrand(
          out,
          SOURCE,
          new Map([
            ["images/bg.png", "picture"],
            ["brand.json", "second"],
          ]),
        ),
      );
      rmSync(join(out, "images"));
      writeFileSync(join(out, "brand.json"), "neither the first nor the second");
      expect(failure(() => writeBrand(out, SOURCE, files("brand.json"))).code).toBe("out-edited");
    });
  });

  it("writes only names an import makes, so that the marker can list every file", () => {
    const out = join(make(), "brand");
    for (const name of [
      "notes.txt",
      "templates/Upper.json",
      "images/a.gif",
      "images/a..b.png",
      "../escape.json",
      "a/b.json",
    ]) {
      const error = failure(() => writeBrand(out, SOURCE, files("brand.json", name)));
      expect(error.code, name).toBe("write-failed");
      expect(error.message, name).toContain("which it does not write");
    }
    expect(existsSync(out)).toBe(false);
  });
});
