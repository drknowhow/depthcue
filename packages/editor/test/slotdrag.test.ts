// @vitest-environment happy-dom
import { type Block, createSession, loadDoc, type NewScene, type Session } from "@depthcue/core";
import { renderScene } from "@depthcue/player";
import { beforeEach, describe, expect, it } from "vitest";
import { type Canvas, createCanvas } from "../src/canvas.ts";
import { REGION_SLOT } from "../src/slotdrag.ts";
import { FakeServer } from "./helpers.ts";

const text = (id: string, role: "heading" | "body" = "body"): Block => ({ id, type: "text", role, text: id });
const chart = (id: string): Block => ({ id, type: "bar-chart", data: [{ label: "A", value: 1 }] });

const claimScene: NewScene = {
  id: "lab",
  title: "Lab",
  layout: "claim-evidence",
  summary: { id: "lab-claim", text: "A claim", evidenceIds: ["proof"] },
  blocks: [text("proof"), text("note"), chart("figure")],
};
const mediaScene: NewScene = {
  id: "wide",
  title: "Wide",
  layout: "text-media",
  blocks: [text("words"), chart("graph")],
};
const stackScene: NewScene = {
  id: "plain",
  title: "Plain",
  layout: "title",
  blocks: [text("head", "heading"), text("one"), text("two")],
};

let session: Session;
let canvas: Canvas;
let picked: string[];
let hints: Array<{ text: string; problem: boolean }>;

function start() {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo should load");
  session = createSession(doc);
  const added = session.apply(
    [claimScene, mediaScene, stackScene].map((scene) => ({ op: "scene.add" as const, scene })),
  );
  if (!added.ok) throw new Error(JSON.stringify(added.diagnostics));
  picked = [];
  hints = [];
  canvas = createCanvas(session, {
    hint: (message, problem) => hints.push({ text: message, problem }),
    select: (id) => picked.push(id),
  });
  document.body.replaceChildren(canvas.element);
}

beforeEach(start);

const order = (scene: string) => session.doc.scenes[scene]?.blocks.map((block) => block.id);
const evidence = (scene: string) => session.doc.scenes[scene]?.summary?.evidenceIds;
const grips = () => [...canvas.element.querySelectorAll<HTMLElement>("[data-grip]")];
const gripOf = (id: string) => {
  const found = grips().find((node) => node.dataset.grip === id);
  if (!found) throw new Error(`no grip for ${id}`);
  return found;
};
const node = (id: string) => {
  const found = canvas.nodeOf(id);
  if (!found) throw new Error(`no block ${id}`);
  return found;
};
const region = (name: string) => {
  const found = canvas.element.querySelector<HTMLElement>(`.${name}`);
  if (!found) throw new Error(`no region ${name}`);
  return found;
};

const BLOCK_TYPE = "application/x-depthcue-block";
function transfer() {
  const data = {
    types: [] as string[],
    dropEffect: "none",
    effectAllowed: "none",
    set: {} as Record<string, string>,
  };
  return Object.assign(data, {
    setData(type: string, value: string) {
      data.types.push(type);
      data.set[type] = value;
    },
    setDragImage() {},
  });
}
type Transfer = ReturnType<typeof transfer>;

function fire(target: Element, type: string, init: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

/** Every block is 40 px tall starting at 100, so a pointer at 105 is on the upper half and 135 on the lower. */
function stubBoxes() {
  for (const target of canvas.element.querySelectorAll<HTMLElement>(".dc-block")) {
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({ top: 100, left: 0, height: 40, width: 100, bottom: 140, right: 100 }),
    });
  }
}

function pick(id: string): Transfer {
  const data = transfer();
  fire(gripOf(id), "dragstart", { dataTransfer: data, clientX: 0, clientY: 0 });
  return data;
}
const over = (target: Element, data: Transfer, clientY = 105) =>
  fire(target, "dragover", { dataTransfer: data, clientY });
const drop = (target: Element, data: Transfer, clientY = 105) =>
  fire(target, "drop", { dataTransfer: data, clientY });

describe("the grips", () => {
  it("draws one for each block, and none for the claim", () => {
    canvas.render("lab");
    expect(grips().map((grip) => grip.dataset.grip)).toEqual(["proof", "note", "figure"]);
    canvas.render("plain");
    expect(grips().map((grip) => grip.dataset.grip)).toEqual(["head", "one", "two"]);
  });

  it("draws none for a scene that is not there", () => {
    canvas.render("lab");
    canvas.render("gone");
    expect(grips()).toEqual([]);
  });

  it("keeps them out of the blocks, whose text is what a person edits", () => {
    canvas.render("plain");
    for (const grip of grips()) expect(canvas.element.querySelector(".ed-frame")?.contains(grip)).toBe(false);
    expect(node("head").textContent).toBe("head");
  });

  it("marks the grip of the chosen block", () => {
    canvas.render("plain", "one");
    expect(gripOf("one").hasAttribute("data-chosen")).toBe(true);
    canvas.mark("two");
    expect(gripOf("one").hasAttribute("data-chosen")).toBe(false);
    expect(gripOf("two").hasAttribute("data-chosen")).toBe(true);
    canvas.mark(undefined);
    expect(canvas.element.querySelector("[data-grip][data-chosen]")).toBeNull();
  });

  it("is draggable, and says nothing to a screen reader, which has the toolbar's buttons", () => {
    canvas.render("plain");
    expect(gripOf("one").getAttribute("draggable")).toBe("true");
    expect(gripOf("one").getAttribute("aria-hidden")).toBe("true");
  });

  it("stands beside its block, inside the host", () => {
    canvas.render("plain");
    Object.defineProperty(canvas.element, "getBoundingClientRect", {
      value: () => ({ top: 10, left: 20, height: 500, width: 900, bottom: 510, right: 920 }),
    });
    Object.defineProperty(node("one"), "getBoundingClientRect", {
      value: () => ({ top: 150, left: 120, height: 40, width: 100, bottom: 190, right: 220 }),
    });
    canvas.refreshCues();
    expect(gripOf("one").style.top).toBe("140px");
    expect(gripOf("one").style.left).toBe("94px");
  });

  it("hides rather than cover its block when the slide has no room beside it", () => {
    canvas.render("plain");
    Object.defineProperty(canvas.element, "getBoundingClientRect", {
      value: () => ({ top: 10, left: 20, height: 500, width: 300, bottom: 510, right: 320 }),
    });
    Object.defineProperty(gripOf("one"), "offsetWidth", { value: 24 });
    const standAt = (left: number) => {
      Object.defineProperty(node("one"), "getBoundingClientRect", {
        configurable: true,
        value: () => ({ top: 150, left, height: 40, width: 100, bottom: 190, right: left + 100 }),
      });
      canvas.refreshCues();
    };
    standAt(43);
    expect(gripOf("one").hidden).toBe(true);
    // Exactly the grip's width of room is enough: it stands at the host's edge and touches the block.
    standAt(44);
    expect(gripOf("one").hidden).toBe(false);
    expect(gripOf("one").style.left).toBe("0px");
    standAt(120);
    expect(gripOf("one").hidden).toBe(false);
    expect(gripOf("one").style.left).toBe("70px");
  });
});

describe("taking hold of a grip", () => {
  it("chooses the block, marks it, and carries only its own kind of data", () => {
    canvas.render("plain");
    const data = pick("one");
    expect(picked).toEqual(["one"]);
    expect(node("one").hasAttribute("data-dragging")).toBe(true);
    expect(data.types).toEqual([BLOCK_TYPE]);
    expect(data.set[BLOCK_TYPE]).toBe("one");
    expect(data.effectAllowed).toBe("move");
  });

  it("lets go of the marks when the drag ends without a drop", () => {
    canvas.render("plain");
    pick("one");
    fire(gripOf("one"), "dragend", {});
    expect(node("one").hasAttribute("data-dragging")).toBe(false);
    expect(canvas.element.querySelector("[data-dragging]")).toBeNull();
    expect(canvas.element.hasAttribute("data-dragging")).toBe(false);
  });

  it("marks the whole slide while a block is carried, so its empty areas can show", () => {
    canvas.render("plain");
    expect(canvas.element.hasAttribute("data-dragging")).toBe(false);
    pick("one");
    expect(canvas.element.hasAttribute("data-dragging")).toBe(true);
  });
});

describe("dropping on a block of the same area", () => {
  beforeEach(() => {
    canvas.render("plain");
    stubBoxes();
  });

  it("puts the block before the one it is over, on its upper half, and shows where", () => {
    const data = pick("two");
    const event = over(node("one"), data, 105);
    expect(event.defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("move");
    expect(node("one").dataset.place).toBe("before");
    drop(node("one"), data, 105);
    expect(order("plain")).toEqual(["head", "two", "one"]);
    expect(canvas.element.querySelector("[data-place]")).toBeNull();
  });

  it("puts it after the block on its lower half", () => {
    const data = pick("head");
    over(node("one"), data, 135);
    expect(node("one").dataset.place).toBe("after");
    drop(node("one"), data, 135);
    expect(order("plain")).toEqual(["one", "head", "two"]);
  });

  it("shows where the drop would land as soon as the pointer enters a block, before any dragover", () => {
    const data = pick("two");
    const event = fire(node("one"), "dragenter", { dataTransfer: data, clientY: 105 });
    expect(event.defaultPrevented).toBe(true);
    expect(node("one").dataset.place).toBe("before");
  });

  it("is one step in the history", () => {
    const data = pick("two");
    drop(node("one"), data, 105);
    session.undo();
    expect(order("plain")).toEqual(["head", "one", "two"]);
  });

  it("offers nothing where the block would not move", () => {
    const data = pick("one");
    expect(over(node("head"), data, 135).defaultPrevented).toBe(false);
    expect(over(node("one"), data, 105).defaultPrevented).toBe(false);
    expect(canvas.element.querySelector("[data-place]")).toBeNull();
    drop(node("head"), data, 135);
    expect(order("plain")).toEqual(["head", "one", "two"]);
    expect(hints.some((entry) => entry.problem)).toBe(false);
  });

  it("says why when the change is refused after all", () => {
    const data = pick("two");
    Object.assign(session, {
      apply: () => ({
        ok: false,
        code: "invalid-deck",
        rev: "x",
        diagnostics: [
          {
            severity: "error",
            code: "x",
            file: "scenes/plain.json",
            path: "/blocks",
            message: "Not allowed.",
          },
        ],
      }),
    });
    drop(node("one"), data, 105);
    expect(hints.at(-1)).toEqual({ text: "Not allowed.", problem: true });
  });

  it("treats the pointer being on a grip as being on the block it belongs to", () => {
    const data = pick("two");
    expect(over(gripOf("one"), data, 105).defaultPrevented).toBe(true);
    expect(node("one").dataset.place).toBe("before");
    drop(gripOf("one"), data, 105);
    expect(order("plain")).toEqual(["head", "two", "one"]);
  });

  it("forgets the drag once the block has been dropped", () => {
    const data = pick("two");
    drop(node("one"), data, 105);
    expect(over(node("head"), data, 105).defaultPrevented).toBe(false);
    expect(drop(node("head"), data, 105).defaultPrevented).toBe(false);
  });

  it("takes the drop itself, so a browser has no text to put in a field", () => {
    const data = pick("two");
    expect(drop(node("one"), data, 105).defaultPrevented).toBe(true);
  });
});

describe("dropping on a block of another area", () => {
  beforeEach(() => {
    canvas.render("lab");
    stubBoxes();
  });

  it("swaps the two, and each is cited, or not, as the other was", () => {
    const data = pick("figure");
    const event = over(node("proof"), data);
    expect(event.defaultPrevented).toBe(true);
    expect(node("proof").dataset.place).toBe("swap");
    drop(node("proof"), data);
    expect(order("lab")).toEqual(["figure", "note", "proof"]);
    expect(evidence("lab")).toEqual(["figure"]);
  });

  it("moves into an area when it is dropped on the empty part of it", () => {
    const data = pick("note");
    const target = region("dc-evidence-region");
    expect(over(target, data).defaultPrevented).toBe(true);
    expect(target.dataset.place).toBe("into");
    drop(target, data);
    expect(evidence("lab")).toEqual(["proof", "note"]);
  });

  it("does nothing over the area the block is already in", () => {
    const data = pick("note");
    expect(over(region("dc-support-region"), data).defaultPrevented).toBe(false);
    drop(region("dc-support-region"), data);
    expect(order("lab")).toEqual(["proof", "note", "figure"]);
  });

  it("refuses the claim area, and says why while the pointer is there", () => {
    const data = pick("note");
    const target = region("dc-claim-region");
    expect(over(target, data).defaultPrevented).toBe(false);
    expect(target.dataset.place).toBe("refused");
    expect(data.dropEffect).toBe("none");
    expect(hints.at(-1)?.problem).toBe(true);
    expect(hints.at(-1)?.text).toMatch(/claim area/);
    drop(target, data);
    expect(order("lab")).toEqual(["proof", "note", "figure"]);
    expect(hints.at(-1)).toEqual({ text: "", problem: false });
  });

  it("clears the line about a refusal when the pointer leaves the slide", () => {
    const data = pick("note");
    over(region("dc-claim-region"), data);
    fire(canvas.element, "dragleave", { relatedTarget: document.body });
    expect(canvas.element.querySelector("[data-place]")).toBeNull();
    expect(hints.at(-1)).toEqual({ text: "", problem: false });
  });
});

describe("text and media", () => {
  beforeEach(() => {
    canvas.render("wide");
    stubBoxes();
  });

  it("will not put text among the media", () => {
    const data = pick("words");
    expect(over(node("graph"), data).defaultPrevented).toBe(false);
    expect(node("graph").dataset.place).toBe("refused");
    expect(hints.at(-1)?.text).toMatch(/Text goes in the text area/);
    drop(node("graph"), data);
    expect(order("wide")).toEqual(["words", "graph"]);
  });
});

describe("a drag that is not a block", () => {
  it("is left alone", () => {
    canvas.render("plain");
    stubBoxes();
    const files = { types: ["Files"], dropEffect: "none" };
    expect(over(node("one"), files as unknown as Transfer).defaultPrevented).toBe(false);
    expect(drop(node("one"), files as unknown as Transfer).defaultPrevented).toBe(false);
    expect(order("plain")).toEqual(["head", "one", "two"]);
  });

  it("is ignored when no grip was taken hold of", () => {
    canvas.render("plain");
    stubBoxes();
    const data = transfer();
    data.types.push(BLOCK_TYPE);
    expect(over(node("one"), data).defaultPrevented).toBe(false);
    expect(drop(node("one"), data).defaultPrevented).toBe(false);
  });
});

describe("the areas the player draws", () => {
  it("are all known, or a drop on one would do nothing", () => {
    for (const id of ["lab", "wide", "plain"]) {
      const scene = session.doc.scenes[id];
      if (!scene) throw new Error(`no scene ${id}`);
      const drawn = renderScene(scene, { assetBase: "" });
      for (const area of drawn.querySelectorAll(".dc-region")) {
        const known = Object.keys(REGION_SLOT).some((name) => area.classList.contains(name));
        expect(known, `REGION_SLOT in slotdrag.ts has no entry for ${[...area.classList].join(" ")}`).toBe(
          true,
        );
      }
    }
  });
});
