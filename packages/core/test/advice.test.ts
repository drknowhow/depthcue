import { describe, expect, it } from "vitest";
import {
  adviceOf,
  checkContent,
  checkDeckFiles,
  checkDoc,
  checkFrames,
  type Doc,
  hasPlaceholderAlt,
  placeholderAlt,
  type Scene,
} from "../src/index.ts";
import { demoDoc, scene } from "./helpers.ts";

const asScene = (overrides: Record<string, unknown>) => scene(overrides) as unknown as Scene;

const picture = (alt: string) => ({ id: "a-image", type: "image", asset: "assets/q3_sales-chart.png", alt });
const chart = (extra: Record<string, unknown> = {}) => ({
  id: "a-chart",
  type: "bar-chart",
  data: [{ label: "A", value: 1 }],
  ...extra,
});

describe("alt text that is the name of its file", () => {
  it("makes the words of the file name, without the hash an upload gets", () => {
    expect(placeholderAlt("assets/q3_sales-chart.png")).toBe("q3 sales chart");
    expect(placeholderAlt("assets/q3_sales-chart-1a2b3c4d.png")).toBe("q3 sales chart");
    expect(placeholderAlt("assets/__.png")).toBe("untitled");
  });

  it("flags an image or a clip that still says it, and nothing that says more", () => {
    const [flagged, described, clip] = asScene({
      blocks: [
        picture("q3 sales chart"),
        picture("Sales rose in the third quarter"),
        { id: "a-clip", type: "clip", source: "assets/intro.mp4", alt: "intro" },
      ],
    }).blocks;
    expect(hasPlaceholderAlt(flagged as never)).toBe(true);
    expect(hasPlaceholderAlt(described as never)).toBe(false);
    expect(hasPlaceholderAlt(clip as never)).toBe(true);
  });

  it("is a warning on the alt text, in the order of the blocks, that says what to do", () => {
    const found = checkContent(asScene({ blocks: [picture("q3 sales chart")] }), "scenes/a.json");
    expect(found).toEqual([
      {
        severity: "warning",
        code: "alt-is-filename",
        file: "scenes/a.json",
        path: "/blocks/0/alt",
        message: 'The alt text "q3 sales chart" is the name of the file, so it does not describe the image.',
        fix: "Write what the picture shows, for someone who cannot see it.",
      },
    ]);
  });
});

describe("a chart that cites nothing", () => {
  it("is flagged when it has no sourceIds, and when the list is empty", () => {
    for (const block of [chart(), chart({ sourceIds: [] })]) {
      const found = checkContent(asScene({ blocks: [block] }), "scenes/a.json");
      expect(found).toMatchObject([{ severity: "warning", code: "missing-source", path: "/blocks/0" }]);
      expect(found[0]?.message).toContain('"a-chart"');
      expect(found[0]?.fix).toContain("sourceIds");
    }
  });

  it("is not flagged when it cites a source, and no other block is held to it", () => {
    const sources = [{ id: "src-a", title: "Report" }];
    expect(
      checkContent(asScene({ sources, blocks: [chart({ sourceIds: ["src-a"] })] }), "scenes/a.json"),
    ).toEqual([]);
    const others = [
      { id: "a-text", type: "text", role: "body", text: "Words" },
      { id: "a-clip", type: "clip", source: "assets/a.mp4", alt: "A talk about sales" },
    ];
    expect(checkContent(asScene({ blocks: others }), "scenes/a.json")).toEqual([]);
  });
});

describe("one rule set", () => {
  const files = (sceneJson: unknown) => ({
    text: {
      "deck.json": JSON.stringify({
        schemaVersion: "0.1",
        id: "a-deck",
        title: "Deck",
        language: "en",
        theme: "paper",
        scenes: ["demo-scene"],
      }),
      "scenes/demo-scene.json": JSON.stringify(sceneJson),
    },
    assets: ["assets/q3_sales-chart.png"],
  });

  it("gives `depthcue check` the same warnings, and no error", () => {
    const blocks = [picture("q3 sales chart"), chart()];
    const checked = checkDeckFiles(files(scene({ blocks })));
    expect(checked.filter((d) => d.severity === "error")).toEqual([]);
    expect(checked.map((d) => d.code)).toEqual(["alt-is-filename", "missing-source"]);
    expect(checked).toEqual(checkContent(asScene({ blocks }), "scenes/demo-scene.json"));
  });

  it("is what adviceOf returns from the document, with the frame warnings beside them", () => {
    const blocks = [
      picture("q3 sales chart"),
      { id: "a-note", type: "text", role: "body", text: "Words", frame: { x: 1, y: 10, w: 30, h: 10 } },
    ];
    const current = asScene({ schemaVersion: "0.2", blocks });
    const advice = adviceOf(current, "scenes/demo-scene.json");
    expect(advice.map((d) => d.code)).toEqual(["frame-outside-safe-area", "alt-is-filename"]);
    expect(advice.every((d) => d.severity === "warning")).toBe(true);
  });

  it("leaves errors out, since the editor stops those at the door and `depthcue check` fails on them", () => {
    const blocks = [
      picture("q3 sales chart"),
      { id: "a-note", type: "text", role: "body", text: "Words", frame: { x: 90, y: 10, w: 30, h: 10 } },
    ];
    const current = asScene({ schemaVersion: "0.2", blocks });
    expect(checkFrames(current, "scenes/demo-scene.json").map((d) => d.code)).toContain("frame-off-slide");
    expect(adviceOf(current, "scenes/demo-scene.json").map((d) => d.code)).toEqual(["alt-is-filename"]);
  });

  it("finds nothing to say about the demo deck", () => {
    const doc: Doc = demoDoc();
    expect(checkDoc(doc).filter((d) => d.severity === "warning")).toEqual([]);
    for (const [id, current] of Object.entries(doc.scenes)) {
      expect(adviceOf(current, `scenes/${id}.json`)).toEqual([]);
    }
  });
});
