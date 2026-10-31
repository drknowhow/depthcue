// @vitest-environment happy-dom
import { type Frame, memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { DRAG_THRESHOLD } from "../src/framedrag.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

let host: HTMLElement;
let store: EditorStore;
let editor: Editor;

beforeEach(async () => {
  store = await openStore(new FakeServer(), () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select("method");
});
afterEach(async () => {
  // The click that ends a drag is swallowed until the next turn of the event loop.
  await new Promise((resolve) => setTimeout(resolve, 2));
  editor.destroy();
  vi.restoreAllMocks();
});

const SCENE = "method";
const TEXT = "method-body";
const PICTURE = "method-diagram";
/**
 * Where the picture is pinned. No edge or middle of it is within reach of a line of the slide, so a small move is
 * not pulled back: it is 10% from the left, and its right edge is at 40%.
 */
const START: Frame = { x: 10, y: 52, w: 30, h: 10 };
/** The picture's box on a 1600 by 900 slide, which is its frame. */
const PICTURE_BOX: [number, number, number, number] = [160, 468, 480, 90];

const blockNode = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-frame [data-id='${id}']`) as HTMLElement;
const frameOf = (id: string): Frame | undefined =>
  store.session.doc.scenes[SCENE]?.blocks.find((block) => block.id === id)?.frame;
const hint = () => host.querySelector(".ed-hint")?.textContent ?? "";
const handle = (corner: string) =>
  host.querySelector<HTMLElement>(`[data-handle="${corner}"]`) as HTMLElement;
const handlesHidden = () => host.querySelector<HTMLElement>(".ed-handles")?.hidden;
const guides = () => [...host.querySelectorAll<HTMLElement>(".ed-guide")].map((line) => line.dataset.axis);
const cssFrame = (id: string) =>
  ["--x", "--y", "--w", "--h"].map((name) => Number(blockNode(id).style.getPropertyValue(name)));
const selected = () => blockNode(PICTURE).hasAttribute("data-selected");
const inside = (id: string) =>
  host.querySelector<HTMLElement>(`[data-id='${id}'] [data-edit], [data-id='${id}'][data-edit]`);

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  }) as DOMRect;

/** There is no layout here, so the slide is given as 1600 by 900, and so are the boxes of some blocks. */
const laidOut = (
  boxes: Record<string, [number, number, number, number]>,
  slide = rect(0, 0, 1600, 900),
  editorBox = rect(0, 0, 1600, 900),
) => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const { classList } = this;
    if (classList.contains("dc-pins")) return slide;
    if (classList.contains("ed-canvas-host")) return editorBox;
    if (classList.contains("dc-view")) return rect(0, 0, 1600, 900);
    const found = this instanceof HTMLElement && this.dataset.id ? boxes[this.dataset.id] : undefined;
    return found ? rect(...found) : rect(0, 0, 0, 0);
  });
};

const pin = (id: string, frame: Frame) => {
  const result = store.session.apply([{ op: "block.frame", scene: SCENE, id, frame }]);
  if (!result.ok) throw new Error("the frame should be accepted");
};

const pointer = (type: string, x: number, y: number, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...init });
const down = (node: Element, x: number, y: number, init: MouseEventInit = {}) =>
  node.dispatchEvent(pointer("pointerdown", x, y, init));
const move = (x: number, y: number, init: MouseEventInit = {}) =>
  window.dispatchEvent(pointer("pointermove", x, y, init));
const up = (x: number, y: number) => window.dispatchEvent(pointer("pointerup", x, y));
const pressEscape = (node: Element) => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  node.dispatchEvent(event);
  return event;
};

/** The picture pinned at `START` on a laid out slide. */
const pinnedPicture = () => {
  laidOut({ [PICTURE]: PICTURE_BOX });
  pin(PICTURE, START);
};

describe("moving a pinned block", () => {
  it("draws it at the pointer while the button is down and changes the deck only when it is let go", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(360, 470);
    expect(cssFrame(PICTURE)).toEqual([20, 52, 30, 10]);
    expect(frameOf(PICTURE)).toEqual(START);
    up(360, 470);
    expect(frameOf(PICTURE)).toEqual({ x: 20, y: 52, w: 30, h: 10 });
    expect(hint()).toBe("");
  });

  it("is one undo step however far it went", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    for (const x of [230, 280, 330, 360]) move(x, 470 + (x - 200) * 0.28125);
    up(360, 515);
    expect(frameOf(PICTURE)).toEqual({ x: 20, y: 57, w: 30, h: 10 });
    store.session.undo();
    expect(frameOf(PICTURE)).toEqual(START);
  });

  it("chooses the block it is pressed on", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    expect(selected()).toBe(true);
    up(200, 470);
  });

  it("is a click, and not a move, when the pointer stays within a few pixels", () => {
    pinnedPicture();
    const spy = vi.spyOn(store.session, "apply");
    down(blockNode(PICTURE), 200, 470);
    move(200 + DRAG_THRESHOLD - 1, 470);
    up(200 + DRAG_THRESHOLD - 1, 470);
    expect(spy.mock.calls.flatMap(([ops]) => ops).filter((op) => op.op === "block.frame")).toEqual([]);
    expect(frameOf(PICTURE)).toEqual(START);
  });

  it("starts once the pointer has gone the threshold and no sooner", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(200 + DRAG_THRESHOLD - 1, 470);
    expect(cssFrame(PICTURE)).toEqual([10, 52, 30, 10]);
    move(200 + DRAG_THRESHOLD, 470);
    expect(cssFrame(PICTURE)[0]).toBe(10.2);
    up(200 + DRAG_THRESHOLD, 470);
  });

  it("is taken back by Escape, which does not also let go of the block", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(500, 600);
    expect(cssFrame(PICTURE)).not.toEqual([10, 52, 30, 10]);
    expect(pressEscape(blockNode(PICTURE)).defaultPrevented).toBe(true);
    expect(cssFrame(PICTURE)).toEqual([10, 52, 30, 10]);
    up(500, 600);
    expect(frameOf(PICTURE)).toEqual(START);
    expect(selected()).toBe(true);
  });

  it("leaves Escape to the block when nothing was moved yet", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    expect(pressEscape(blockNode(PICTURE)).defaultPrevented).toBe(false);
  });

  it("does nothing more once the system cancels the pointer", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(360, 470);
    window.dispatchEvent(pointer("pointercancel", 360, 470));
    move(500, 470);
    up(500, 470);
    expect(frameOf(PICTURE)).toEqual(START);
    expect(cssFrame(PICTURE)).toEqual([10, 52, 30, 10]);
  });

  it("stays on the slide", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(5000, 5000);
    up(5000, 5000);
    expect(frameOf(PICTURE)).toEqual({ x: 70, y: 90, w: 30, h: 10 });
  });

  it("leaves the block chosen when the pointer is let go off it, which would otherwise count as a click on nothing", async () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(5000, 470);
    up(5000, 470);
    const clickOnNothing = () =>
      host
        .querySelector(".ed-canvas-slot .dc-stage")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(blockNode(PICTURE), "after the drag").not.toBeNull();
    clickOnNothing();
    expect(blockNode(PICTURE), "after the first click").not.toBeNull();
    expect(selected()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    clickOnNothing();
    expect(blockNode(PICTURE), "after the second click").not.toBeNull();
    expect(selected()).toBe(false);
  });

  it("moves by the grip of a pinned block, which is not dragged to a slot", () => {
    pinnedPicture();
    const grip = host.querySelector<HTMLElement>(`[data-grip="${PICTURE}"]`) as HTMLElement;
    expect(grip.hasAttribute("data-pinned")).toBe(true);
    expect(grip.hasAttribute("draggable")).toBe(false);
    down(grip, 100, 100);
    move(260, 100);
    up(260, 100);
    expect(frameOf(PICTURE)).toEqual({ x: 20, y: 52, w: 30, h: 10 });
  });

  it("leaves the grip of a block in a slot to be dragged to one", () => {
    pinnedPicture();
    const grip = host.querySelector<HTMLElement>(`[data-grip="${TEXT}"]`) as HTMLElement;
    expect(grip.hasAttribute("data-pinned")).toBe(false);
    expect(grip.getAttribute("draggable")).toBe("true");
  });

  it("is started only by the main button", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470, { button: 2 });
    move(360, 470);
    up(360, 470);
    expect(frameOf(PICTURE)).toEqual(START);
  });

  it("is not started from a block that is not pinned", () => {
    laidOut({ [TEXT]: [320, 90, 800, 180] });
    pin(PICTURE, START);
    down(blockNode(TEXT), 400, 100);
    move(560, 100);
    up(560, 100);
    expect(frameOf(TEXT)).toBeUndefined();
  });

  it("is not started from a control inside the block", () => {
    pinnedPicture();
    const button = document.createElement("button");
    blockNode(PICTURE).append(button);
    down(button, 200, 470);
    move(360, 470);
    up(360, 470);
    expect(frameOf(PICTURE)).toEqual(START);
  });

  it.each([
    ["a text field", () => Object.assign(document.createElement("input"), { type: "text" })],
    ["a text area", () => document.createElement("textarea")],
    ["a menu", () => document.createElement("select")],
    ["a link", () => Object.assign(document.createElement("a"), { href: "https://example.com" })],
    ["a video", () => document.createElement("video")],
    [
      "a slider",
      () => {
        const bar = document.createElement("div");
        bar.dataset.slider = "";
        return bar;
      },
    ],
  ])("is not started from %s inside the block", (_name, make) => {
    pinnedPicture();
    const control = make();
    blockNode(PICTURE).append(control);
    down(control, 200, 470);
    move(360, 470);
    up(360, 470);
    expect(frameOf(PICTURE)).toEqual(START);
  });

  it("is not a drag of the browser's own when it starts on a picture, which would end the pointer events", () => {
    pinnedPicture();
    const picture = document.createElement("img");
    blockNode(PICTURE).append(picture);
    const start = new Event("dragstart", { bubbles: true, cancelable: true });
    picture.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
  });

  it("leaves a drag of the browser's own alone on a grip, which drags a block to a slot, and in a text field", () => {
    pinnedPicture();
    const grip = host.querySelector(`[data-grip="${TEXT}"]`) as HTMLElement;
    const fromGrip = new Event("dragstart", { bubbles: true, cancelable: true });
    grip.dispatchEvent(fromGrip);
    expect(fromGrip.defaultPrevented).toBe(false);

    const field = document.createElement("span");
    field.dataset.edit = "";
    blockNode(PICTURE).append(field);
    const fromField = new Event("dragstart", { bubbles: true, cancelable: true });
    field.dispatchEvent(fromField);
    expect(fromField.defaultPrevented).toBe(false);
  });

  it("is not started while the text of a pinned block is being typed in", () => {
    laidOut({ [TEXT]: [320, 90, 800, 180] });
    pin(TEXT, { x: 20, y: 10, w: 50, h: 20 });
    blockNode(TEXT).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(blockNode(TEXT).hasAttribute("data-edit")).toBe(true);
    down(blockNode(TEXT), 400, 100);
    move(560, 100);
    up(560, 100);
    expect(frameOf(TEXT)).toEqual({ x: 20, y: 10, w: 50, h: 20 });
  });

  it("moves a pinned text, which is not typed in until Enter or a double click", () => {
    laidOut({ [TEXT]: [320, 90, 800, 180] });
    pin(TEXT, { x: 20, y: 10, w: 50, h: 20 });
    down(blockNode(TEXT), 400, 100);
    move(560, 100);
    up(560, 100);
    expect(frameOf(TEXT)).toEqual({ x: 30, y: 10, w: 50, h: 20 });
  });

  it("does nothing on a slide too narrow for pinned blocks to sit where their frames say", () => {
    laidOut({ [PICTURE]: PICTURE_BOX }, rect(0, 0, 400, 900));
    pin(PICTURE, START);
    down(blockNode(PICTURE), 200, 470);
    move(360, 470);
    up(360, 470);
    expect(frameOf(PICTURE)).toEqual(START);
  });

  it("can be undone and redone like any other edit", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(360, 470);
    up(360, 470);
    store.session.undo();
    expect(frameOf(PICTURE)).toEqual(START);
    store.session.redo();
    expect(frameOf(PICTURE)).toEqual({ x: 20, y: 52, w: 30, h: 10 });
  });

  it("ignores a second press while one is going, which must not start the drag over from there", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(360, 470);
    down(blockNode(PICTURE), 360, 470);
    move(520, 470);
    expect(cssFrame(PICTURE)[0]).toBe(30);
    up(520, 470);
    expect(frameOf(PICTURE)?.x).toBe(30);
  });

  it("marks the editor while a block is being dragged, so the page does not select text, and clears the mark", () => {
    pinnedPicture();
    const area = host.querySelector(".ed-canvas-host") as HTMLElement;
    down(blockNode(PICTURE), 200, 470);
    expect(area.hasAttribute("data-framing")).toBe(false);
    move(360, 470);
    expect(area.hasAttribute("data-framing")).toBe(true);
    up(360, 470);
    expect(area.hasAttribute("data-framing")).toBe(false);
  });

  it("asks for nothing to be applied when the block is dragged back to where it began", () => {
    pinnedPicture();
    const spy = vi.spyOn(store.session, "apply");
    down(blockNode(PICTURE), 200, 470);
    move(360, 470);
    move(200, 470);
    up(200, 470);
    expect(spy.mock.calls.flatMap(([ops]) => ops).filter((op) => op.op === "block.frame")).toEqual([]);
    expect(cssFrame(PICTURE)).toEqual([10, 52, 30, 10]);
  });

  it("eats the click that ends a drag and no other", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(5000, 470);
    up(5000, 470);
    const clickOnNothing = () =>
      host
        .querySelector(".ed-canvas-slot .dc-stage")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    clickOnNothing();
    expect(selected()).toBe(true);
    clickOnNothing();
    expect(selected()).toBe(false);
  });

  it("does not eat the click of a press that moved nothing", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    up(200, 470);
    host
      .querySelector(".ed-canvas-slot .dc-stage")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(selected()).toBe(false);
  });

  it("is dropped when the slide is drawn again under the pointer, which leaves the block as the deck has it", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(360, 470);
    editor.select("method");
    move(500, 470);
    up(500, 470);
    expect(frameOf(PICTURE)).toEqual(START);
    expect(cssFrame(PICTURE)).toEqual([10, 52, 30, 10]);
  });

  it("is dropped, and the block put back, when the deck refuses the frame", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(360, 470);
    vi.spyOn(store.session, "apply").mockReturnValue({
      ok: false,
      diagnostics: [{ message: "No room there." }],
    } as unknown as ReturnType<typeof store.session.apply>);
    up(360, 470);
    expect(cssFrame(PICTURE)).toEqual([10, 52, 30, 10]);
    expect(hint()).toBe("No room there.");
  });
});

describe("snapping while moving", () => {
  it("pulls an edge onto the safe margin and draws the line it is on", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(200 - 92.8, 470);
    expect(cssFrame(PICTURE)[0]).toBe(4);
    expect(guides()).toEqual(["x"]);
    const line = host.querySelector<HTMLElement>(".ed-guide[data-axis='x']") as HTMLElement;
    // 4% of a slide 1600 wide, from the top of the slide to its bottom.
    expect([line.style.left, line.style.top, line.style.height]).toEqual(["64px", "0px", "900px"]);
    up(200 - 92.8, 470);
    expect(frameOf(PICTURE)?.x).toBe(4);
    expect(guides()).toEqual([]);
  });

  it("pulls the middle of the block onto the middle of the slide", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    // The middle is at 25% and a move of 24.5% puts it at 49.5%, near the middle line.
    move(200 + 392, 470);
    expect(cssFrame(PICTURE)[0]).toBe(35);
    up(200 + 392, 470);
  });

  it("lines up with the edge of another pinned block", () => {
    laidOut({ [PICTURE]: PICTURE_BOX });
    pin(TEXT, { x: 55, y: 10, w: 30, h: 20 });
    pin(PICTURE, START);
    down(blockNode(PICTURE), 200, 470);
    move(200 + 725, 470);
    expect(cssFrame(PICTURE)[0]).toBe(55);
    up(200 + 725, 470);
    expect(frameOf(PICTURE)?.x).toBe(55);
  });

  it("lines up with a block that is not pinned, where it stands", () => {
    laidOut({ [PICTURE]: PICTURE_BOX, [TEXT]: [880, 90, 400, 180] });
    pin(PICTURE, START);
    down(blockNode(PICTURE), 200, 470);
    // The text's left edge is at 55% of the slide, and the picture's left edge comes within 0.3% of it.
    move(200 + 725, 470);
    expect(cssFrame(PICTURE)[0]).toBe(55);
    up(200 + 725, 470);
  });

  it("is off while Alt is held", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(200 - 92.8, 470, { altKey: true });
    expect(cssFrame(PICTURE)[0]).toBe(4.2);
    expect(guides()).toEqual([]);
    up(200 - 92.8, 470);
    expect(frameOf(PICTURE)?.x).toBe(4.2);
  });

  it("is back on when Alt is let go, within the same drag", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(200 - 92.8, 470, { altKey: true });
    move(200 - 92.8, 470);
    expect(cssFrame(PICTURE)[0]).toBe(4);
    up(200 - 92.8, 470);
  });
});

describe("snapping against the edge of the slide and against the claim", () => {
  it("draws the line a block is resting on when it is pushed against the edge", () => {
    pinnedPicture();
    down(blockNode(PICTURE), 200, 470);
    move(5000, 470);
    expect(cssFrame(PICTURE)[0]).toBe(70);
    expect(guides()).toContain("x");
    up(5000, 470);
  });

  it("lines up with the claim of the scene, which is not a block", () => {
    laidOut({ "claim-shift": [880, 90, 400, 180] });
    editor.select("demand");
    const result = store.session.apply([
      { op: "block.frame", scene: "demand", id: "chart-demand", frame: { x: 10, y: 52, w: 30, h: 10 } },
    ]);
    expect(result.ok).toBe(true);
    const chart = () => host.querySelector<HTMLElement>(".ed-frame [data-id='chart-demand']") as HTMLElement;
    down(chart(), 200, 470);
    // The claim's left edge is at 55%, and the chart's comes within 0.3% of it.
    move(200 + 725, 470);
    expect(Number(chart().style.getPropertyValue("--x"))).toBe(55);
    up(200 + 725, 470);
  });
});

describe("drawn in the editor's own box, which is not the slide's", () => {
  const EDITOR = rect(100, 50, 1700, 1000);
  const SLIDE = rect(150, 80, 1600, 900);
  /** The picture's box: 10% across and 52% down the slide, 30% by 10%. */
  const BOX: [number, number, number, number] = [310, 548, 480, 90];

  it("puts the handles against the corners of the block", () => {
    laidOut({ [PICTURE]: BOX }, SLIDE, EDITOR);
    pin(PICTURE, START);
    blockNode(PICTURE).click();
    expect([handle("nw").style.left, handle("nw").style.top]).toEqual(["205px", "493px"]);
    expect([handle("se").style.left, handle("se").style.top]).toEqual(["685px", "583px"]);
  });

  it("puts a guide where the line is on the slide", () => {
    laidOut({ [PICTURE]: BOX }, SLIDE, EDITOR);
    pin(PICTURE, START);
    down(blockNode(PICTURE), 400, 600);
    move(400 - 92.8, 600);
    const line = host.querySelector<HTMLElement>(".ed-guide[data-axis='x']") as HTMLElement;
    // 4% of the slide's width from the slide's left edge, which is 50 pixels in from the editor's.
    expect([line.style.left, line.style.top, line.style.height]).toEqual(["114px", "30px", "900px"]);
    up(400 - 92.8, 600);
  });

  it("puts a guide across the slide for a line that runs sideways", () => {
    laidOut({ [PICTURE]: BOX }, SLIDE, EDITOR);
    pin(PICTURE, { ...START, y: 48.5 });
    down(blockNode(PICTURE), 400, 600);
    // The top edge is at 48.5% and moves 1% to the middle of the slide at 50%.
    move(400, 600 + 9);
    const line = host.querySelector<HTMLElement>(".ed-guide[data-axis='y']") as HTMLElement;
    expect([line.style.left, line.style.top, line.style.width]).toEqual(["50px", "480px", "1600px"]);
    up(400, 609);
  });
});

describe("the handles while a block moves", () => {
  it("follow the block, and are not left where it was", () => {
    // The box of the picture is worked out from its frame as it is drawn, as a browser would lay it out.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const { classList } = this;
      if (
        classList.contains("dc-pins") ||
        classList.contains("ed-canvas-host") ||
        classList.contains("dc-view")
      )
        return rect(0, 0, 1600, 900);
      if (this instanceof HTMLElement && this.dataset.id === PICTURE) {
        const value = (name: string) => Number(this.style.getPropertyValue(name));
        return rect(value("--x") * 16, value("--y") * 9, value("--w") * 16, value("--h") * 9);
      }
      return rect(0, 0, 0, 0);
    });
    pin(PICTURE, START);
    blockNode(PICTURE).click();
    expect(handle("nw").style.left).toBe("155px");
    down(blockNode(PICTURE), 200, 470);
    move(360, 470);
    expect(handle("nw").style.left).toBe("315px");
    up(360, 470);
  });

  it("are hidden for a block with no box to put them against", () => {
    laidOut({});
    pin(PICTURE, START);
    blockNode(PICTURE).click();
    expect(handlesHidden()).toBe(true);
  });
});

describe("resizing from a corner", () => {
  const chosen = () => {
    pinnedPicture();
    blockNode(PICTURE).click();
  };

  it("shows a handle on each corner of the chosen pinned block", () => {
    chosen();
    expect(handlesHidden()).toBe(false);
    expect([handle("nw").style.left, handle("nw").style.top]).toEqual(["155px", "463px"]);
    expect([handle("ne").style.left, handle("ne").style.top]).toEqual(["635px", "463px"]);
    expect([handle("se").style.left, handle("se").style.top]).toEqual(["635px", "553px"]);
    expect([handle("sw").style.left, handle("sw").style.top]).toEqual(["155px", "553px"]);
  });

  it("shows none for a block that is not pinned", () => {
    laidOut({ [TEXT]: [320, 90, 800, 180] });
    pin(PICTURE, START);
    inside(TEXT)?.focus();
    expect(handlesHidden()).toBe(true);
  });

  it("shows none on a narrow slide, where a frame is not where the block is drawn", () => {
    laidOut({ [PICTURE]: PICTURE_BOX }, rect(0, 0, 400, 900));
    pin(PICTURE, START);
    blockNode(PICTURE).click();
    expect(handlesHidden()).toBe(true);
  });

  it("moves the corner that is dragged and keeps the opposite one", () => {
    chosen();
    down(handle("se"), 640, 558);
    move(800, 648);
    expect(cssFrame(PICTURE)).toEqual([10, 52, 40, 20]);
    up(800, 648);
    expect(frameOf(PICTURE)).toEqual({ x: 10, y: 52, w: 40, h: 20 });
  });

  it("works from the top left, where the frame also moves", () => {
    chosen();
    down(handle("nw"), 160, 468);
    move(96, 378);
    up(96, 378);
    expect(frameOf(PICTURE)).toEqual({ x: 6, y: 42, w: 34, h: 20 });
  });

  it("works from the top right and the bottom left", () => {
    chosen();
    down(handle("ne"), 640, 468);
    move(720, 378);
    up(720, 378);
    expect(frameOf(PICTURE)).toEqual({ x: 10, y: 42, w: 35, h: 20 });
    store.session.undo();
    down(handle("sw"), 160, 558);
    move(96, 648);
    up(96, 648);
    expect(frameOf(PICTURE)).toEqual({ x: 6, y: 52, w: 34, h: 20 });
  });

  it("stops at the smallest size a frame may have", () => {
    chosen();
    down(handle("se"), 640, 558);
    move(-4000, -4000);
    up(-4000, -4000);
    expect(frameOf(PICTURE)).toEqual({ x: 10, y: 52, w: 5, h: 5 });
  });

  it("snaps the edges it moves, and not the ones it keeps", () => {
    chosen();
    down(handle("se"), 640, 558);
    // The right edge comes to 95.9, within reach of the right safe margin at 96; the top edge at 52 is not looked at.
    move(640 + 895, 558);
    expect(cssFrame(PICTURE)).toEqual([10, 52, 86, 10]);
    expect(guides()).toEqual(["x"]);
    up(640 + 895, 558);
    expect(frameOf(PICTURE)).toEqual({ x: 10, y: 52, w: 86, h: 10 });
  });

  it("is off while Alt is held", () => {
    chosen();
    down(handle("se"), 640, 558);
    move(640 + 895, 558, { altKey: true });
    expect(cssFrame(PICTURE)).toEqual([10, 52, 85.9, 10]);
    up(640 + 895, 558);
  });

  it("is one undo step", () => {
    chosen();
    down(handle("se"), 640, 558);
    for (const x of [660, 720, 800]) move(x, 558 + (x - 640) / 2);
    up(800, 638);
    expect(frameOf(PICTURE)?.w).not.toBe(START.w);
    store.session.undo();
    expect(frameOf(PICTURE)).toEqual(START);
  });

  it("is started by a handle only with the main button", () => {
    chosen();
    down(handle("se"), 640, 558, { button: 1 });
    move(800, 648);
    up(800, 648);
    expect(frameOf(PICTURE)).toEqual(START);
  });

  it("is taken back by Escape", () => {
    chosen();
    down(handle("se"), 640, 558);
    move(800, 648);
    pressEscape(blockNode(PICTURE));
    up(800, 648);
    expect(frameOf(PICTURE)).toEqual(START);
    expect(cssFrame(PICTURE)).toEqual([10, 52, 30, 10]);
  });
});
