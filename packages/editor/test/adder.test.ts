import { type Block, createSession, loadDoc, type NewScene, type Session } from "@depthcue/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type Adder, createAdder } from "../src/adder.ts";
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
  problems = [];
  added = [];
  uploads = [];
  uploadFails = undefined;
  adder = createAdder(session, {
    scene: () => scene,
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
    await adder.add("media", "bar-chart");
    expect(blocks("words")).toEqual(["only", "words-chart"]);
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
