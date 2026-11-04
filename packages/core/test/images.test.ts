// Schema 0.6: an image block's fit, crop, focus and decorative, and a scene's background picture. The schema, the
// checks the schema cannot state, the version a scene is written at, and older decks loading as they did.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ApplyResult,
  applyOps,
  assetRefs,
  checkDeckFiles,
  checkFrames,
  checkScene,
  checkSceneVersion,
  type Doc,
  docToFiles,
  hasPlaceholderAlt,
  IMAGE_FITS,
  loadDoc,
  revisionOf,
  type Scene,
  upgradeScene,
} from "../src/index.ts";
import { BACKGROUND_COLORS } from "../src/schema.ts";
import { demoDir, demoDoc, loadDir, scene } from "./helpers.ts";

const decks = fileURLToPath(new URL("../../../fixtures/decks/", import.meta.url));
const run = (doc: Doc, ops: unknown) => applyOps(doc, ops, revisionOf(doc));
const ok = (result: ApplyResult) => {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};

const image = (fields: Record<string, unknown>) => ({
  id: "pic",
  type: "image",
  asset: "assets/a.png",
  ...fields,
});
/** A 0.6 scene whose second block is an image with `fields`, alt text included unless `fields` says otherwise. */
const withImage = (fields: Record<string, unknown>, alt: Record<string, unknown> = { alt: "A harbor." }) =>
  scene({
    schemaVersion: "0.6",
    blocks: [{ id: "pic-title", type: "text", role: "heading", text: "Hi" }, image({ ...alt, ...fields })],
  });
const withBackground = (background: unknown) => scene({ schemaVersion: "0.6", background });
/** What the structure check says, as code and path. */
const shape = (data: unknown) => checkScene(data, "scenes/a.json").map(({ code, path }) => ({ code, path }));
const sea = { asset: "assets/sea.jpg", scrim: 40 };

describe("an image block's fields in schema 0.6", () => {
  it("takes fit contain or cover and nothing else", () => {
    expect(IMAGE_FITS).toEqual(["contain", "cover"]);
    for (const fit of IMAGE_FITS) expect(shape(withImage({ fit }))).toEqual([]);
    expect(shape(withImage({ fit: "fill" }))).toEqual([{ code: "bad-value", path: "/blocks/1/fit" }]);
  });

  it("takes a crop with x and y from 0 to 100 and w and h from 5 to 100, all four and no more", () => {
    expect(shape(withImage({ crop: { x: 0, y: 0, w: 100, h: 100 } }))).toEqual([]);
    expect(shape(withImage({ crop: { x: 95, y: 95, w: 5, h: 5 } }))).toEqual([]);
    const at = (crop: unknown) => shape(withImage({ crop }));
    expect(at({ x: 0, y: 0, w: 4.9, h: 50 })).toEqual([{ code: "too-small", path: "/blocks/1/crop/w" }]);
    expect(at({ x: 0, y: 0, w: 50, h: 101 })).toEqual([{ code: "too-large", path: "/blocks/1/crop/h" }]);
    expect(at({ x: -1, y: 0, w: 50, h: 50 })).toEqual([{ code: "too-small", path: "/blocks/1/crop/x" }]);
    expect(at({ x: 0, y: 100.5, w: 50, h: 50 })).toEqual([{ code: "too-large", path: "/blocks/1/crop/y" }]);
    expect(at({ x: 0, y: 0, w: 50 })).toEqual([{ code: "missing-property", path: "/blocks/1/crop" }]);
    expect(at({ x: 0, y: 0, w: 50, h: 50, r: 1 })).toEqual([
      { code: "unknown-property", path: "/blocks/1/crop/r" },
    ]);
  });

  it("takes a focus point with x and y from 0 to 100, both and no more", () => {
    expect(shape(withImage({ focus: { x: 0, y: 100 } }))).toEqual([]);
    const at = (focus: unknown) => shape(withImage({ focus }));
    expect(at({ x: 101, y: 0 })).toEqual([{ code: "too-large", path: "/blocks/1/focus/x" }]);
    expect(at({ x: 0, y: -0.1 })).toEqual([{ code: "too-small", path: "/blocks/1/focus/y" }]);
    expect(at({ x: 50 })).toEqual([{ code: "missing-property", path: "/blocks/1/focus" }]);
    expect(at({ x: 50, y: 50, z: 1 })).toEqual([{ code: "unknown-property", path: "/blocks/1/focus/z" }]);
  });

  it("needs alt text unless the picture is decorative, and says so", () => {
    expect(shape(withImage({ decorative: true }, {}))).toEqual([]);
    expect(shape(withImage({ decorative: true }))).toEqual([]);
    for (const fields of [{}, { decorative: false }]) {
      const found = checkScene(withImage(fields, {}), "scenes/a.json");
      expect(found.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "missing-property", path: "/blocks/1" },
      ]);
      expect(found[0]?.message).toBe('Missing "alt": a picture needs alt text unless it is decorative.');
      expect(found[0]?.fix).toContain('set "decorative": true');
    }
    expect(shape(withImage({ decorative: "yes" }))).toEqual([
      { code: "wrong-type", path: "/blocks/1/decorative" },
    ]);
    expect(shape(withImage({}, { alt: "" }))).toEqual([{ code: "too-short", path: "/blocks/1/alt" }]);
    expect(shape(withImage({}, { alt: "a".repeat(251) }))).toEqual([
      { code: "too-long", path: "/blocks/1/alt" },
    ]);
    expect(shape(withImage({ decorative: true }, { alt: "" }))).toEqual([
      { code: "too-short", path: "/blocks/1/alt" },
    ]);
  });

  it("leaves a decorative picture out of the alt-is-filename advice", () => {
    const named = image({ asset: "assets/sea-waves.png", alt: "sea waves" });
    expect(hasPlaceholderAlt(named as never)).toBe(true);
    expect(hasPlaceholderAlt({ ...named, decorative: false } as never)).toBe(true);
    expect(hasPlaceholderAlt({ ...named, decorative: true } as never)).toBe(false);
  });
});

describe("a scene's background in schema 0.6", () => {
  it("takes a picture, a scrim, a palette color, a focus point and alt text or decorative", () => {
    expect(
      shape(withBackground({ ...sea, color: "text", focus: { x: 20, y: 80 }, alt: "The sea." })),
    ).toEqual([]);
    expect(shape(withBackground({ ...sea, scrim: 0, decorative: true }))).toEqual([]);
    for (const color of BACKGROUND_COLORS)
      expect(shape(withBackground({ ...sea, color, alt: "x" }))).toEqual([]);
  });

  it("needs alt text unless it is decorative, and says so", () => {
    for (const background of [sea, { ...sea, decorative: false }]) {
      const found = checkScene(withBackground(background), "scenes/a.json");
      expect(found.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "missing-property", path: "/background" },
      ]);
      expect(found[0]?.message).toContain("unless it is decorative");
    }
  });

  it("refuses each field out of its bounds, a missing asset or scrim, and any other field", () => {
    const at = (fields: Record<string, unknown>) => shape(withBackground({ ...sea, alt: "x", ...fields }));
    expect(at({ scrim: 101 })).toEqual([{ code: "too-large", path: "/background/scrim" }]);
    expect(at({ scrim: -1 })).toEqual([{ code: "too-small", path: "/background/scrim" }]);
    expect(at({ color: "muted" })).toEqual([{ code: "bad-value", path: "/background/color" }]);
    expect(at({ asset: "images/sea.jpg" })).toEqual([{ code: "bad-format", path: "/background/asset" }]);
    expect(at({ focus: { x: 120, y: 0 } })).toEqual([{ code: "too-large", path: "/background/focus/x" }]);
    expect(at({ alt: "" })).toEqual([{ code: "too-short", path: "/background/alt" }]);
    expect(at({ image: "assets/sea.jpg" })).toEqual([
      { code: "unknown-property", path: "/background/image" },
    ]);
    expect(shape(withBackground({ asset: "assets/sea.jpg", alt: "x" }))).toEqual([
      { code: "missing-property", path: "/background" },
    ]);
    expect(shape(withBackground({ scrim: 40, alt: "x" }))).toEqual([
      { code: "missing-property", path: "/background" },
    ]);
  });

  it("is an asset of the scene, so a missing file is reported where the background names it", () => {
    expect(assetRefs(withBackground({ ...sea, decorative: true }) as Scene)).toEqual([
      { path: "/background/asset", asset: "assets/sea.jpg" },
    ]);
    const files = loadDir(demoDir);
    const opening = JSON.parse(files.text["scenes/opening.json"] as string);
    const text = {
      ...files.text,
      "scenes/opening.json": JSON.stringify({
        ...opening,
        schemaVersion: "0.6",
        background: { ...sea, alt: "x" },
      }),
    };
    expect(checkDeckFiles({ ...files, text })).toEqual([
      expect.objectContaining({
        code: "missing-asset",
        file: "scenes/opening.json",
        path: "/background/asset",
        message: "assets/sea.jpg does not exist.",
      }),
    ]);
  });

  it("is refused by scene.set when its file is missing, and written when it is there", () => {
    const set = (asset: string) => [
      {
        op: "scene.set",
        id: "opening",
        set: { background: { asset, scrim: 40, alt: "The method diagram." } },
      },
    ];
    const missing = run(demoDoc(), set("assets/sea.jpg"));
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics).toEqual([
      expect.objectContaining({
        code: "missing-asset",
        file: "scenes/opening.json",
        path: "/background/asset",
      }),
    ]);
    const done = ok(run(demoDoc(), set("assets/method.svg")));
    expect(done.doc.scenes.opening).toMatchObject({
      schemaVersion: "0.6",
      background: { asset: "assets/method.svg", scrim: 40 },
    });
  });
});

describe("image-crop-outside", () => {
  const cropped = (crop: Record<string, number>) =>
    checkFrames(withImage({ crop }) as Scene, "scenes/a.json");

  it("is an error when the crop runs past the picture's right edge, with what to change", () => {
    expect(cropped({ x: 30, y: 0, w: 80, h: 50 })).toEqual([
      {
        severity: "error",
        code: "image-crop-outside",
        file: "scenes/a.json",
        path: "/blocks/1/crop/w",
        message: "The crop runs to 110% across the picture; the picture ends at 100%.",
        fix: "Make w at most 70, or make x smaller. The crop is in percent of the picture's own width and height.",
      },
    ]);
  });

  it("is an error at the bottom edge too, and once for each edge", () => {
    expect(cropped({ x: 0, y: 60, w: 50, h: 50 }).map((d) => d.path)).toEqual(["/blocks/1/crop/h"]);
    expect(cropped({ x: 60, y: 60, w: 50, h: 50 }).map((d) => d.path)).toEqual([
      "/blocks/1/crop/w",
      "/blocks/1/crop/h",
    ]);
  });

  it("is quiet for a crop that reaches the edge exactly", () => {
    expect(cropped({ x: 20, y: 30, w: 80, h: 70 })).toEqual([]);
  });

  it("refuses an operation that leaves a crop outside the picture", () => {
    const failed = run(demoDoc(), [
      {
        op: "block.set",
        scene: "method",
        id: "method-diagram",
        set: { crop: { x: 50, y: 0, w: 60, h: 100 } },
      },
    ]);
    expect(failed.ok).toBe(false);
    expect(failed.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["image-crop-outside", "/blocks/2/crop/w"],
    ]);
  });
});

describe("the version a scene is written at", () => {
  const tidewell = (): Doc => {
    const { doc, diagnostics } = loadDoc(loadDir(join(decks, "tidewell-press")));
    if (!doc) throw new Error(JSON.stringify(diagnostics));
    return doc;
  };
  const picture = (set: Record<string, unknown>) => [
    { op: "block.set", scene: "launch-day", id: "launch-day-picture", set },
  ];

  it("raises a 0.4 scene to 0.6 when block.set gives its image a crop, and only that scene", () => {
    const doc = tidewell();
    expect(doc.scenes["launch-day"]?.schemaVersion).toBe("0.4");
    const done = ok(run(doc, picture({ crop: { x: 10, y: 0, w: 80, h: 100 } })));
    expect(done.changed).toEqual(["launch-day"]);
    expect(done.doc.scenes["launch-day"]?.schemaVersion).toBe("0.6");
    expect(done.doc.scenes["launch-day"]?.blocks[0]).toMatchObject({ crop: { x: 10, y: 0, w: 80, h: 100 } });
    expect(done.doc.deck.schemaVersion).toBe("0.4");
  });

  it.each([{ fit: "contain" }, { focus: { x: 10, y: 90 } }, { decorative: true }])(
    "raises it for %j too",
    (set) => {
      expect(ok(run(tidewell(), picture(set))).doc.scenes["launch-day"]?.schemaVersion).toBe("0.6");
    },
  );

  it("keeps the version of a scene that gains none of them", () => {
    const done = ok(run(tidewell(), picture({ alt: "The harbor mouth at low water, from the mole." })));
    expect(done.doc.scenes["launch-day"]?.schemaVersion).toBe("0.4");
  });

  it("raises a scene below 0.3 to 0.6 and escapes its text, as any newer part does", () => {
    const doc = demoDoc();
    const done = ok(
      run(doc, [
        { op: "block.set", scene: "method", id: "method-body", set: { text: "Counted *once*." } },
        { op: "block.set", scene: "method", id: "method-diagram", set: { fit: "cover" } },
      ]),
    );
    const before = doc.scenes.method as Scene;
    const after = done.doc.scenes.method as Scene;
    expect([before.schemaVersion, after.schemaVersion]).toEqual(["0.1", "0.6"]);
    // The stars were written into a scene that showed them as stars, so they stay stars once it reads markup.
    expect(after.blocks.find((block) => block.id === "method-body")).toMatchObject({
      text: "Counted \\*once\\*.",
    });
    const heading = (each: Scene) => each.blocks.find((block) => block.id === "method-heading");
    expect(heading(after)).toEqual(heading(upgradeScene(before)));
    expect(after.blocks.find((block) => block.id === "method-diagram")).toMatchObject({ fit: "cover" });
  });

  it("deletes a field given null, and keeps the version it was raised to", () => {
    const first = ok(run(tidewell(), picture({ fit: "cover", crop: { x: 0, y: 0, w: 50, h: 50 } })));
    const next = ok(applyOps(first.doc, picture({ crop: null, fit: null }), first.rev));
    const block = next.doc.scenes["launch-day"]?.blocks[0] as Record<string, unknown>;
    expect([block.crop, block.fit]).toEqual([undefined, undefined]);
    expect(next.doc.scenes["launch-day"]?.schemaVersion).toBe("0.6");
    const background = ok(
      applyOps(
        next.doc,
        [
          {
            op: "scene.set",
            id: "launch-day",
            set: { background: { ...sea, asset: "assets/tidepool.svg", decorative: true } },
          },
        ],
        next.rev,
      ),
    );
    expect(background.doc.scenes["launch-day"]?.background).toEqual({
      asset: "assets/tidepool.svg",
      scrim: 40,
      decorative: true,
    });
    const cleared = ok(
      applyOps(
        background.doc,
        [{ op: "scene.set", id: "launch-day", set: { background: null } }],
        background.rev,
      ),
    );
    expect(cleared.doc.scenes["launch-day"]?.background).toBeUndefined();
  });

  it("refuses a file that uses a 0.6 field under an older version, and says how to raise it", () => {
    const old = (data: Record<string, unknown>) =>
      checkSceneVersion({ ...data, schemaVersion: "0.5" } as Scene, "scenes/a.json").map((d) => [
        d.code,
        d.path,
      ]);
    expect(old(withImage({ crop: { x: 0, y: 0, w: 50, h: 50 }, decorative: true }))).toEqual([
      ["crop-needs-version", "/blocks/1/crop"],
      ["decorative-needs-version", "/blocks/1/decorative"],
    ]);
    expect(old(withBackground({ ...sea, decorative: true }))).toEqual([
      ["background-needs-version", "/background"],
    ]);
    const [found] = checkSceneVersion(
      { ...withBackground({ ...sea, decorative: true }), schemaVersion: "0.4" } as Scene,
      "scenes/a.json",
    );
    expect(found?.fix).toContain("the tool rewrites the file as 0.6");
  });
});

describe("older decks", () => {
  it.each(["v0-1", "v0-2", "v0-3", "v0-4-brand", "demo"])(
    "%s loads with no errors and writes back what it read",
    (name) => {
      const files = loadDir(join(decks, name));
      expect(checkDeckFiles(files).filter((d) => d.severity === "error")).toEqual([]);
      const { doc } = loadDoc(files);
      if (!doc) throw new Error(`${name} should load`);
      const written = docToFiles(doc);
      for (const [path, text] of Object.entries(written))
        expect(JSON.parse(text), path).toEqual(JSON.parse(files.text[path] as string));
    },
  );
});
