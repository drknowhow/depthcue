import type { Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  type LayoutMeasure,
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
});
