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
