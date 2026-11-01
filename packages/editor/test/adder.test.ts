import { type Block, createSession, loadDoc, type NewScene, type Scene, type Session } from "@depthcue/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type Adder, createAdder, slotFor } from "../src/adder.ts";
import { FakeServer } from "./helpers.ts";

const text = (id: string): Block => ({ id, type: "text", role: "body", text: id });

const hollow: NewScene = {
  id: "hollow",
  title: "Hollow",
  layout: "claim-evidence",
  summary: { id: "hollow-claim", text: "A claim", evidenceIds: [] },
  blocks: [text("one")],
};
const words: NewScene = { id: "words", title: "Words", layout: "text-media", blocks: [text("only")] };
const bare: NewScene = { id: "bare", title: "Bare", layout: "claim-evidence", blocks: [text("lone")] };

let session: Session;
let adder: Adder;
let scene: string;
let chosen: string | undefined;
let problems: Array<string | undefined>;
let added: string[];
let uploads: File[];
let uploadFails: string | undefined;

function start(assets: string[] = []) {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: [...server.assets, ...assets] });
  if (!doc) throw new Error("the demo should load");
  session = createSession(doc);
  const result = session.apply(
    [hollow, words, bare].map((entry) => ({ op: "scene.add" as const, scene: entry })),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  scene = "hollow";
  chosen = undefined;
  problems = [];
  added = [];
  uploads = [];
  uploadFails = undefined;
  adder = createAdder(session, {
    scene: () => scene,
    block: () => chosen,
    act: (ops) => session.apply(ops),
    problem: (message) => problems.push(message),
    upload: async (file) => {
      uploads.push(file);
      if (uploadFails) throw new Error(uploadFails);
      return "assets/method.svg";
    },
    added: (id) => added.push(id),
  });
}

beforeEach(() => start());

/** An adder whose document refuses every change, which a valid add never meets but a changed deck might. */
const refusing = () =>
  createAdder(session, {
    scene: () => scene,
    block: () => chosen,
    act: () => ({
      ok: false,
      code: "invalid-deck",
      rev: "x",
      diagnostics: [
        {
          severity: "error",
          code: "x",
          file: "scenes/hollow.json",
          path: "/blocks",
          message: "Too many blocks.",
          fix: "Take one out.",
        },
      ],
    }),
    problem: (message) => problems.push(message),
    upload: async () => "assets/method.svg",
    added: (id) => added.push(id),
  });

const blocks = (id: string) => session.doc.scenes[id]?.blocks.map((block) => block.id);
const cited = (id: string) => session.doc.scenes[id]?.summary?.evidenceIds;

describe("adding to an area of the slide", () => {
  it("adds text to Evidence and cites it, as one undo step", async () => {
    await adder.add("evidence", "text");
    expect(blocks("hollow")).toEqual(["one", "hollow-text"]);
    expect(cited("hollow")).toEqual(["hollow-text"]);
    expect(added).toEqual(["hollow-text"]);
    session.undo();
    expect(blocks("hollow")).toEqual(["one"]);
    expect(cited("hollow")).toEqual([]);
  });

  it("adds a chart to the media area a text-only slide does not draw yet", async () => {
    scene = "words";
    await adder.add("media", "chart");
    expect(blocks("words")).toEqual(["only", "words-chart"]);
    expect(session.doc.scenes.words?.blocks[1]).toMatchObject({ type: "chart", kind: "bar" });
    expect(added).toEqual(["words-chart"]);
  });

  it("uploads the picture first and adds an image that points at it", async () => {
    scene = "words";
    const file = new File(["x"], "method.svg", { type: "image/svg+xml" });
    await adder.add("media", "image", file);
    expect(uploads).toEqual([file]);
    const block = session.doc.scenes.words?.blocks[1];
    expect(block).toMatchObject({ type: "image", asset: "assets/method.svg" });
  });

  it("adds nothing for an image that has no file", async () => {
    scene = "words";
    await adder.add("media", "image");
    expect(blocks("words")).toEqual(["only"]);
    expect(uploads).toEqual([]);
  });

  it("says why an upload failed and adds nothing", async () => {
    scene = "words";
    uploadFails = "The file is too large.";
    await adder.add("media", "image", new File(["x"], "big.png", { type: "image/png" }));
    expect(blocks("words")).toEqual(["only"]);
    expect(problems.at(-1)).toBe("The file is too large.");
    expect(added).toEqual([]);
  });

  it("clears an old message when it starts, and again when it is done", async () => {
    await adder.add("evidence", "text");
    expect(problems).toEqual([undefined, undefined]);
  });

  it("says why the document refused it after all, and chooses nothing", async () => {
    await refusing().add("evidence", "text");
    expect(problems.at(-1)).toBe("Too many blocks. Take one out.");
    expect(added).toEqual([]);
  });

  it("gives a refusal in words and changes nothing", async () => {
    scene = "bare";
    await adder.add("evidence", "text");
    expect(blocks("bare")).toEqual(["lone"]);
    expect(problems.at(-1)).toBe("Evidence belongs to a claim. Add a claim first.");
    expect(added).toEqual([]);
  });

  it("reads the scene again after the upload, in case the deck changed on the way", async () => {
    scene = "words";
    const adding = adder.add("media", "image", new File(["x"], "m.svg", { type: "image/svg+xml" }));
    session.apply([{ op: "block.add", scene: "words", block: text("meanwhile") }]);
    await adding;
    expect(blocks("words")).toEqual(["only", "meanwhile", "words-image"]);
  });

  it("does nothing when the scene is gone", async () => {
    scene = "nowhere";
    await adder.add("evidence", "text");
    expect(added).toEqual([]);
  });
});

describe("adding where nobody named an area", () => {
  it("goes to the first empty area, and Evidence cites it", async () => {
    // The claim cites nothing, so Evidence is empty and Support holds the block that is there.
    await adder.quick("text");
    expect(blocks("hollow")).toEqual(["one", "hollow-text"]);
    expect(cited("hollow")).toEqual(["hollow-text"]);
    expect(added).toEqual(["hollow-text"]);
  });

  it("goes into the area of the chosen block, right after it", async () => {
    chosen = "one";
    await adder.quick("text");
    expect(blocks("hollow")).toEqual(["one", "hollow-text"]);
    expect(cited("hollow")).toEqual([]);
    session.undo();
    expect(blocks("hollow")).toEqual(["one"]);
  });

  it("puts a chart in the media area whatever is chosen", async () => {
    scene = "words";
    chosen = "only";
    await adder.quick("chart");
    expect(blocks("words")).toEqual(["only", "words-chart"]);
    await adder.quick("text");
    expect(blocks("words")).toEqual(["only", "words-text", "words-chart"]);
  });

  it("leaves Evidence out until the slide has a claim", async () => {
    scene = "bare";
    await adder.quick("text");
    expect(blocks("bare")).toEqual(["lone", "bare-text"]);
    expect(problems.at(-1)).toBeUndefined();
  });

  it("uploads a picture and adds it to the media area", async () => {
    scene = "words";
    const file = new File(["x"], "method.svg", { type: "image/svg+xml" });
    await adder.quick("image", file);
    expect(uploads).toEqual([file]);
    expect(session.doc.scenes.words?.blocks[1]).toMatchObject({ type: "image", asset: "assets/method.svg" });
  });

  it("adds nothing for an image that has no file, and says why an upload failed", async () => {
    scene = "words";
    await adder.quick("image");
    expect(blocks("words")).toEqual(["only"]);
    uploadFails = "The file is too large.";
    await adder.quick("image", new File(["x"], "big.png", { type: "image/png" }));
    expect(blocks("words")).toEqual(["only"]);
    expect(problems.at(-1)).toBe("The file is too large.");
  });

  it("says why the document refused it after all, and chooses nothing", async () => {
    await refusing().quick("text");
    expect(problems.at(-1)).toBe("Too many blocks. Take one out.");
    expect(added).toEqual([]);
  });

  it("adds the first video to the media area", async () => {
    start(["assets/b-talk.mp4", "assets/a-talk.webm"]);
    scene = "words";
    await adder.quick("clip");
    expect(session.doc.scenes.words?.blocks[1]).toMatchObject({ type: "clip", source: "assets/a-talk.webm" });
  });

  it("does nothing when the scene is gone", async () => {
    scene = "nowhere";
    await adder.quick("text");
    expect(added).toEqual([]);
  });
});

describe("the area a new block goes to when none is named", () => {
  const picture = (id: string): Block => ({ id, type: "image", asset: "assets/a.png", alt: "A" });
  const chart = (id: string): Block => ({ id, type: "bar-chart", data: [{ label: "A", value: 1 }] });
  const slide = (layout: Scene["layout"], blocks: Block[], evidenceIds?: string[]): Scene =>
    ({
      schemaVersion: "0.2",
      id: "s",
      title: "S",
      layout,
      blocks,
      ...(evidenceIds ? { summary: { id: "claim", text: "A claim", evidenceIds } } : {}),
    }) as Scene;

  it("is the one area of a title slide, for every kind", () => {
    const title = slide("title", [text("a")]);
    for (const kind of ["text", "image", "bar-chart", "clip"] as const) {
      expect(slotFor(title, kind)).toBe("stack");
    }
  });

  it("sends a text one way and a picture, chart or clip the other on a slide of text and media", () => {
    const both = slide("text-media", [text("a"), picture("p")]);
    expect(slotFor(both, "text")).toBe("text");
    expect(slotFor(both, "image")).toBe("media");
    expect(slotFor(both, "bar-chart", "a")).toBe("media");
    expect(slotFor(both, "clip", "a")).toBe("media");
  });

  it("is the area of the chosen block when that area takes the kind", () => {
    const claim = slide("claim-evidence", [chart("c"), text("t")], ["c"]);
    expect(slotFor(claim, "text", "c")).toBe("evidence");
    expect(slotFor(claim, "text", "t")).toBe("support");
  });

  it("falls back to the first empty area when the chosen block's area does not take the kind", () => {
    // The media area holds nothing, and the chosen text's own area cannot hold a chart.
    expect(slotFor(slide("text-media", [text("a")]), "bar-chart", "a")).toBe("media");
  });

  it("falls back to the first area that takes the kind when none is empty", () => {
    // The chosen picture is in the media area, which cannot hold a text.
    expect(slotFor(slide("text-media", [text("a"), picture("p")]), "text", "p")).toBe("text");
  });

  it("is the first empty area that takes the kind when nothing is chosen", () => {
    expect(slotFor(slide("claim-evidence", [chart("c")], ["c"]), "text")).toBe("support");
    expect(slotFor(slide("claim-evidence", [chart("c")], []), "text")).toBe("evidence");
  });

  it("leaves out Evidence until the slide has a claim, and never offers the claim itself", () => {
    const noClaim = slide("claim-evidence", [text("t")]);
    expect(slotFor(noClaim, "text")).toBe("support");
    expect(slotFor(noClaim, "bar-chart")).toBe("support");
  });

  it("is the first area that takes the kind when none is empty and none is chosen", () => {
    const full = slide("claim-evidence", [chart("c"), text("t")], ["c"]);
    expect(slotFor(full, "bar-chart")).toBe("evidence");
    expect(slotFor(slide("text-media", [text("a"), picture("p")]), "image")).toBe("media");
  });

  it("ignores a chosen block that is not on the slide", () => {
    expect(slotFor(slide("text-media", [text("a")]), "text", "gone")).toBe("text");
  });
});

describe("clips", () => {
  it("says whether the deck has a video", () => {
    expect(adder.hasVideo()).toBe(false);
    start(["assets/b-talk.mp4", "assets/a-talk.webm"]);
    expect(adder.hasVideo()).toBe(true);
  });

  it("adds the first video by name, and nothing when there is none", async () => {
    scene = "words";
    await adder.add("media", "clip");
    expect(blocks("words")).toEqual(["only"]);
    start(["assets/b-talk.mp4", "assets/a-talk.webm"]);
    scene = "words";
    await adder.add("media", "clip");
    expect(session.doc.scenes.words?.blocks[1]).toMatchObject({ type: "clip", source: "assets/a-talk.webm" });
  });
});

describe("the claim", () => {
  it("gives a slide without one a claim that cites nothing", () => {
    scene = "bare";
    adder.claim();
    expect(session.doc.scenes.bare?.summary).toEqual({
      id: "bare-claim",
      text: "State the claim here.",
      evidenceIds: [],
    });
  });

  it("leaves the claim a slide already has", () => {
    adder.claim();
    expect(session.doc.scenes.hollow?.summary?.text).toBe("A claim");
  });

  it("says why the document refused a claim after all", () => {
    scene = "bare";
    refusing().claim();
    expect(problems.at(-1)).toBe("Too many blocks. Take one out.");
  });
});
