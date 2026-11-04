import type { Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  type LayoutMeasure,
  LOW_RESOLUTION_RATIO,
  layoutDiagnostics,
  type Rgba,
  requiredContrast,
  type TextSample,
} from "../src/layout.ts";

const rgb = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const white = rgb(255, 255, 255);

const scene = {
  schemaVersion: "0.1",
  id: "tall",
  title: "Tall",
  layout: "claim-evidence",
  summary: { id: "the-claim", text: "A short claim.", evidenceIds: ["the-chart"] },
  blocks: [
    { id: "intro", type: "text", role: "body", text: "one two three four five six" },
    { id: "the-chart", type: "bar-chart", data: [{ label: "A", value: 1 }] },
  ],
  sources: [{ id: "the-source", title: "Source" }],
} as unknown as Scene;

function measure(overrides: Partial<LayoutMeasure> = {}): LayoutMeasure {
  return {
    viewport: { width: 1280, height: 720 },
    view: { width: 1280, height: 720, scrollWidth: 1280, scrollHeight: 720 },
    boxes: [],
    clipped: [],
    overlaps: [],
    spills: [],
    text: [],
    images: [],
    words: 0,
    ...overrides,
  };
}

const sample = (overrides: Partial<TextSample> = {}): TextSample => ({
  id: "intro",
  text: "one two",
  fontPx: 18,
  weight: 400,
  fg: rgb(0, 0, 0),
  bg: white,
  ...overrides,
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio(rgb(0, 0, 0), white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    expect(contrastRatio(rgb(119, 119, 119), white)).toBeCloseTo(4.48, 2);
    expect(contrastRatio(rgb(118, 118, 118), white)).toBeCloseTo(4.54, 2);
  });

  it("does not care which of the two is lighter", () => {
    expect(contrastRatio(white, rgb(0, 0, 0))).toBeCloseTo(21, 5);
  });

  it("blends translucent text into its background first", () => {
    const half = contrastRatio(rgb(0, 0, 0, 0.5), white);
    expect(half).toBeGreaterThan(1);
    expect(half).toBeLessThan(contrastRatio(rgb(0, 0, 0), white));
  });
});

describe("requiredContrast", () => {
  it("asks 3:1 of large text and 4.5:1 of the rest", () => {
    expect(requiredContrast(24, 400)).toBe(3);
    expect(requiredContrast(18.7, 700)).toBe(3);
    expect(requiredContrast(18.7, 400)).toBe(4.5);
    expect(requiredContrast(16, 700)).toBe(4.5);
  });
});

describe("layoutDiagnostics", () => {
  it("passes a scene that fits", () => {
    expect(layoutDiagnostics(scene, measure({ text: [sample()] }))).toEqual([]);
  });

  it("reports vertical overflow with the cut-off blocks and the repair order", () => {
    const [found] = layoutDiagnostics(
      scene,
      measure({
        view: { width: 1280, height: 720, scrollWidth: 1280, scrollHeight: 900 },
        boxes: [{ id: "the-chart", x: 0, y: 700, width: 600, height: 200, beyond: "bottom" }],
      }),
    );
    expect(found).toMatchObject({
      severity: "error",
      code: "overflow",
      file: "scenes/tall.json",
      path: "/blocks/1",
    });
    expect(found?.message).toContain("180px taller than the 1280x720 stage");
    expect(found?.message).toContain("the-chart");
    expect(found?.fix).toContain('"intro" is the longest');
    expect(found?.fix).toMatch(
      /Shorten the text first.*roomier template.*split the scene.*Nothing is scaled down/,
    );
  });

  it("says so when every block is visible but the margins no longer fit", () => {
    const [found] = layoutDiagnostics(
      scene,
      measure({
        view: { width: 1280, height: 720, scrollWidth: 1280, scrollHeight: 781 },
        boxes: [{ id: "intro", x: 0, y: 600, width: 600, height: 118, beyond: null }],
      }),
    );
    expect(found?.code).toBe("overflow");
    expect(found?.message).toContain("61px taller");
    expect(found?.message).toContain("Every block is visible, but there is no room left for the margins.");
    expect(found?.path).toBe("");
  });

  it("reports sideways overflow", () => {
    const [found] = layoutDiagnostics(
      scene,
      measure({ view: { width: 1280, height: 720, scrollWidth: 1400, scrollHeight: 720 } }),
    );
    expect(found?.code).toBe("overflow-x");
    expect(found?.message).toContain("120px wider");
  });

  it("tolerates a one pixel rounding difference", () => {
    expect(
      layoutDiagnostics(
        scene,
        measure({ view: { width: 1280, height: 720, scrollWidth: 1281, scrollHeight: 721 } }),
      ),
    ).toEqual([]);
  });

  it("reports one clip per block and axis, and each overlap once", () => {
    const found = layoutDiagnostics(
      scene,
      measure({
        clipped: [
          { id: "intro", axis: "y", by: 12 },
          { id: "intro", axis: "y", by: 12 },
          { id: "intro", axis: "x", by: 5 },
        ],
        overlaps: [{ a: "intro", b: "the-chart", width: 40, height: 10, pinned: [] }],
      }),
    );
    expect(found.map((d) => d.code)).toEqual(["clipped", "clipped", "overlap"]);
    expect(found[2]?.message).toContain('"intro" and "the-chart" overlap by 40x10px');
  });

  describe("pinned blocks", () => {
    it("treats an overlap in the template as an error, as before", () => {
      const [found] = layoutDiagnostics(
        scene,
        measure({ overlaps: [{ a: "intro", b: "the-chart", width: 40, height: 10, pinned: [] }] }),
      );
      expect(found).toMatchObject({ severity: "error", code: "overlap" });
    });

    it("warns about an overlap with a pinned block, and points at the pinned block", () => {
      const [found, ...rest] = layoutDiagnostics(
        scene,
        measure({ overlaps: [{ a: "intro", b: "the-chart", width: 40, height: 10, pinned: ["the-chart"] }] }),
      );
      expect(rest).toEqual([]);
      expect(found).toMatchObject({
        severity: "warning",
        code: "frame-overlap",
        file: "scenes/tall.json",
        path: "/blocks/1",
      });
      expect(found?.message).toBe('"intro" and "the-chart" overlap by 40x10px.');
      expect(found?.fix).toBe(
        'Move or resize the frame of "the-chart", or unpin it to put it back in the template. Leave it if the overlap is on purpose.',
      );
    });

    it("names both frames when both blocks are pinned, and has nothing to unpin to", () => {
      const [found] = layoutDiagnostics(
        scene,
        measure({
          overlaps: [{ a: "intro", b: "the-chart", width: 40, height: 10, pinned: ["intro", "the-chart"] }],
        }),
      );
      expect(found).toMatchObject({ severity: "warning", code: "frame-overlap", path: "/blocks/0" });
      expect(found?.fix).toBe(
        'Move or resize the frame of "intro" or "the-chart". Leave it if the overlap is on purpose.',
      );
    });

    it("reports a block that is larger than its frame as an error, by how much", () => {
      const [tall, wide, ...rest] = layoutDiagnostics(
        scene,
        measure({
          spills: [
            { id: "intro", x: 0, y: 42 },
            { id: "the-chart", x: 17, y: 0 },
          ],
        }),
      );
      expect(rest).toEqual([]);
      expect(tall).toMatchObject({
        severity: "error",
        code: "frame-overflow",
        file: "scenes/tall.json",
        path: "/blocks/0",
      });
      expect(tall?.message).toBe(
        'The content of "intro" is 42px taller than its frame, so it runs out of the frame over whatever is next to it.',
      );
      expect(tall?.fix).toBe(
        "Make the frame bigger, shorten the text, or unpin the block so the template lays it out.",
      );
      expect(wide).toMatchObject({ code: "frame-overflow", path: "/blocks/1" });
      expect(wide?.message).toContain("17px wider than its frame");
    });
  });

  describe("a branded template", () => {
    it("reports a slot whose blocks are bigger than it, by how much, and points at the block that runs out", () => {
      const [tall, wide, ...rest] = layoutDiagnostics(
        scene,
        measure({
          slots: [
            { id: "left", template: "split", block: "intro", x: 0, y: 42 },
            { id: "right", template: "split", block: "the-chart", x: 17, y: 0 },
          ],
        }),
      );
      expect(rest).toEqual([]);
      expect(tall).toMatchObject({
        severity: "error",
        code: "slot-overflow",
        file: "scenes/tall.json",
        path: "/blocks/0",
      });
      expect(tall?.message).toBe(
        'The blocks in the slot "left" of the template "split" are 42px taller than the slot, so they run out of it over whatever is next to it.',
      );
      expect(tall?.fix).toContain("pick a template whose slot is bigger");
      expect(wide).toMatchObject({ code: "slot-overflow", path: "/blocks/1" });
      expect(wide?.message).toContain("17px wider than the slot");
    });

    it("reports the brand's chrome lying over a block, naming the part and how far it reaches", () => {
      const found = layoutDiagnostics(
        scene,
        measure({
          chrome: [
            { part: "logo", id: "intro", width: 80, height: 24 },
            { part: "number", id: "the-chart", width: 12, height: 9 },
          ],
        }),
      );
      expect(found.map((d) => [d.code, d.severity, d.path])).toEqual([
        ["chrome-overlap", "error", "/blocks/0"],
        ["chrome-overlap", "error", "/blocks/1"],
      ]);
      expect(found[0]?.message).toBe('The brand\'s logo overlaps "intro" by 80x24px.');
      expect(found[1]?.message).toBe('The brand\'s slide number overlaps "the-chart" by 12x9px.');
      expect(found[0]?.fix).toContain('"minimal" or "none"');
    });

    const line = (ratio: number, more: Partial<NonNullable<LayoutMeasure["picture"]>[number]> = {}) => ({
      id: "intro",
      text: "one two",
      ratio,
      fontPx: 18,
      weight: 400,
      ...more,
    });

    it("reports text whose contrast over the picture falls short, from the pixels measured", () => {
      const [found, ...rest] = layoutDiagnostics(scene, measure({ picture: [line(2.7)] }));
      expect(rest).toEqual([]);
      expect(found).toMatchObject({
        severity: "error",
        code: "background-low-contrast",
        file: "scenes/tall.json",
        path: "/blocks/0",
      });
      expect(found?.message).toBe(
        'Text in "intro" has a contrast of 2.70:1 over the template\'s picture where the picture is weakest; WCAG AA needs 4.5:1: "one two".',
      );
      expect(found?.fix).toContain("Raise the template's scrim");
    });

    it("asks large text for 3:1, passes a line that reaches its minimum, and names the weakest line of a block once", () => {
      expect(layoutDiagnostics(scene, measure({ picture: [line(3.1, { fontPx: 28 })] }))).toEqual([]);
      expect(layoutDiagnostics(scene, measure({ picture: [line(4.5)] }))).toEqual([]);
      const found = layoutDiagnostics(scene, measure({ picture: [line(5), line(3.4), line(4)] }));
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toContain("3.40:1");
    });

    it("leaves the page's own colors out of it over a picture, where they say nothing of what is under the text", () => {
      const faint = sample({ fg: rgb(200, 200, 200), bg: white, picture: true });
      expect(layoutDiagnostics(scene, measure({ text: [faint] }))).toEqual([]);
      const [found] = layoutDiagnostics(scene, measure({ text: [{ ...faint, picture: false }] }));
      expect(found?.code).toBe("low-contrast");
    });

    it("says to check the brand folder when a brand image did not load", () => {
      const [found] = layoutDiagnostics(
        scene,
        measure({ images: [{ id: "", src: "./brand/logos/mark.svg", ok: false }] }),
      );
      expect(found).toMatchObject({ code: "image-failed" });
      expect(found?.fix).toBe("Check that the file exists in the brand folder and is a valid image.");
    });
  });

  it("flags text under the minimum size once per block, naming the smallest", () => {
    const found = layoutDiagnostics(
      scene,
      measure({
        text: [
          sample({ fontPx: 11, text: "tiny" }),
          sample({ fontPx: 9, text: "tinier" }),
          sample({ fontPx: 18 }),
        ],
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "text-too-small", path: "/blocks/0" });
    expect(found[0]?.message).toContain("9px");
    expect(found[0]?.message).toContain("tinier");
  });

  it("lets the caller set the minimum", () => {
    expect(
      layoutDiagnostics(scene, measure({ text: [sample({ fontPx: 14 })] }), { minFontPx: 16 }),
    ).toHaveLength(1);
    expect(layoutDiagnostics(scene, measure({ text: [sample({ fontPx: 14 })] }), { minFontPx: 12 })).toEqual(
      [],
    );
  });

  it("flags low contrast with the ratio and what AA needs", () => {
    const [found] = layoutDiagnostics(scene, measure({ text: [sample({ fg: rgb(160, 160, 160) })] }));
    expect(found?.code).toBe("low-contrast");
    expect(found?.message).toMatch(/2\.\d\d:1; WCAG AA needs 4\.5:1/);
    expect(found?.fix).toContain("theme");
  });

  it("names the tone of low-contrast text that is colored with one, and the ways out that a tone has", () => {
    const faint = rgb(224, 101, 61);
    const [found] = layoutDiagnostics(scene, measure({ text: [sample({ fg: faint, tone: "action" })] }));
    expect(found?.code).toBe("low-contrast");
    expect(found?.fix).toContain('colored "action"');
    expect(found?.fix).toContain("size l or xl");
    expect(found?.fix).not.toContain("the other theme");
  });

  it("accepts text of a tone at 3:1 when it is drawn large, as size l and xl are", () => {
    const faint = rgb(224, 101, 61);
    expect(contrastRatio(faint, white)).toBeGreaterThan(3);
    expect(contrastRatio(faint, white)).toBeLessThan(4.5);
    expect(
      layoutDiagnostics(scene, measure({ text: [sample({ fg: faint, tone: "action", fontPx: 25 })] })),
    ).toEqual([]);
    expect(
      layoutDiagnostics(scene, measure({ text: [sample({ fg: faint, tone: "action", fontPx: 22 })] })),
    ).toHaveLength(1);
  });

  it("accepts large text at 3:1", () => {
    const grey = rgb(130, 130, 130);
    expect(contrastRatio(grey, white)).toBeGreaterThan(3);
    expect(contrastRatio(grey, white)).toBeLessThan(4.5);
    expect(layoutDiagnostics(scene, measure({ text: [sample({ fg: grey, fontPx: 40 })] }))).toEqual([]);
    expect(layoutDiagnostics(scene, measure({ text: [sample({ fg: grey, fontPx: 16 })] }))).toHaveLength(1);
  });

  it("points at the summary and at sources, not only at blocks", () => {
    const found = layoutDiagnostics(
      scene,
      measure({
        clipped: [
          { id: "the-claim", axis: "y", by: 3 },
          { id: "the-source", axis: "y", by: 3 },
          { id: "", axis: "y", by: 3 },
        ],
      }),
    );
    expect(found.map((d) => d.path)).toEqual(["/summary", "/sources/0", ""]);
  });

  it("reports an image that did not load", () => {
    const [found] = layoutDiagnostics(
      scene,
      measure({ images: [{ id: "intro", src: "./assets/gone.png", ok: false }] }),
    );
    expect(found).toMatchObject({ code: "image-failed", path: "/blocks/0" });
    expect(found?.message).toContain("./assets/gone.png");
  });

  describe("image-low-resolution", () => {
    const shown = (drawnW: number, drawnH: number, shownW = 400, shownH = 300) => ({
      id: "intro",
      src: "./assets/photo.png",
      ok: true,
      scale: { shownW, shownH, drawnW, drawnH },
    });
    const lowOf = (image: ReturnType<typeof shown>) =>
      layoutDiagnostics(scene, measure({ images: [image] })).filter((d) => d.code === "image-low-resolution");

    it("keeps its limit named: 1.5 times the pixels of the part that shows", () => {
      expect(LOW_RESOLUTION_RATIO).toBe(1.5);
    });

    it("warns, at the block, when the box is more than 1.5 times wider or taller than the shown pixels", () => {
      const [wide] = lowOf(shown(601, 300));
      expect(wide).toMatchObject({ severity: "warning", code: "image-low-resolution", path: "/blocks/0" });
      expect(wide?.message).toContain("601x300px");
      expect(wide?.message).toContain("400x300px");
      expect(wide?.fix).toContain("401x200px");
      expect(lowOf(shown(400, 451))).toHaveLength(1);
    });

    it("is quiet at the limit, below it, and for a picture with no measure (a vector, the logo, one not shown)", () => {
      expect(lowOf(shown(600, 450))).toEqual([]);
      expect(lowOf(shown(200, 150))).toEqual([]);
      const { scale: _scale, ...vector } = shown(900, 900);
      expect(lowOf(vector as ReturnType<typeof shown>)).toEqual([]);
    });

    it("measures against the crop's pixels, which the caller has already taken from the file", () => {
      // 1000 pixels of the file, 150 shown: drawn 300 wide is twice what is there.
      expect(lowOf(shown(300, 200, 150, 100))).toHaveLength(1);
      expect(lowOf(shown(300, 200, 1000, 700))).toEqual([]);
    });
  });

  describe("background-low-contrast on a scene's background", () => {
    const line = (ratioOver: number) => ({
      id: "intro",
      text: "one two",
      ratio: ratioOver,
      fontPx: 18,
      weight: 400,
    });
    const backed = { ...scene, background: { asset: "assets/sea.png", scrim: 10, alt: "The sea" } } as Scene;

    it("fires for a scene background with a low scrim, naming the scene's scrim in the fix", () => {
      const [found] = layoutDiagnostics(backed, measure({ picture: [line(2.1)] }));
      expect(found).toMatchObject({ severity: "error", code: "background-low-contrast", path: "/blocks/0" });
      expect(found?.message).toContain("scene's background picture");
      expect(found?.fix).toContain("scrim: 40");
      expect(found?.fix).not.toContain("template's scrim");
    });

    it("still names the template's picture for a scene without one, and passes a strong enough ratio", () => {
      const [template] = layoutDiagnostics(scene, measure({ picture: [line(2.1)] }));
      expect(template?.message).toContain("template's picture");
      expect(layoutDiagnostics(backed, measure({ picture: [line(4.6)] }))).toEqual([]);
    });
  });
});
