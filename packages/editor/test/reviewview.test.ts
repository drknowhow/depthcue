import { type Change, loadDoc } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { countsByScene, excerpt, rowOf, summaryOf } from "../src/reviewview.ts";
import { FakeServer } from "./helpers.ts";

const server = new FakeServer();
const { doc } = loadDoc({ text: server.text, assets: server.assets });
if (!doc) throw new Error("the demo deck should load");

const base: Change = {
  id: "scene:opening/block:opening-title/text",
  scope: "block",
  kind: "changed",
  scene: "opening",
  block: "opening-title",
  field: "text",
  before: "Before",
  after: "After",
  by: "agent",
};

/** A change like the one above, with some properties changed. One set to `undefined` is left out, as a diff leaves it. */
const change = (over: { [K in keyof Change]?: Change[K] | undefined }): Change => {
  const merged: Record<string, unknown> = { ...base, ...over };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as Change;
};

describe("excerpt", () => {
  it("is text as it is, with its runs of space made one, and cut where it is long", () => {
    expect(excerpt("a  b\n c")).toBe("a b c");
    const long = excerpt("word ".repeat(80));
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.endsWith("…")).toBe(true);
    expect(excerpt("x".repeat(140))).toBe("x".repeat(140));
  });

  it("is nothing for nothing, and the plain form of a number or a flag", () => {
    expect(excerpt(undefined)).toBe("");
    expect(excerpt(null)).toBe("");
    expect(excerpt(3)).toBe("3");
    expect(excerpt(false)).toBe("false");
  });

  it("joins a list of ids, and writes any other list as it is", () => {
    expect(excerpt(["a", "b"])).toBe("a, b");
    expect(excerpt([1, 2])).toBe("[1,2]");
  });

  it("names a block by its kind and its words, and a scene by its title and size", () => {
    expect(excerpt({ id: "t", type: "text", text: "Hello" })).toBe("text: Hello");
    expect(excerpt({ id: "i", type: "image", alt: "A chart" })).toBe("image: A chart");
    expect(excerpt({ id: "c", type: "bar-chart" })).toBe("bar-chart");
    expect(excerpt({ id: "s", title: "Method", blocks: [{}, {}] })).toBe("Method (2 blocks)");
    expect(excerpt({ id: "s", title: "Alone", blocks: [{}] })).toBe("Alone (1 block)");
    expect(excerpt({ a: 1 })).toBe('{"a":1}');
  });
});

describe("rowOf", () => {
  it("says where a block's field is, from the scene's place and title to the field", () => {
    const row = rowOf(change({}), doc);
    expect(row.where).toBe(`Scene 1 · ${doc.scenes.opening?.title} · Block opening-title · text`);
    expect(row.before).toBe("Before");
    expect(row.after).toBe("After");
    expect(row.said).toBe('Text of block "opening-title" in scene "opening" changed');
  });

  it("leaves out what was not there, or is not there now", () => {
    expect(rowOf(change({ kind: "added", before: undefined }), doc)).toMatchObject({
      before: undefined,
      after: "After",
    });
    expect(rowOf(change({ kind: "removed", after: undefined }), doc)).toMatchObject({
      before: "Before",
      after: undefined,
    });
  });

  it("names a whole block or scene that came or went, and the order of blocks", () => {
    expect(
      rowOf(
        change({ id: "scene:method/block:x", kind: "added", scene: "method", block: "x", field: undefined }),
        doc,
      ).where,
    ).toBe(`Scene 3 · ${doc.scenes.method?.title} · Block x`);
    expect(
      rowOf(
        change({
          id: "scene:method/blocks",
          scope: "scene",
          kind: "moved",
          scene: "method",
          block: undefined,
          field: "blocks",
        }),
        doc,
      ).where,
    ).toBe(`Scene 3 · ${doc.scenes.method?.title} · Block order`);
  });

  it("names a deck property and the order of scenes", () => {
    expect(
      rowOf(
        change({ id: "deck/title", scope: "deck", scene: undefined, block: undefined, field: "title" }),
        doc,
      ).where,
    ).toBe("Deck · title");
    expect(
      rowOf(
        change({
          id: "deck/scenes",
          scope: "deck",
          kind: "moved",
          scene: undefined,
          block: undefined,
          field: "scenes",
        }),
        doc,
      ).where,
    ).toBe("Deck · Scene order");
  });

  it("names a scene that is gone by what it was", () => {
    const row = rowOf(
      change({
        id: "scene:old",
        scope: "scene",
        kind: "removed",
        scene: "old",
        block: undefined,
        field: undefined,
        before: { id: "old", title: "The old one", blocks: [] },
        after: undefined,
      }),
      doc,
    );
    expect(row.where).toBe("Scene · The old one");
    expect(row.before).toBe("The old one (0 blocks)");
  });
});

describe("a change of the brand's files", () => {
  const deck = (over: { [K in keyof Change]?: Change[K] | undefined }) =>
    change({ scope: "deck", scene: undefined, block: undefined, ...over });

  it("names the part of the brand plainly, with no Deck before it", () => {
    expect(
      rowOf(deck({ id: "deck/brand", field: "brand", kind: "added", before: undefined }), doc).where,
    ).toBe("Brand");
    expect(rowOf(deck({ id: "deck/brand/colors", field: "brand/colors" }), doc).where).toBe("Brand colors");
    expect(rowOf(deck({ id: "deck/brand/hideBuiltIn", field: "brand/hideBuiltIn" }), doc).where).toBe(
      "Built-ins the brand hides",
    );
    expect(rowOf(deck({ id: "deck/brand/someday", field: "brand/someday" }), doc).where).toBe(
      "Brand someday",
    );
  });

  it("names a style or a template by its name, and says only what changed in it", () => {
    const row = rowOf(
      deck({
        id: "deck/style:kicker",
        field: "style:kicker",
        before: { name: "Kicker", for: ["caption"], size: "s" },
        after: { name: "Kicker", for: ["caption"], size: "l" },
      }),
      doc,
    );
    expect(row.where).toBe("Style: Kicker");
    expect([row.before, row.after]).toEqual(['size: "s"', 'size: "l"']);
  });

  it("gives a template added or removed as its name and how many slots it has", () => {
    const added = rowOf(
      deck({
        id: "deck/template:quote",
        field: "template:quote",
        kind: "added",
        before: undefined,
        after: { name: "Quote", slots: [{ id: "q" }] },
      }),
      doc,
    );
    expect(added.where).toBe("Template: Quote");
    expect([added.before, added.after]).toEqual([undefined, "Quote (1 slot)"]);
    const removed = rowOf(
      deck({
        id: "deck/template:wide",
        field: "template:wide",
        kind: "removed",
        before: { name: "Wide", slots: [{ id: "a" }, { id: "b" }] },
        after: undefined,
      }),
      doc,
    );
    expect([removed.where, removed.before, removed.after]).toEqual([
      "Template: Wide",
      "Wide (2 slots)",
      undefined,
    ]);
  });
});

describe("the counts", () => {
  it("separates what the agent changed from what was changed outside", () => {
    expect(summaryOf([change({}), change({ by: "outside" }), change({})])).toEqual({ agent: 2, outside: 1 });
    expect(summaryOf([])).toEqual({ agent: 0, outside: 0 });
  });

  it("counts a scene's changes for its thumbnail, and gives the deck's own to no scene", () => {
    const counts = countsByScene([
      change({}),
      change({ id: "b" }),
      change({ id: "c", scene: "method" }),
      change({ id: "deck/title", scope: "deck", scene: undefined }),
    ]);
    expect([...counts]).toEqual([
      ["opening", 2],
      ["method", 1],
    ]);
  });
});
