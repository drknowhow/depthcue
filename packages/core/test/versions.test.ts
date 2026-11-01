import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ApplyResult,
  type ApplySuccess,
  acceptChanges,
  applyOps,
  type Block,
  checkDeckFiles,
  checkManifest,
  checkScene,
  checkSceneVersion,
  type Doc,
  diffDocs,
  docToFiles,
  loadDoc,
  recordAgentEdit,
  revertChanges,
  reviewChanges,
  revisionOf,
  type Scene,
  shownText,
  startReview,
  TEXT_LIMITS,
  upgradeScene,
} from "../src/index.ts";
import { checkScenePart } from "../src/validate.ts";
import { demoDoc, loadDir, scene } from "./helpers.ts";

const v02Dir = fileURLToPath(new URL("../../../fixtures/decks/v0-2", import.meta.url));
const v03Dir = fileURLToPath(new URL("../../../fixtures/decks/v0-3", import.meta.url));

function load(dir: string): Doc {
  const { doc, diagnostics } = loadDoc(loadDir(dir));
  if (!doc) throw new Error(`the deck should load: ${JSON.stringify(diagnostics)}`);
  return doc;
}

const run = (doc: Doc, ops: unknown): ApplyResult => applyOps(doc, ops, revisionOf(doc));

function success(result: ApplyResult): ApplySuccess {
  if (!result.ok)
    throw new Error(`expected success, got ${result.code}: ${JSON.stringify(result.diagnostics)}`);
  return result;
}

const textOf = (doc: Doc, sceneId: string, id: string): string => {
  const block = doc.scenes[sceneId]?.blocks.find((each) => each.id === id);
  if (block?.type !== "text") throw new Error(`no text block ${id}`);
  return block.text;
};

/** What the audience sees of every text block in a scene. */
const shown = (scene: Scene): string[] =>
  scene.blocks.flatMap((block) => (block.type === "text" ? [shownText(scene, block)] : []));

describe("files written for 0.1 and 0.2", () => {
  it("load as they are and keep their versions", () => {
    expect(checkDeckFiles(loadDir(v02Dir))).toEqual([]);
    const doc = load(v02Dir);
    expect(doc.deck.schemaVersion).toBe("0.2");
    expect(doc.scenes.intro?.schemaVersion).toBe("0.2");
    expect(doc.scenes.share?.schemaVersion).toBe("0.1");
    expect(Object.values(demoDoc().scenes).map((each) => each.schemaVersion)).toEqual(["0.1", "0.1", "0.1"]);
  });

  it("show their text exactly as written: a star, a bracket and a dash are characters", () => {
    const doc = load(v02Dir);
    const intro = doc.scenes.intro as Scene;
    for (const block of intro.blocks)
      if (block.type === "text") expect(shownText(intro, block)).toBe(block.text);
  });

  it("are not rewritten by an edit that adds nothing of 0.3", () => {
    const doc = load(v02Dir);
    const result = success(
      run(doc, [
        { op: "deck.set", set: { title: "Retitled" } },
        { op: "block.set", scene: "intro", id: "intro-title", set: { text: "New *title*" } },
      ]),
    );
    expect(result.doc.deck.schemaVersion).toBe("0.2");
    expect(result.doc.scenes.intro?.schemaVersion).toBe("0.2");
    expect(result.doc.scenes.share).toBe(doc.scenes.share);
    expect(result.changed).toEqual(["intro"]);
    expect(docToFiles(result.doc)["scenes/share.json"]).toBe(docToFiles(doc)["scenes/share.json"]);
  });

  it("warn when an edit writes markup into one, since it shows as written", () => {
    const doc = load(v02Dir);
    const result = success(
      run(doc, [{ op: "block.set", scene: "intro", id: "intro-title", set: { text: "A **bold** claim" } }]),
    );
    const [warning] = result.diagnostics;
    expect(warning).toMatchObject({
      severity: "warning",
      code: "text-is-literal",
      file: "scenes/intro.json",
      path: "/blocks/0/text",
    });
    expect(warning?.fix).toContain('run scene.upgrade on "intro"');
    const plain = success(
      run(doc, [{ op: "block.set", scene: "intro", id: "intro-title", set: { text: "Plain" } }]),
    );
    expect(plain.diagnostics).toEqual([]);
  });
});

describe("upgrading a scene to 0.3", () => {
  it("escapes its text, so the audience sees the same words", () => {
    const intro = load(v02Dir).scenes.intro as Scene;
    const upgraded = upgradeScene(intro);
    expect(upgraded.schemaVersion).toBe("0.3");
    expect(shown(upgraded)).toEqual(shown(intro));
    expect((upgraded.blocks[0] as Block & { text: string }).text).toBe("Q3 \\*draft\\* numbers, 5 * 3 = 15");
    expect((upgraded.blocks[1] as Block & { text: string }).text).toBe(
      // A `[` without a `]` to close it is a character, so only the `]` needs the backslash.
      "Two things changed:\n\\- returns now count\n1\\. as orders, see [the note\\](https://example.com)",
    );
    expect(checkScene(upgraded, "scenes/intro.json")).toEqual([]);
  });

  it("leaves text that already reads the same as it was, and a 0.3 scene as the same object", () => {
    const opening = demoDoc().scenes.opening as Scene;
    const upgraded = upgradeScene(opening);
    expect(upgraded.blocks).toEqual(opening.blocks);
    expect(upgradeScene(upgraded)).toBe(upgraded);
  });

  it("happens by scene.upgrade, and only to the scene named", () => {
    const doc = load(v02Dir);
    const result = success(run(doc, [{ op: "scene.upgrade", id: "intro" }]));
    expect(result.doc.scenes.intro?.schemaVersion).toBe("0.3");
    expect(result.doc.scenes.share).toBe(doc.scenes.share);
    expect(result.changed).toEqual(["intro"]);
    const again = success(run(result.doc, [{ op: "scene.upgrade", id: "intro" }]));
    expect(again.changed).toEqual([]);
    expect(run(doc, [{ op: "scene.upgrade", id: "nope" }])).toMatchObject({ ok: false, code: "bad-op" });
  });

  it("happens before a 0.3 part arrives, so the text the same operation writes is markup", () => {
    const doc = load(v02Dir);
    const result = success(
      run(doc, [
        { op: "block.set", scene: "intro", id: "intro-title", set: { tone: "action", text: "Now **bold**" } },
      ]),
    );
    const intro = result.doc.scenes.intro as Scene;
    expect(intro.schemaVersion).toBe("0.3");
    expect(textOf(result.doc, "intro", "intro-title")).toBe("Now **bold**");
    expect(shownText(intro, intro.blocks[0] as Extract<Block, { type: "text" }>)).toBe("Now bold");
    // The block the operation did not write was escaped on the way.
    expect(textOf(result.doc, "intro", "intro-body")).toContain("\\- returns now count");
    expect(result.diagnostics).toEqual([]);
  });

  it("happens when a table or chart is added to an older scene", () => {
    const doc = load(v02Dir);
    const table = { id: "share-table", type: "table", columns: [{ label: "Channel" }], rows: [["A"]] };
    const result = success(run(doc, [{ op: "block.add", scene: "share", block: table }]));
    expect(result.doc.scenes.share?.schemaVersion).toBe("0.3");
    expect(textOf(result.doc, "share", "share-note")).toBe("\\*\\*Preliminary\\*\\*, not audited");
  });

  it("happens to each scene on its own, so one transaction may upgrade one scene and leave another", () => {
    const doc = load(v02Dir);
    const result = success(
      run(doc, [
        { op: "block.set", scene: "intro", id: "intro-title", set: { tone: "muted" } },
        { op: "scene.set", id: "share", set: { title: "Share of all orders" } },
      ]),
    );
    expect(result.changed).toEqual(["intro", "share"]);
    expect(result.doc.scenes.intro?.schemaVersion).toBe("0.3");
    expect(result.doc.scenes.share?.schemaVersion).toBe("0.1");
    expect(textOf(result.doc, "share", "share-note")).toBe("**Preliminary**, not audited");
  });

  it("happens to a scene added at an older version with a 0.3 part", () => {
    const doc = load(v02Dir);
    const added = {
      schemaVersion: "0.1",
      id: "added",
      title: "Added",
      layout: "title",
      blocks: [{ id: "added-text", type: "text", role: "body", text: "a *b*", size: "l" }],
    };
    const result = success(run(doc, [{ op: "scene.add", scene: added }]));
    expect(result.doc.scenes.added?.schemaVersion).toBe("0.3");
    expect(textOf(result.doc, "added", "added-text")).toBe("a \\*b\\*");
  });

  it("happens to deck.json when it gains a palette or fonts, and not otherwise", () => {
    const doc = load(v02Dir);
    expect(success(run(doc, [{ op: "deck.set", set: { fonts: "modern" } }])).doc.deck.schemaVersion).toBe(
      "0.3",
    );
    const palette = success(run(doc, [{ op: "deck.set", set: { palette: { action: "#FF8040" } } }]));
    expect(palette.doc.deck).toMatchObject({ schemaVersion: "0.3", palette: { action: "#FF8040" } });
    expect(palette.deckChanged).toBe(true);
    expect(success(run(doc, [{ op: "deck.set", set: { language: "de" } }])).doc.deck.schemaVersion).toBe(
      "0.2",
    );
  });
});

describe("markup", () => {
  it("is read only in a text block's text: a table cell and an image caption stay literal", () => {
    const older = scene({
      schemaVersion: "0.2",
      blocks: [
        { id: "a-text", type: "text", role: "body", text: "**x**" },
        { id: "a-image", type: "image", asset: "assets/a.png", alt: "**x**", caption: "**x**" },
      ],
    }) as unknown as Scene;
    const table = {
      id: "a-table",
      type: "table",
      title: "**x**",
      columns: [{ label: "**x**" }],
      rows: [["**x**"]],
    };
    const doc: Doc = {
      deck: { ...load(v02Dir).deck, scenes: ["demo-scene"] },
      scenes: { "demo-scene": older },
      assets: new Set(["assets/a.png"]),
    };
    const result = success(run(doc, [{ op: "block.add", scene: "demo-scene", block: table }]));
    const after = result.doc.scenes["demo-scene"] as Scene;
    expect(after.schemaVersion).toBe("0.3");
    // The text block is escaped to keep its meaning; nothing else is markup, so nothing else changes.
    expect(after.blocks[0]).toMatchObject({ text: "\\*\\*x\\*\\*" });
    expect(after.blocks[1]).toEqual(older.blocks[1]);
    expect(after.blocks[2]).toEqual(table);
    expect(checkScene(after, "scenes/demo-scene.json")).toEqual([]);
  });
});

describe("0.3 parts in a file that says an older version", () => {
  it("are errors named for the part", () => {
    const toned = scene({
      schemaVersion: "0.2",
      blocks: [
        { id: "a-text", type: "text", role: "body", text: "Words", tone: "muted", align: "center" },
        { id: "a-table", type: "table", columns: [{ label: "A" }], rows: [["x"]] },
      ],
    }) as unknown as Scene;
    expect(checkSceneVersion(toned, "scenes/a.json").map((d) => [d.code, d.path])).toEqual([
      ["tone-needs-version", "/blocks/0/tone"],
      ["align-needs-version", "/blocks/0/align"],
      ["table-needs-version", "/blocks/1"],
    ]);
    const part = checkScenePart(toned, "scenes/demo-scene.json", "demo-scene", new Set());
    expect(part.map((d) => d.code)).toContain("table-needs-version");
    const [deck] = checkManifest({
      schemaVersion: "0.1",
      id: "a-deck",
      title: "A deck",
      language: "en",
      theme: "paper",
      fonts: "modern",
      scenes: ["a-scene"],
    });
    expect(deck).toMatchObject({ code: "fonts-needs-version", path: "/fonts" });
    expect(deck?.fix).toContain("rewrites the file as 0.3 and escapes its text");
  });
});

describe("text limits", () => {
  const heading = (text: string, schemaVersion: string) =>
    checkScene(
      scene({ schemaVersion, blocks: [{ id: "a-text", type: "text", role: "heading", text }] }),
      "x.json",
    );

  it("count what the audience sees in 0.3, markup and addresses left out", () => {
    // " link" shows 5 characters, so this shows exactly the limit.
    const words = "w".repeat(TEXT_LIMITS.heading - 5);
    const fits = `**${words}** [link](https://example.com/a/long/address)`;
    expect(fits.length).toBeGreaterThan(TEXT_LIMITS.heading);
    expect(heading(fits, "0.3")).toEqual([]);
    const [over] = heading(`**${words}xx** [link](https://example.com)`, "0.3");
    expect(over).toMatchObject({ code: "too-long", path: "/blocks/0/text" });
    expect(over?.message).toBe(
      `${TEXT_LIMITS.heading + 2} characters as shown; the limit is ${TEXT_LIMITS.heading}.`,
    );
  });

  it("count every character below 0.3, where markup is text", () => {
    const text = `**${"w".repeat(TEXT_LIMITS.heading - 3)}**`;
    expect(heading(text, "0.3")).toEqual([]);
    const [over] = heading(text, "0.2");
    expect(over).toMatchObject({ code: "too-long" });
    expect(over?.message).toBe(`${TEXT_LIMITS.heading + 1} characters; the limit is ${TEXT_LIMITS.heading}.`);
  });

  it("refuse text that shows nothing", () => {
    const found = checkScene(
      scene({ schemaVersion: "0.3", blocks: [{ id: "a-text", type: "text", role: "body", text: "- " }] }),
      "x.json",
    );
    expect(found).toMatchObject([{ code: "too-short", path: "/blocks/0/text" }]);
  });

  it("still cap the stored text, at more than twice what shows", () => {
    const [found] = heading("w".repeat(241), "0.3");
    expect(found).toMatchObject({ code: "too-long", path: "/blocks/0/text" });
  });
});

describe("review across an upgrade", () => {
  const toned: unknown[] = [{ op: "block.set", scene: "intro", id: "intro-title", set: { tone: "action" } }];

  it("shows the change and not the escaping the upgrade did", () => {
    const base = load(v02Dir);
    const current = success(run(base, toned)).doc;
    expect(diffDocs(base, current).map((change) => change.id)).toEqual([
      "scene:intro/block:intro-title/tone",
    ]);
    expect(diffDocs(base, success(run(base, [{ op: "scene.upgrade", id: "intro" }])).doc)).toEqual([]);
  });

  it("marks the agent's change, accepts it into the reviewed deck and reverts it", () => {
    const base = load(v02Dir);
    const current = success(run(base, toned)).doc;
    const review = recordAgentEdit(startReview(base), base, current);
    expect(reviewChanges(review, current).map((change) => [change.id, change.by])).toEqual([
      ["scene:intro/block:intro-title/tone", "agent"],
    ]);

    const accepted = acceptChanges(review, current, ["scene:intro/block:intro-title/tone"]);
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.diagnostics));
    expect(accepted.review.scenes.intro?.schemaVersion).toBe("0.3");
    expect(reviewChanges(accepted.review, current)).toEqual([]);

    const reverted = revertChanges(review, current, "all");
    if (!reverted.ok) throw new Error(JSON.stringify(reverted.diagnostics));
    const intro = reverted.doc.scenes.intro as Scene;
    expect(intro.blocks[0]).not.toHaveProperty("tone");
    expect(shown(intro)).toEqual(shown(base.scenes.intro as Scene));
    expect(reviewChanges(reverted.review, reverted.doc)).toEqual([]);
  });

  it("copies a changed text into an older reviewed scene with the meaning it has in the newer one", () => {
    const base = load(v02Dir);
    const current = success(
      run(base, [
        { op: "block.set", scene: "intro", id: "intro-title", set: { size: "l", text: "Now **bold**" } },
      ]),
    ).doc;
    const accepted = acceptChanges(startReview(base), current, "all");
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.diagnostics));
    const partial = acceptChanges(startReview(base), current, ["scene:intro/block:intro-title/text"]);
    if (!partial.ok) throw new Error(JSON.stringify(partial.diagnostics));
    const intro = partial.review.scenes.intro as Scene;
    expect(intro.schemaVersion).toBe("0.3");
    expect(shown(intro)[0]).toBe("Now bold");
  });
});

describe("a 0.3 deck", () => {
  it("loads, with its palette, fonts, tones, tables and charts", () => {
    const doc = load(v03Dir);
    expect(doc.deck).toMatchObject({ schemaVersion: "0.3", fonts: "modern" });
    expect(doc.scenes.legacy?.schemaVersion).toBe("0.1");
    const overview = doc.scenes.overview as Scene;
    expect(shown(overview)[1]).toContain("Orders grew fastest in channel B, see the report or write to us.");
    expect(shown(overview)[1]).toContain("5 * 3 is a star, not italic");
  });
});
