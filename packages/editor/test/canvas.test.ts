// @vitest-environment happy-dom
import { createSession, loadDoc, type Session, TEXT_LIMITS } from "@depthcue/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type Canvas, createCanvas } from "../src/canvas.ts";
import { FakeServer, openingTitle, retitle } from "./helpers.ts";

let session: Session;
let canvas: Canvas;
let hints: Array<{ text: string; problem: boolean }>;
let picked: string[];

function start() {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo should load");
  session = createSession(doc);
  hints = [];
  picked = [];
  canvas = createCanvas(session, {
    hint: (text, problem) => hints.push({ text, problem }),
    select: (id) => picked.push(id),
  });
  document.body.replaceChildren(canvas.element);
}

beforeEach(start);

const editables = () => [...canvas.element.querySelectorAll<HTMLElement>("[data-edit]")];
const field = (id: string): HTMLElement => {
  const found = [...canvas.element.querySelectorAll<HTMLElement>("[data-id]")].find(
    (n) => n.dataset.id === id,
  );
  const node = found?.matches("[data-edit]") ? found : found?.querySelector<HTMLElement>("[data-edit]");
  if (!node) throw new Error(`no editable field for ${id}`);
  return node;
};

/** What typing does: the browser changes the text, then fires `input`. */
function type(node: HTMLElement, text: string) {
  node.textContent = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

const sceneText = (sceneId: string, blockId: string) => {
  const block = session.doc.scenes[sceneId]?.blocks.find((candidate) => candidate.id === blockId);
  return block && "text" in block ? block.text : undefined;
};

describe("showing a scene", () => {
  it("renders the scene as the player does, with every step revealed", () => {
    canvas.render("demand");
    const frame = canvas.element.querySelector<HTMLElement>(".dc-player");
    expect(frame?.dataset.theme).toBe(session.doc.deck.theme);
    expect(canvas.element.querySelector("[data-scene='demand']")).not.toBeNull();
    const gated = [...canvas.element.querySelectorAll<HTMLElement>("[data-gated]")];
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.every((node) => node.dataset.revealed === "true")).toBe(true);
  });

  it("marks each piece of text as an editable one-line text box", () => {
    canvas.render("opening");
    const nodes = editables();
    const textBlocks = session.doc.scenes.opening?.blocks.filter((block) => block.type === "text") ?? [];
    expect(nodes).toHaveLength(textBlocks.length);
    for (const node of nodes) {
      expect(node.getAttribute("role")).toBe("textbox");
      expect(node.getAttribute("aria-label")).toMatch(/ text$/);
      expect(node.getAttribute("aria-multiline")).toBe("false");
      expect(["plaintext-only", "true"]).toContain(node.contentEditable);
      expect(node.tabIndex).toBe(0);
    }
  });

  it("shows nothing for a scene that does not exist", () => {
    canvas.render("opening");
    canvas.render("gone");
    expect(canvas.element.querySelector(".ed-frame")).toBeNull();
    // The overlay is not part of the slide, so it is still there for the toolbar.
    expect(canvas.element.contains(canvas.overlay)).toBe(true);
  });

  it("makes the claim of a claim-and-evidence scene editable, and in a chart only the labels", () => {
    canvas.render("demand");
    const summary = session.doc.scenes.demand?.summary;
    expect(summary).toBeDefined();
    expect(field((summary as { id: string }).id).textContent).toBe(summary?.text);
    const inFigures = editables().filter((node) => node.closest("figure"));
    expect(inFigures.length).toBeGreaterThan(0);
    expect(inFigures.every((node) => node.matches('th[scope="row"]'))).toBe(true);
  });
});

describe("typing", () => {
  it("changes the document through a core operation as the text changes", () => {
    canvas.render("opening");
    const node = field("opening-title");
    node.focus();
    type(node, "Channel B now leads demand, clearly");
    expect(sceneText("opening", "opening-title")).toBe("Channel B now leads demand, clearly");
    expect(session.dirty).toBe(true);
  });

  it("joins one visit to a field into a single undo step", () => {
    canvas.render("opening");
    const original = openingTitle(session.doc);
    const node = field("opening-title");
    node.focus();
    for (const text of ["C", "Ch", "Cha", "Chan"]) type(node, text);
    expect(session.undo()).toBe(true);
    expect(openingTitle(session.doc)).toBe(original);
    expect(session.canUndo).toBe(false);
  });

  it("starts a new undo step each time the visitor comes back to the field", () => {
    canvas.render("opening");
    const original = openingTitle(session.doc);
    const node = field("opening-title");
    node.focus();
    type(node, "First visit");
    node.blur();
    node.focus();
    type(node, "Second visit");
    expect(session.undo()).toBe(true);
    expect(openingTitle(session.doc)).toBe("First visit");
    expect(session.undo()).toBe(true);
    expect(openingTitle(session.doc)).toBe(original);
  });

  it("says it is typing while the change is applied, so the caller leaves the caret alone", () => {
    canvas.render("opening");
    const seen: boolean[] = [];
    session.subscribe(() => seen.push(canvas.typing));
    const node = field("opening-title");
    node.focus();
    type(node, "Typing");
    session.apply([retitle("Elsewhere")]);
    expect(seen).toEqual([true, false]);
    expect(canvas.typing).toBe(false);
  });

  it("collapses line breaks and keeps the text on one line", () => {
    canvas.render("opening");
    const node = field("opening-title");
    node.focus();
    type(node, "Two\nlines   here");
    expect(openingTitle(session.doc)).toBe("Two lines here");
  });

  it("edits the claim of a claim-and-evidence scene and keeps its evidence", () => {
    canvas.render("demand");
    const summary = session.doc.scenes.demand?.summary as NonNullable<
      NonNullable<typeof session.doc.scenes.demand>["summary"]
    >;
    const node = field(summary.id);
    node.focus();
    type(node, "A sharper claim");
    expect(session.doc.scenes.demand?.summary).toEqual({ ...summary, text: "A sharper claim" });
  });

  it("edits a quote through the paragraph inside it", () => {
    session.apply([
      {
        op: "block.add",
        scene: "opening",
        block: { id: "said", type: "text", role: "quote", text: "Original quote" },
      },
    ]);
    canvas.render("opening");
    const node = field("said");
    expect(node.tagName).toBe("P");
    node.focus();
    type(node, "Better quote");
    expect(sceneText("opening", "said")).toBe("Better quote");
  });
});

describe("text the schema would refuse", () => {
  it("never applies empty text, shows why, and restores the document's text on leaving", () => {
    canvas.render("opening");
    const original = openingTitle(session.doc);
    const node = field("opening-title");
    node.focus();
    type(node, "   ");
    expect(session.dirty).toBe(false);
    expect(node.hasAttribute("data-invalid")).toBe(true);
    expect(hints.at(-1)).toMatchObject({ problem: true });
    expect(hints.at(-1)?.text).toContain("cannot be empty");
    node.blur();
    expect(node.textContent).toBe(original);
    expect(node.hasAttribute("data-invalid")).toBe(false);
    expect(session.dirty).toBe(false);
  });

  it("never applies text over the limit for its role, and says by how much", () => {
    canvas.render("opening");
    const node = field("opening-title");
    node.focus();
    type(node, "x".repeat(TEXT_LIMITS.heading + 1));
    expect(session.dirty).toBe(false);
    expect(hints.at(-1)).toEqual({ text: `1 over the limit of ${TEXT_LIMITS.heading}.`, problem: true });
    type(node, "x".repeat(TEXT_LIMITS.heading));
    expect(session.dirty).toBe(true);
    expect(node.hasAttribute("data-invalid")).toBe(false);
    expect(hints.at(-1)?.problem).toBe(false);
  });

  it("keeps the last good text when the visitor goes on to break it", () => {
    canvas.render("opening");
    const node = field("opening-title");
    node.focus();
    type(node, "Good text");
    type(node, "");
    expect(openingTitle(session.doc)).toBe("Good text");
    node.blur();
    expect(node.textContent).toBe("Good text");
  });
});

describe("keys", () => {
  const before = (node: HTMLElement, inputType: string) => {
    const event = new InputEvent("beforeinput", { inputType, cancelable: true, bubbles: true });
    node.dispatchEvent(event);
    return event;
  };

  it("Enter finishes the edit instead of adding a line", () => {
    canvas.render("opening");
    const node = field("opening-title");
    node.focus();
    expect(before(node, "insertParagraph").defaultPrevented).toBe(true);
    expect(before(node, "insertLineBreak").defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(node);
  });

  it("sends the browser's undo and redo to the session, which owns the history", () => {
    canvas.render("opening");
    const original = openingTitle(session.doc);
    const node = field("opening-title");
    node.focus();
    type(node, "Changed");
    expect(before(node, "historyUndo").defaultPrevented).toBe(true);
    expect(openingTitle(session.doc)).toBe(original);
    expect(before(node, "historyRedo").defaultPrevented).toBe(true);
    expect(openingTitle(session.doc)).toBe("Changed");
  });

  it("Escape puts the document's text back and leaves the field", () => {
    canvas.render("opening");
    const node = field("opening-title");
    node.focus();
    type(node, "x".repeat(TEXT_LIMITS.heading + 5));
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(node.textContent).toBe(openingTitle(session.doc));
    expect(node.hasAttribute("data-invalid")).toBe(false);
  });
});

describe("redrawing", () => {
  it("shows an undone edit, and returns the caret to the field being edited", () => {
    canvas.render("opening");
    const original = openingTitle(session.doc);
    const node = field("opening-title");
    node.focus();
    type(node, "Changed");
    session.undo();
    canvas.render("opening");
    const again = field("opening-title");
    expect(again.textContent).toBe(original);
    expect(again).not.toBe(node);
    expect(document.activeElement).toBe(again);
  });

  it("does not take focus when nothing was being edited", () => {
    canvas.render("opening");
    canvas.render("opening");
    expect(document.activeElement).toBe(document.body);
  });
});
