import {
  applyOps,
  type Block,
  type Doc,
  ID_PATTERN,
  LAYOUTS,
  loadDoc,
  revisionOf,
  type Scene,
} from "@depthcue/core";
import { describe, expect, it } from "vitest";
import {
  BLOCK_KINDS,
  describeBlock,
  IMAGE_FILE,
  idsInScene,
  newBlock,
  newScene,
  uniqueId,
  VIDEO_FILE,
} from "../src/templates.ts";
import { FakeServer } from "./helpers.ts";

function demo(): Doc {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo should load");
  return doc;
}

const scene = (doc: Doc, id: string) => doc.scenes[id] as Scene;
const idPattern = new RegExp(ID_PATTERN);

describe("uniqueId", () => {
  it("turns any text into an id the schema accepts", () => {
    expect(uniqueId("New Scene", new Set())).toBe("new-scene");
    expect(uniqueId("  Q3 -- Results!! ", new Set())).toBe("q3-results");
    expect(uniqueId("9 lives", new Set())).toBe("x9-lives");
    expect(uniqueId("", new Set())).toBe("xx");
    expect(uniqueId("a", new Set())).toBe("ax");
    for (const text of ["Ünïcode title", "---", "UPPER", "a".repeat(200), "9", "x y z"]) {
      expect(uniqueId(text, new Set())).toMatch(idPattern);
    }
  });

  it("keeps ids within the 64 character limit, suffix included", () => {
    const base = uniqueId("a".repeat(200), new Set());
    expect(base.length).toBeLessThanOrEqual(64);
    const taken = new Set([base]);
    const next = uniqueId("a".repeat(200), taken);
    expect(next).toMatch(idPattern);
    expect(taken.has(next)).toBe(false);
  });

  it("numbers a clash from 2, and skips the numbers already used", () => {
    expect(uniqueId("claim", new Set(["claim"]))).toBe("claim-2");
    expect(uniqueId("claim", new Set(["claim", "claim-2", "claim-3"]))).toBe("claim-4");
    expect(uniqueId("claim", new Set(["claim-2"]))).toBe("claim");
  });
});

describe("idsInScene", () => {
  it("collects the claim, blocks, sources and steps, because the schema wants them unique together", () => {
    expect([...idsInScene(scene(demo(), "demand"))].sort()).toEqual(
      ["chart-demand", "claim-shift", "show-claim", "show-evidence", "source-report"].sort(),
    );
  });

  it("is just the blocks for a plain scene", () => {
    expect([...idsInScene(scene(demo(), "opening"))].sort()).toEqual(["opening-sub", "opening-title"]);
  });
});

describe("newScene", () => {
  it.each(LAYOUTS)("makes a scene that applies cleanly for the %s layout", (layout) => {
    const doc = demo();
    const result = applyOps(
      doc,
      [{ op: "scene.add", scene: newScene(doc, layout), after: "opening" }],
      revisionOf(doc),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("gives a claim-evidence scene a claim that cites its block", () => {
    const made = newScene(demo(), "claim-evidence");
    expect(made.summary?.evidenceIds).toEqual([made.blocks[0]?.id]);
  });

  it("never reuses a scene id, however many are added", () => {
    let doc = demo();
    const ids = new Set(doc.deck.scenes);
    for (let i = 0; i < 4; i += 1) {
      const next = newScene(doc, "title");
      expect(ids.has(next.id)).toBe(false);
      ids.add(next.id);
      const result = applyOps(doc, [{ op: "scene.add", scene: next }], revisionOf(doc));
      if (!result.ok) throw new Error(result.diagnostics[0]?.message);
      doc = result.doc;
    }
    expect(doc.deck.scenes).toHaveLength(7);
  });
});

describe("newBlock", () => {
  const base = demo();

  it.each(BLOCK_KINDS)("makes a $kind block the scene accepts", ({ kind }) => {
    const asset = kind === "clip" ? "assets/talk.mp4" : "assets/method.svg";
    const doc = { ...base, assets: new Set([...base.assets, "assets/talk.mp4"]) };
    const block = newBlock(scene(doc, "method"), kind, asset);
    expect(block.type).toBe(kind);
    const result = applyOps(doc, [{ op: "block.add", scene: "method", block, after: null }], revisionOf(doc));
    expect(result.ok).toBe(true);
  });

  it("picks an id that is free across the whole scene, including its claim and steps", () => {
    const demand = scene(base, "demand");
    const ids = idsInScene(demand);
    const first = newBlock(demand, "bar-chart");
    expect(ids.has(first.id)).toBe(false);
    const crowded = { ...demand, blocks: [...demand.blocks, first] } as Scene;
    const second = newBlock(crowded, "bar-chart");
    expect(second.id).not.toBe(first.id);
    expect(idsInScene(crowded).has(second.id)).toBe(false);
  });

  it("starts a chart with two rows and a text block with words to replace", () => {
    const method = scene(base, "method");
    const chart = newBlock(method, "bar-chart");
    expect(chart.type === "bar-chart" && chart.data).toHaveLength(2);
    const text = newBlock(method, "text");
    expect(text.type === "text" && text.role).toBe("body");
    expect(text.type === "text" && text.text.length).toBeGreaterThan(0);
  });

  it("takes the alt text of an image or clip from the file name", () => {
    const method = scene(base, "method");
    const image = newBlock(method, "image", "assets/q3_sales-chart.png");
    expect(image.type === "image" && image.alt).toBe("q3 sales chart");
    const clip = newBlock(method, "clip", "assets/intro.mp4");
    expect(clip.type === "clip" && clip.alt).toBe("intro");
  });
});

describe("file kinds", () => {
  it("tells images from video by extension, case-insensitively", () => {
    for (const name of [
      "assets/a.png",
      "assets/a.JPG",
      "assets/a.jpeg",
      "assets/a.gif",
      "assets/a.webp",
      "assets/a.svg",
      "assets/a.avif",
    ]) {
      expect(IMAGE_FILE.test(name)).toBe(true);
      expect(VIDEO_FILE.test(name)).toBe(false);
    }
    for (const name of ["assets/a.mp4", "assets/a.WEBM"]) {
      expect(VIDEO_FILE.test(name)).toBe(true);
      expect(IMAGE_FILE.test(name)).toBe(false);
    }
    expect(IMAGE_FILE.test("assets/report.csv")).toBe(false);
    expect(VIDEO_FILE.test("assets/report.csv")).toBe(false);
  });
});

describe("describeBlock", () => {
  const blocks = Object.fromEntries(
    demo().scenes.method?.blocks.map((block) => [block.id, block]) ?? [],
  ) as Record<string, Block>;
  const chart = scene(demo(), "demand").blocks[0] as Block;

  it("names the role of a text block and shows how it starts", () => {
    expect(describeBlock(blocks["method-heading"] as Block)).toBe(
      "Heading: Same period, same orders, one count",
    );
    expect(describeBlock(blocks["method-body"] as Block)).toMatch(/^Body: Each order is counted once/);
  });

  it("cuts a long label at the limit with an ellipsis, and keeps a short one whole", () => {
    const long = describeBlock(blocks["method-body"] as Block, 20);
    // The limit counts the label, not the "Body: " in front of it: 19 characters and the ellipsis.
    expect(long).toBe("Body: Each order is count…");
    expect(describeBlock(blocks["method-heading"] as Block, 200)).not.toContain("…");
  });

  it("uses the alt text of an image and the title of a chart", () => {
    expect(describeBlock(blocks["method-diagram"] as Block)).toMatch(/^Image: Diagram: orders from/);
    expect(describeBlock(chart)).toBe("Chart: Share of orders, latest quarter");
  });

  it("falls back to a plain name for an untitled chart", () => {
    const untitled = Object.assign({}, chart, { title: undefined }) as Block;
    expect(describeBlock(untitled)).toBe("Chart: Bar chart");
  });
});
