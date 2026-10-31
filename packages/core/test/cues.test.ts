import { describe, expect, it } from "vitest";
import { CUE_MAP_FORMAT, cueMapPath, MAX_CUES, makeCue, readCueMap, tidyCues } from "../src/cues.ts";

const valid = {
  format: CUE_MAP_FORMAT,
  source: "assets/intro.mp4",
  duration: 4.2,
  width: 960,
  height: 540,
  fps: 30,
  cues: [
    { id: "dot", type: "circle", in: 0, out: 1.1 },
    { id: "title", type: "text", in: 1, out: 4.2 },
  ],
  build: { key: "abc", kinescript: "kinescript 1.2.0", quality: "draft", scale: 0.5, scene: "intro.json" },
};

describe("makeCue", () => {
  it("makes a cue from usable parts", () => {
    expect(makeCue("title", "text", 1, 4.2)).toEqual({ id: "title", type: "text", in: 1, out: 4.2 });
    expect(makeCue("x", "text", 2, 2)).toEqual({ id: "x", type: "text", in: 2, out: 2 });
    expect(makeCue("x".repeat(64), "text", 0, 1)?.id).toHaveLength(64);
  });

  it("refuses parts that cannot be a place in a clip", () => {
    const bad: unknown[][] = [
      [7, "t", 0, 1],
      ["", "t", 0, 1],
      ["x".repeat(65), "t", 0, 1],
      ["x", "t", "0", 1],
      ["x", "t", 0, null],
      ["x", "t", -0.1, 1],
      ["x", "t", 2, 1],
      ["x", "t", Number.NaN, 1],
      ["x", "t", 0, Number.POSITIVE_INFINITY],
    ];
    for (const parts of bad)
      expect(makeCue(...(parts as [unknown, unknown, unknown, unknown])), String(parts)).toBeUndefined();
  });

  it("defaults the type and cuts a long one down", () => {
    expect(makeCue("x", undefined, 0, 1)?.type).toBe("layer");
    expect(makeCue("x", "t".repeat(40), 0, 1)?.type).toHaveLength(32);
  });
});

describe("tidyCues", () => {
  const cue = (id: string, start: number) => ({ id, type: "layer", in: start, out: start + 1 });

  it("puts cues in time order and keeps the first of a repeated id", () => {
    expect(tidyCues([cue("b", 2), cue("a", 1), cue("b", 0)]).map((c) => `${c.id}@${c.in}`)).toEqual([
      "a@1",
      "b@2",
    ]);
  });

  it(`keeps at most ${MAX_CUES}, the earliest`, () => {
    const many = Array.from({ length: 100 }, (_, i) => cue(`c-${i}`, 100 - i));
    const kept = tidyCues(many);
    expect(kept).toHaveLength(MAX_CUES);
    expect(kept[0]?.id).toBe("c-99");
    expect(kept.at(-1)?.in).toBe(MAX_CUES);
  });

  it("does not change what it was given", () => {
    const input = [cue("b", 2), cue("a", 1)];
    tidyCues(input);
    expect(input.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("cueMapPath", () => {
  it("swaps the video's extension for .cues.json", () => {
    expect(cueMapPath("assets/intro.mp4")).toBe("assets/intro.cues.json");
    expect(cueMapPath("assets/clips/a.b.webm")).toBe("assets/clips/a.b.cues.json");
  });

  it("appends when there is no extension to swap", () => {
    expect(cueMapPath("assets/intro")).toBe("assets/intro.cues.json");
    expect(cueMapPath("assets/.hidden")).toBe("assets/.hidden.cues.json");
    expect(cueMapPath("assets/v1.2/intro")).toBe("assets/v1.2/intro.cues.json");
  });
});

describe("readCueMap", () => {
  it("reads a map as it is written", () => {
    expect(readCueMap(valid)).toEqual(valid);
  });

  it("does not need the build record", () => {
    const { build: _build, ...bare } = valid;
    expect(readCueMap(bare)?.build).toBeUndefined();
  });

  it("fills what is missing from a build record that has a key", () => {
    expect(readCueMap({ ...valid, build: { key: "k" } })?.build).toEqual({
      key: "k",
      kinescript: "",
      quality: "",
      scale: 1,
      scene: "",
    });
    expect(readCueMap({ ...valid, build: { key: 3 } })?.build).toBeUndefined();
  });

  it("refuses what is not a cue map", () => {
    const refused: unknown[] = [
      null,
      "text",
      [],
      {},
      { ...valid, format: "depthcue-cues/2" },
      { ...valid, source: 1 },
      { ...valid, duration: 0 },
      { ...valid, duration: "4" },
      { ...valid, width: 0 },
      { ...valid, height: -1 },
      { ...valid, fps: 0 },
      { ...valid, fps: Number.NaN },
    ];
    for (const value of refused) expect(readCueMap(value), JSON.stringify(value)).toBeUndefined();
  });

  it("skips the cues it cannot use and sorts the rest", () => {
    const map = readCueMap({
      ...valid,
      cues: [
        null,
        "x",
        { id: "late", in: 3, out: 4 },
        { id: "bad", in: 3, out: 1 },
        { id: "early", in: 1, out: 2 },
      ],
    });
    expect(map?.cues).toEqual([
      { id: "early", type: "layer", in: 1, out: 2 },
      { id: "late", type: "layer", in: 3, out: 4 },
    ]);
  });

  it("reads a map with no cues, or with cues that are not a list, as having none", () => {
    expect(readCueMap({ ...valid, cues: [] })?.cues).toEqual([]);
    expect(readCueMap({ ...valid, cues: "nope" })?.cues).toEqual([]);
  });
});
