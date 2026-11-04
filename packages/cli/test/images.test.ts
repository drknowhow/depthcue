// packages/cli/src/images.ts: reading a picture's size from its header, adding a file, listing what the deck uses.
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDeck } from "../src/deck-api.ts";
import {
  addImage,
  ImageRefused,
  imageSize,
  LARGE_ASSET_BYTES,
  largeImageDiagnostics,
  listImages,
  MAX_ASSET_BYTES,
  readImageFile,
  removeImage,
  sniffImage,
} from "../src/images.ts";
import { gif, jpeg, png, svg, webpExtended, webpLossless, webpLossy } from "./images-fixtures.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));
const made: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-images-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const deck = () => {
  const dir = temp();
  cpSync(demo, dir, { recursive: true });
  return dir;
};
const open = (dir: string) => {
  const opened = openDeck(dir);
  if (!opened.ok) throw new Error("the deck should open");
  return opened.doc;
};
const sized = (bytes: Buffer) => {
  const kind = sniffImage(bytes);
  return kind ? imageSize(bytes, kind) : undefined;
};

describe("imageSize", () => {
  it("reads a PNG's header", () => {
    expect(sized(png(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("reads a JPEG whose EXIF, quantization and Huffman segments come before the frame", () => {
    expect(sized(jpeg(4000, 3000))).toEqual({ width: 4000, height: 3000 });
  });

  it("reads a progressive JPEG, and does not take a Huffman table (C4) for a frame", () => {
    expect(sized(jpeg(321, 123, 0xc2))).toEqual({ width: 321, height: 123 });
  });

  it("reads a GIF's logical screen", () => {
    expect(sized(gif(90, 60))).toEqual({ width: 90, height: 60 });
  });

  it("reads all three kinds of WebP", () => {
    expect(sized(webpLossy(800, 600))).toEqual({ width: 800, height: 600 });
    expect(sized(webpLossless(1023, 17))).toEqual({ width: 1023, height: 17 });
    expect(sized(webpExtended(5000, 3333))).toEqual({ width: 5000, height: 3333 });
  });

  it("reads an SVG's width and height, with units", () => {
    expect(sized(svg('width="200" height="100"'))).toEqual({ width: 200, height: 100 });
    expect(sized(svg('width="1in" height="0.5in"'))).toEqual({ width: 96, height: 48 });
  });

  it("reads an SVG that has only a viewBox", () => {
    expect(sized(svg('viewBox="0 0 480 270"'))).toEqual({ width: 480, height: 270 });
    expect(sized(svg('width="100%" height="100%" viewBox="0 0 30 20"'))).toEqual({ width: 30, height: 20 });
  });

  it("says nothing for an SVG with no size, and for a header cut short", () => {
    expect(sized(svg(""))).toBeUndefined();
    expect(imageSize(png(10, 10).subarray(0, 20), "png")).toBeUndefined();
    expect(imageSize(jpeg(10, 10).subarray(0, 60), "jpg")).toBeUndefined();
    expect(imageSize(Buffer.from("RIFF....WEBPVP8 "), "webp")).toBeUndefined();
  });
});

describe("addImage", () => {
  it("stores an image under a hashed name and reports its size", () => {
    const dir = deck();
    const added = addImage(dir, png(300, 200), "My Chart.PNG");
    expect(added.asset).toMatch(/^assets\/my-chart-[0-9a-f]{8}\.png$/);
    expect(added).toMatchObject({ kind: "png", width: 300, height: 200 });
    expect(readFileSync(join(dir, added.asset)).equals(png(300, 200))).toBe(true);
    expect(readdirSync(join(dir, "assets")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("is idempotent for identical bytes, and keeps different bytes apart", () => {
    const dir = deck();
    const first = addImage(dir, png(5, 5), "a.png");
    const before = readdirSync(join(dir, "assets")).length;
    expect(addImage(dir, png(5, 5), "a.png")).toEqual(first);
    expect(readdirSync(join(dir, "assets")).length).toBe(before);
    expect(addImage(dir, png(6, 5), "a.png").asset).not.toBe(first.asset);
  });

  it("refuses a file that is too large, not an image, or an SVG with script, and writes nothing", () => {
    const dir = deck();
    const before = readdirSync(join(dir, "assets")).sort();
    const refusal = (bytes: Buffer) => {
      try {
        addImage(dir, bytes, "x.png");
      } catch (error) {
        return error instanceof ImageRefused ? error.code : "other";
      }
      return "added";
    };
    expect(refusal(png(2, 2, MAX_ASSET_BYTES))).toBe("too-large");
    expect(refusal(Buffer.from("%PDF-1.7"))).toBe("unsupported");
    expect(refusal(svg('viewBox="0 0 1 1"', "<script>alert(1)</script>"))).toBe("unsupported");
    expect(readdirSync(join(dir, "assets")).sort()).toEqual(before);
  });
});

describe("readImageFile", () => {
  const code = (path: string) => {
    try {
      readImageFile(path);
    } catch (error) {
      return (error as ImageRefused).code;
    }
    return "read";
  };

  it("reads a regular file and takes its name from the file", () => {
    const file = join(temp(), "photo.png");
    writeFileSync(file, png(4, 4));
    const read = readImageFile(file);
    expect(read.name).toBe("photo.png");
    expect(read.bytes.equals(png(4, 4))).toBe(true);
  });

  it("refuses a directory, a relative path, a missing file and a file over the limit", () => {
    const dir = temp();
    expect(code(dir)).toBe("not-a-file");
    expect(code("photo.png")).toBe("not-a-file");
    expect(code(join(dir, "nothing.png"))).toBe("unreadable");
    writeFileSync(join(dir, "big.png"), Buffer.alloc(MAX_ASSET_BYTES + 1, 1));
    expect(code(join(dir, "big.png"))).toBe("too-large");
  });

  it("refuses a symbolic link", () => {
    const dir = temp();
    writeFileSync(join(dir, "real.png"), png(4, 4));
    try {
      symlinkSync(join(dir, "real.png"), join(dir, "link.png"));
    } catch {
      return; // creating a link needs a privilege some machines do not give.
    }
    expect(code(join(dir, "link.png"))).toBe("not-a-file");
  });
});

describe("listImages", () => {
  it("lists images with their size and where the deck names each", () => {
    const dir = deck();
    const extra = addImage(dir, png(64, 32), "spare.png");
    const images = listImages(dir, open(dir));
    expect(images.map((image) => image.asset)).toEqual(["assets/method.svg", extra.asset].sort());
    const method = images.find((image) => image.asset === "assets/method.svg");
    expect(method?.usedBy).toEqual([
      { scene: "method", path: expect.stringMatching(/^\/blocks\/\d+\/asset$/) },
    ]);
    expect(images.find((image) => image.asset === extra.asset)).toMatchObject({
      width: 64,
      height: 32,
      usedBy: [],
    });
  });

  it("counts a saved link to a file as a use", () => {
    const dir = deck();
    const extra = addImage(dir, png(8, 8), "spare.png");
    const file = join(dir, "deck.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    parsed.schemaVersion = "0.5";
    parsed.links = [{ id: "spare", title: "Spare", target: extra.asset }];
    writeFileSync(file, JSON.stringify(parsed));
    expect(listImages(dir, open(dir)).find((image) => image.asset === extra.asset)?.usedBy).toEqual([
      { scene: null, path: "/links/0/target" },
    ]);
  });
});

describe("removeImage", () => {
  it("deletes an unused image and refuses a used one, a non-image and a path outside assets", () => {
    const dir = deck();
    const extra = addImage(dir, png(8, 8), "spare.png");
    expect(removeImage(dir, open(dir), "assets/method.svg")).toMatchObject({ ok: false, code: "in-use" });
    expect(removeImage(dir, open(dir), "assets/report.csv")).toMatchObject({
      ok: false,
      code: "not-an-image",
    });
    expect(removeImage(dir, open(dir), "deck.json")).toMatchObject({ ok: false, code: "not-an-image" });
    expect(removeImage(dir, open(dir), "assets/../deck.json")).toMatchObject({ ok: false });
    expect(existsSync(join(dir, "assets/method.svg"))).toBe(true);
    expect(removeImage(dir, open(dir), extra.asset)).toEqual({ ok: true, asset: extra.asset });
    expect(existsSync(join(dir, extra.asset))).toBe(false);
  });
});

describe("asset-large", () => {
  it("warns about an image a scene uses over 4 MB, and not about one nothing uses or one under it", () => {
    const dir = deck();
    writeFileSync(
      join(dir, "assets/method.svg"),
      svg('viewBox="0 0 10 10"', `<!--${"x".repeat(LARGE_ASSET_BYTES)}-->`),
    );
    addImage(dir, png(2, 2, LARGE_ASSET_BYTES + 10), "unused.png");
    const found = largeImageDiagnostics(dir, open(dir));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", code: "asset-large", file: "scenes/method.json" });
    expect(found[0]?.fix).toBeTruthy();
    const small = deck();
    expect(largeImageDiagnostics(small, open(small))).toEqual([]);
  });
});
