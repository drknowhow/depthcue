// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { newBlock } from "../src/templates.ts";
import { FakeServer } from "./helpers.ts";

/**
 * Every property the format lets a deck have must be editable somewhere in the editor, or be listed here as
 * something a person never edits. The editor used to show all of them in one panel, so a new property could not be
 * forgotten. With the controls spread over the slide, the toolbar and the popovers, this test does that job: it walks
 * the schema, and it fails naming the property that has nowhere to be edited.
 */

const schemaDir = resolve(import.meta.dirname, "../../core/schema");
const readSchema = (name: string): Schema =>
  JSON.parse(readFileSync(join(schemaDir, `${name}.schema.json`), "utf8"));

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  const?: string;
}

/**
 * The paths of everything that can be set. An object or a list of objects is a path of its own, for adding and
 * removing it, and ordering the list, and each of its fields follows. A block is one of several kinds, written
 * `scene.blocks<kind>`.
 */
function walk(node: Schema, path: string, into: string[], root = false) {
  if (node.oneOf) {
    // A block is told apart by its type, and an operation by its op.
    for (const branch of node.oneOf) {
      const kind = branch.properties?.type?.const ?? branch.properties?.op?.const;
      walk(branch, `${path}<${kind}>`, into, true);
    }
    return;
  }
  if (node.properties) {
    if (!root) into.push(path);
    for (const [name, child] of Object.entries(node.properties)) walk(child, `${path}.${name}`, into);
    return;
  }
  into.push(path);
  const item = node.items;
  if (node.type !== "array" || !item) return;
  if (item.oneOf) walk(item, path, into);
  else if (item.properties) walk(item, `${path}[]`, into, true);
}

const shipped = () => {
  const paths: string[] = [];
  walk(readSchema("deck"), "deck", paths, true);
  walk(readSchema("scene"), "scene", paths, true);
  // The comments file and the operations that change it are part of the format too, though they sit beside the deck.
  walk(readSchema("comments"), "comments", paths, true);
  walk(readSchema("comment-ops"), "commentOps", paths, true);
  return paths;
};

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;
// A scene with a claim, steps, sources, a chart and one block of each other kind, so every control has something to edit.
const SCENE = "demand";
const blocks = { text: "", image: "", clip: "" };

beforeEach(async () => {
  server = new FakeServer();
  server.assets.push("assets/walk.mp4");
  // One comment to open, so the controls of a thread have something to act on.
  server.externalComment([
    {
      op: "comment.add",
      scene: SCENE,
      block: "chart-demand",
      anchor: { x: 0.5, y: 0.5 },
      author: "you",
      text: "Is this the right quarter?",
    },
  ]);
  store = await openStore(server, () => memoryDraftStore());
  const scene = store.session.doc.scenes[SCENE];
  const image = [...store.session.doc.assets].sort().find((path) => /\.(png|jpe?g|webp|svg)$/.test(path));
  if (!scene || !image) throw new Error("the demo deck should have a demand scene and an image");
  const added = [
    newBlock(scene, "text"),
    newBlock(scene, "image", image),
    newBlock(scene, "clip", "assets/walk.mp4"),
  ];
  const result = store.session.apply(
    added.map((block) => ({ op: "block.add" as const, scene: SCENE, block })),
  );
  if (!result.ok) throw new Error("the extra blocks should be accepted");
  [blocks.text, blocks.image, blocks.clip] = added.map((block) => block.id) as [string, string, string];
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select(SCENE);
  await vi.waitFor(() => expect(store.comments.state.ready).toBe(true));
});
afterEach(() => editor.destroy());

const find = (root: ParentNode, selector: string) => root.querySelector(selector);
const field = (root: ParentNode, key: string) => find(root, `[data-field="${key}"]`);
const textBox = (id: string) =>
  find(host, `[data-id='${id}'] [data-edit], [data-id='${id}'][data-edit]`) as HTMLElement;
/** Chooses a block the way a person does: a text by putting the cursor in it, anything else by clicking it. */
const choose = (id: string, kind: "text" | "other") => {
  if (kind === "text") textBox(id).focus();
  else (find(host, `.ed-frame [data-id='${id}']`) as HTMLElement).click();
};
const popOf = (chip: Element) => chip.closest(".ed-tb-chip-wrap")?.querySelector(".ed-tb-pop") as HTMLElement;
/** Opens one of the chosen block's chips, as a click would, and answers with the popover it opens. */
const openChip = (name: string) => {
  const chip = find(host, `.ed-toolbar [data-tb='${name}']`) as HTMLElement | null;
  if (!chip) return undefined;
  chip.click();
  return popOf(chip);
};
const openTop = (selector: string) => {
  const chip = find(host, selector) as HTMLElement | null;
  if (!chip) return undefined;
  chip.click();
  return popOf(chip);
};
const scenePop = () => openTop(".ed-scene-tools [data-tb='scene']");
const notesPop = () => openTop(".ed-quick [data-tb='notes']");
const deckPop = () => openTop(".ed-actions [data-tb='deck']");
const source = () => store.session.doc.scenes[SCENE]?.sources?.[0]?.id as string;
const cited = (kind: "text" | "other", id: string) => {
  choose(id, kind);
  return openChip("cite")?.querySelector("input[data-tb='source']");
};

/** Where a property is edited, and how to find that control in the editor as it is mounted. */
interface Way {
  where: string;
  reach(): Element | null | undefined;
}
type Entry = Way | { never: string };

const NEVER_FORMAT = "A format marker the editor writes back as it found it.";
const NEVER_ID = "Chosen when the thing is created, and other things point at it, so it does not change.";
const NEVER_KIND = "The kind of a block is fixed when it is added.";

/** A pinned block, as a stored deck has it, chosen and with its Pinned chip open. There is no layout here to measure. */
const pinnedPop = (id: string) => {
  const result = store.session.apply([
    { op: "block.frame", scene: SCENE, id, frame: { x: 10, y: 10, w: 30, h: 20 } },
  ]);
  if (!result.ok) throw new Error("the frame should be accepted");
  choose(id, "other");
  return openChip("frame") as HTMLElement;
};

/** Every kind of block can be pinned, and each has the same two controls. */
const FRAMED: Record<string, { id: () => string; kind: "text" | "other" }> = {
  text: { id: () => blocks.text, kind: "text" },
  image: { id: () => blocks.image, kind: "other" },
  "bar-chart": { id: () => "chart-demand", kind: "other" },
  clip: { id: () => blocks.clip, kind: "other" },
};
const FRAMES = Object.fromEntries(
  Object.entries(FRAMED).flatMap(([type, { id, kind }]): [string, Entry][] => [
    [
      `scene.blocks<${type}>.frame`,
      {
        where: "Block toolbar, the Free button (or P on the chosen block)",
        reach: () => {
          choose(id(), kind);
          return find(host, ".ed-toolbar [data-tb='free']");
        },
      },
    ],
    ...(["x", "y", "w", "h"] as const).map((name): [string, Entry] => [
      `scene.blocks<${type}>.frame.${name}`,
      {
        where: "Block toolbar, Pinned chip (shown while the block is pinned)",
        reach: () => field(pinnedPop(id()), `frame:${name}`),
      },
    ]),
  ]),
);

const NEVER_AUTHOR =
  "The editor always writes as you, and the agent writes under its own name through deck_comment.";
const NEVER_STAMP = "Written by the server when a message is sent, so a person cannot set it.";
const NEVER_COMMENT_ID =
  "Given by the file when a comment is added, and the open thread supplies it afterwards.";

const within = (root: Element | null, selector: string) => (root ? find(root, selector) : null);
/** Starts a comment on the chosen picture from the palette, as a person without a pointer does, and answers with its box. */
const composing = () => {
  choose(blocks.image, "other");
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
  );
  (find(host, ".ed-palette [data-command='comment']") as HTMLElement | null)?.click();
  return find(host, ".ed-thread");
};
/** Opens the thread of the comment the deck starts with, from its pin. */
const threading = () => {
  (find(host, ".ed-pin") as HTMLElement | null)?.click();
  return find(host, ".ed-thread");
};
/** The tool that starts a comment by pressing a block, which is where the scene, the block and the point come from. */
const pressing = () => find(host, "[data-quick='comment']") && find(host, ".ed-comment-catch");

/** What a comment is made of, and how each part is reached. The operations below are the same controls. */
const COMMENT_WAYS: Record<string, Entry> = {
  "comments.$schema": { never: NEVER_FORMAT },
  "comments.format": { never: NEVER_FORMAT },
  "comments.comments": {
    where: "Quick bar, Comment (or M) to add; the open thread's Delete to remove",
    reach: () => find(host, "[data-quick='comment']") && within(threading(), "[data-comment='delete']"),
  },
  "comments.comments[].id": { never: NEVER_COMMENT_ID },
  "comments.comments[].scene": {
    where: "Comment tool: a comment is made on the scene that is on show",
    reach: pressing,
  },
  "comments.comments[].block": {
    where: "Comment tool: the block that is pressed, or the chosen block from the palette",
    reach: pressing,
  },
  "comments.comments[].anchor": {
    where: "Comment tool: the point of the block that is pressed",
    reach: pressing,
  },
  "comments.comments[].anchor.x": {
    where: "Comment tool: the point of the block that is pressed",
    reach: pressing,
  },
  "comments.comments[].anchor.y": {
    where: "Comment tool: the point of the block that is pressed",
    reach: pressing,
  },
  "comments.comments[].thread": {
    where: "A pin opens its thread, and Reply adds to it",
    reach: () => within(threading(), "[data-comment='reply']"),
  },
  "comments.comments[].thread[].author": { never: NEVER_AUTHOR },
  "comments.comments[].thread[].text": {
    where: "Comment box and Reply box, the text area",
    reach: () => within(composing(), "[data-comment='field']"),
  },
  "comments.comments[].thread[].at": { never: NEVER_STAMP },
  "comments.comments[].resolved": {
    where: "Open thread, Resolve and Reopen",
    reach: () => within(threading(), "[data-comment='resolve']"),
  },
  "comments.comments[].ask": {
    where: "Comment box, Ask the agent (only when the comment is made)",
    reach: () => within(composing(), "[data-comment='ask']"),
  },

  commentOps: {
    where: "The buttons of the comment box and the open thread send them",
    reach: () => within(composing(), "[data-comment='add']"),
  },
  "commentOps<comment.add>.op": {
    where: "Comment box, Comment",
    reach: () => within(composing(), "[data-comment='add']"),
  },
  "commentOps<comment.add>.id": { never: NEVER_COMMENT_ID },
  "commentOps<comment.add>.scene": { where: "Comment tool: the scene on show", reach: pressing },
  "commentOps<comment.add>.block": { where: "Comment tool: the block pressed", reach: pressing },
  "commentOps<comment.add>.anchor": { where: "Comment tool: the point pressed", reach: pressing },
  "commentOps<comment.add>.anchor.x": { where: "Comment tool: the point pressed", reach: pressing },
  "commentOps<comment.add>.anchor.y": { where: "Comment tool: the point pressed", reach: pressing },
  "commentOps<comment.add>.author": { never: NEVER_AUTHOR },
  "commentOps<comment.add>.text": {
    where: "Comment box, the text area",
    reach: () => within(composing(), "[data-comment='field']"),
  },
  "commentOps<comment.add>.ask": {
    where: "Comment box, Ask the agent",
    reach: () => within(composing(), "[data-comment='ask']"),
  },
  "commentOps<comment.reply>.op": {
    where: "Open thread, Reply",
    reach: () => within(threading(), "[data-comment='reply']"),
  },
  "commentOps<comment.reply>.id": { never: NEVER_COMMENT_ID },
  "commentOps<comment.reply>.author": { never: NEVER_AUTHOR },
  "commentOps<comment.reply>.text": {
    where: "Open thread, the reply text area",
    reach: () => within(threading(), "[data-comment='field']"),
  },
  "commentOps<comment.resolve>.op": {
    where: "Open thread, Resolve",
    reach: () => within(threading(), "[data-comment='resolve']"),
  },
  "commentOps<comment.resolve>.id": { never: NEVER_COMMENT_ID },
  "commentOps<comment.reopen>.op": {
    where: "Open thread of a resolved comment, Reopen (the same button as Resolve)",
    reach: () => within(threading(), "[data-comment='resolve']"),
  },
  "commentOps<comment.reopen>.id": { never: NEVER_COMMENT_ID },
  "commentOps<comment.delete>.op": {
    where: "Open thread, Delete, pressed twice",
    reach: () => within(threading(), "[data-comment='delete']"),
  },
  "commentOps<comment.delete>.id": { never: NEVER_COMMENT_ID },
};

const WAYS: Record<string, Entry> = {
  ...FRAMES,
  ...COMMENT_WAYS,
  "deck.$schema": { never: NEVER_FORMAT },
  "deck.schemaVersion": { never: NEVER_FORMAT },
  "deck.id": { never: NEVER_ID },
  "deck.title": {
    where: "Deck popover, Title",
    reach: () => field(deckPop() as HTMLElement, "panel:deck:title"),
  },
  "deck.language": {
    where: "Deck popover, Language",
    reach: () => field(deckPop() as HTMLElement, "panel:deck:language"),
  },
  "deck.theme": {
    where: "Deck popover, Theme",
    reach: () => field(deckPop() as HTMLElement, "panel:deck:theme"),
  },
  "deck.scenes": {
    where: "Scene strip: add, move earlier and later, duplicate, delete and drag",
    reach: () =>
      find(host, "[data-action='add-scene']") &&
      find(host, "[data-action='move-scene-earlier']") &&
      find(host, "[data-action='move-scene-later']") &&
      find(host, "[data-action='duplicate-scene']") &&
      find(host, "[data-action='delete-scene']"),
  },
  "deck.modules": {
    where: "Deck popover, one choice per module",
    reach: () => find(deckPop() as HTMLElement, "select[data-field^='panel:deck:module:']"),
  },

  "scene.$schema": { never: NEVER_FORMAT },
  "scene.schemaVersion": { never: NEVER_FORMAT },
  "scene.id": { never: NEVER_ID },
  "scene.title": {
    where: "Scene popover, Title",
    reach: () => field(scenePop() as HTMLElement, "panel:title"),
  },
  "scene.layout": { where: "Layout buttons in the top bar", reach: () => find(host, "[data-layout]") },
  "scene.lead": { where: "Who leads buttons in the top bar", reach: () => find(host, "[data-lead]") },
  "scene.summary": {
    where: "Quick bar, Claim; the claim's toolbar removes it",
    reach: () => {
      choose("claim-shift", "text");
      return find(host, "[data-quick='claim']") && find(host, ".ed-toolbar [data-tb='remove']");
    },
  },
  "scene.summary.id": { never: NEVER_ID },
  "scene.summary.text": {
    where: "Typed in place on the slide",
    reach: () => textBox("claim-shift"),
  },
  "scene.summary.evidenceIds": {
    where: "Claim toolbar, Evidence chip",
    reach: () => {
      choose("claim-shift", "text");
      return find(openChip("evidence") as HTMLElement, "input[type='checkbox']");
    },
  },
  "scene.blocks": {
    where: "Quick bar to add; block toolbar to move and remove",
    reach: () => {
      choose(blocks.text, "text");
      return (
        find(host, "[data-quick='text']") &&
        find(host, ".ed-toolbar [data-tb='move-earlier']") &&
        find(host, ".ed-toolbar [data-tb='remove']")
      );
    },
  },
  "scene.sources": {
    where: "Scene popover, Sources, Add",
    reach: () => field(scenePop() as HTMLElement, "panel:source:add"),
  },
  "scene.sources[].id": { never: NEVER_ID },
  "scene.sources[].title": {
    where: "Scene popover, Sources, Title",
    reach: () => field(scenePop() as HTMLElement, `panel:source:${source()}:title`),
  },
  "scene.sources[].asset": {
    where: "Scene popover, Sources, File",
    reach: () => field(scenePop() as HTMLElement, `panel:source:${source()}:asset`),
  },
  "scene.sources[].url": {
    where: "Scene popover, Sources, Link",
    reach: () => field(scenePop() as HTMLElement, `panel:source:${source()}:url`),
  },
  "scene.reading": {
    where: "Notes popover, Reading version",
    reach: () => field(notesPop() as HTMLElement, "panel:reading"),
  },
  "scene.reading.text": {
    where: "Notes popover, Reading version",
    reach: () => field(notesPop() as HTMLElement, "panel:reading"),
  },
  "scene.steps": {
    where: "Scene popover, Steps, Add a step",
    reach: () => field(scenePop() as HTMLElement, "panel:step:add"),
  },
  "scene.steps[].id": { never: NEVER_ID },
  "scene.steps[].reveal": {
    where: "Scene popover, Steps, what each step reveals",
    reach: () =>
      find(
        scenePop() as HTMLElement,
        "[data-field^='panel:step:']:not([data-field='panel:step:add']), input[data-field^='panel:step:']",
      ),
  },
  "scene.notes": {
    where: "Notes popover, Speaker notes",
    reach: () => field(notesPop() as HTMLElement, "panel:notes"),
  },

  "scene.blocks<text>.id": { never: NEVER_ID },
  "scene.blocks<text>.type": { never: NEVER_KIND },
  "scene.blocks<text>.role": {
    where: "Text toolbar, role",
    reach: () => {
      choose(blocks.text, "text");
      return find(host, ".ed-toolbar [data-tb='role']");
    },
  },
  "scene.blocks<text>.text": { where: "Typed in place on the slide", reach: () => textBox(blocks.text) },
  "scene.blocks<text>.sourceIds": {
    where: "Text toolbar, Cite chip",
    reach: () => cited("text", blocks.text),
  },

  "scene.blocks<image>.id": { never: NEVER_ID },
  "scene.blocks<image>.type": { never: NEVER_KIND },
  "scene.blocks<image>.asset": {
    where: "Picture dropped or pasted on the image; Edit chip, Image file and upload",
    reach: () => {
      choose(blocks.image, "other");
      return field(openChip("edit") as HTMLElement, "image:asset");
    },
  },
  "scene.blocks<image>.alt": {
    where: "Image toolbar, Edit chip, Alt text",
    reach: () => {
      choose(blocks.image, "other");
      return field(openChip("edit") as HTMLElement, "image:alt");
    },
  },
  "scene.blocks<image>.caption": {
    where: "Image toolbar, Edit chip, Caption",
    reach: () => {
      choose(blocks.image, "other");
      return field(openChip("edit") as HTMLElement, "image:caption");
    },
  },
  "scene.blocks<image>.sourceIds": {
    where: "Image toolbar, Cite chip",
    reach: () => cited("other", blocks.image),
  },

  "scene.blocks<bar-chart>.id": { never: NEVER_ID },
  "scene.blocks<bar-chart>.type": { never: NEVER_KIND },
  "scene.blocks<bar-chart>.title": {
    where: "Chart toolbar, Data chip, Title",
    reach: () => {
      choose("chart-demand", "other");
      return field(openChip("data") as HTMLElement, "chart:title");
    },
  },
  "scene.blocks<bar-chart>.unit": {
    where: "Chart toolbar, Data chip, Unit",
    reach: () => {
      choose("chart-demand", "other");
      return field(openChip("data") as HTMLElement, "chart:unit");
    },
  },
  "scene.blocks<bar-chart>.data": {
    where: "Chart toolbar, Add bar and Sort; Data chip, remove and move rows",
    reach: () => {
      choose("chart-demand", "other");
      return find(host, ".ed-toolbar [data-tb='add-bar']");
    },
  },
  "scene.blocks<bar-chart>.data[].label": {
    where: "The slide, a bar's label typed in place; Data chip, row labels",
    reach: () => find(host, ".ed-frame [data-id='chart-demand'] th[scope='row'][data-edit]"),
  },
  "scene.blocks<bar-chart>.data[].value": {
    where: "The slide, a bar dragged or moved with the arrow keys; Data chip, row values",
    reach: () => find(host, ".ed-frame [data-id='chart-demand'] .dc-bar[role='slider']"),
  },
  "scene.blocks<bar-chart>.sourceIds": {
    where: "Chart toolbar, Cite chip",
    reach: () => cited("other", "chart-demand"),
  },

  "scene.blocks<clip>.id": { never: NEVER_ID },
  "scene.blocks<clip>.type": { never: NEVER_KIND },
  "scene.blocks<clip>.source": {
    where: "Clip toolbar, Edit chip, Video file",
    reach: () => {
      choose(blocks.clip, "other");
      return field(openChip("edit") as HTMLElement, "clip:source");
    },
  },
  "scene.blocks<clip>.poster": {
    where: "Clip toolbar, Edit chip, Poster image",
    reach: () => {
      choose(blocks.clip, "other");
      return field(openChip("edit") as HTMLElement, "clip:poster");
    },
  },
  "scene.blocks<clip>.alt": {
    where: "Clip toolbar, Edit chip, Alt text",
    reach: () => {
      choose(blocks.clip, "other");
      return field(openChip("edit") as HTMLElement, "clip:alt");
    },
  },
  "scene.blocks<clip>.sourceIds": {
    where: "Clip toolbar, Cite chip",
    reach: () => cited("other", blocks.clip),
  },
};

/**
 * Properties schema 0.3 added that the editor cannot edit yet, by the step of docs/CONTENT_RANGE.md that adds their
 * controls. The step that adds a control takes its prefix out of this list and gives each property a way in WAYS.
 */
const PENDING: ReadonlyArray<[prefix: string, step: string]> = [
  ["deck.palette", "Step 3, deck style"],
  ["deck.fonts", "Step 3, deck style"],
  ["scene.blocks<table>", "Step 4, table block"],
  ["scene.blocks<text>.tone", "Step 5, text styles"],
  ["scene.blocks<text>.size", "Step 5, text styles"],
  ["scene.blocks<text>.align", "Step 5, text styles"],
  ["scene.blocks<chart>", "Step 6, chart types"],
];
const pending = (path: string) =>
  PENDING.some(
    ([prefix]) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`),
  );

describe("every property of a deck can be edited", () => {
  it("leaves a property pending only while it has no way to be edited", () => {
    const both = Object.keys(WAYS).filter(pending);
    expect(both, `Take these out of PENDING in test/coverage.test.ts: ${both.join(", ")}.`).toEqual([]);
    for (const [prefix] of PENDING) {
      expect(
        shipped().some((path) => pending(path) && path.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
  });

  it("has a way, or a reason it has none, for each property in the schema", () => {
    const known = new Set([...Object.keys(WAYS), ...shipped().filter(pending)]);
    const missing = shipped().filter((path) => !known.has(path));
    expect(
      missing,
      `The schema has properties that WAYS in test/coverage.test.ts does not mention: ${missing.join(", ")}. ` +
        "Add each with where it is edited, or with why a person never edits it.",
    ).toEqual([]);
    const now = new Set(shipped());
    const stale = [...known].filter((path) => !now.has(path));
    expect(
      stale,
      `WAYS in test/coverage.test.ts names properties the schema no longer has: ${stale.join(", ")}.`,
    ).toEqual([]);
  });

  it("walks the schema far enough to see a block's own fields and a chart's rows", () => {
    expect(shipped()).toEqual(
      expect.arrayContaining([
        "deck.theme",
        "scene.summary.evidenceIds",
        "scene.blocks<clip>.poster",
        "scene.blocks<bar-chart>.data[].value",
        "scene.blocks<clip>.frame.w",
        "scene.steps[].reveal",
        "comments.comments[].anchor.x",
        "comments.comments[].thread[].text",
        "commentOps<comment.reply>.text",
        "commentOps<comment.delete>.id",
      ]),
    );
  });

  it("gives a reason for each property that is never edited", () => {
    for (const [path, entry] of Object.entries(WAYS)) {
      if ("never" in entry) expect(entry.never.length, path).toBeGreaterThan(10);
    }
  });

  it("names the controls of a block's frame for every kind of block", () => {
    const framed = Object.keys(WAYS).filter((path) =>
      /^scene\.blocks<[a-z-]+>\.frame(\.[xywh])?$/.test(path),
    );
    expect(framed).toHaveLength(Object.keys(FRAMED).length * 5);
  });

  const edited = Object.entries(WAYS).filter((pair): pair is [string, Way] => "where" in pair[1]);
  it.each(edited)("%s: the control is in the editor", (path, way) => {
    const control = way.reach();
    expect(
      control,
      `${path} should be editable at: ${way.where}. No such control was found in the editor.`,
    ).toBeTruthy();
  });
});
