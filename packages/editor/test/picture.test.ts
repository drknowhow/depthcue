// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { end, FULL, fitBox, panCrop, resizeCrop, run } from "../src/picture.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

/*
 * The picture tools: the arithmetic of crop mode (an edge dragged, the picture moved under the crop, a box fitted to its
 * picture), then crop mode itself with the sizes it needs given by hand, since there is no layout here, and the
 * toolbar, menu and Scene popover that reach them.
 */

describe("resizing a crop", () => {
  const crop = { x: 20, y: 10, w: 50, h: 80 };

  it("moves only the edges its handle is on, in percent of the file", () => {
    expect(resizeCrop(crop, "e", 10, 99)).toEqual({ x: 20, y: 10, w: 60, h: 80 });
    expect(resizeCrop(crop, "w", 5, 99)).toEqual({ x: 25, y: 10, w: 45, h: 80 });
    expect(resizeCrop(crop, "n", 99, -5)).toEqual({ x: 20, y: 5, w: 50, h: 85 });
    expect(resizeCrop(crop, "s", 99, 2)).toEqual({ x: 20, y: 10, w: 50, h: 82 });
    expect(resizeCrop(crop, "nw", 10, 10)).toEqual({ x: 30, y: 20, w: 40, h: 70 });
    expect(resizeCrop(crop, "se", -10, -10)).toEqual({ x: 20, y: 10, w: 40, h: 70 });
  });

  it("stays inside the file, so the core's image-crop-outside check cannot fire", () => {
    expect(resizeCrop(crop, "e", 500, 0)).toEqual({ x: 20, y: 10, w: 80, h: 80 });
    expect(resizeCrop(crop, "w", -500, 0)).toEqual({ x: 0, y: 10, w: 70, h: 80 });
    expect(resizeCrop(crop, "s", 0, 500)).toEqual({ x: 20, y: 10, w: 50, h: 90 });
    expect(resizeCrop(crop, "n", 0, -500)).toEqual({ x: 20, y: 0, w: 50, h: 90 });
  });

  it("keeps at least 5 percent a side, whichever way an edge is pushed", () => {
    expect(resizeCrop(crop, "e", -500, 0)).toEqual({ x: 20, y: 10, w: 5, h: 80 });
    expect(resizeCrop(crop, "w", 500, 0)).toEqual({ x: 65, y: 10, w: 5, h: 80 });
    expect(resizeCrop(crop, "n", 0, 500)).toEqual({ x: 20, y: 85, w: 50, h: 5 });
    expect(resizeCrop(crop, "se", -500, -500)).toEqual({ x: 20, y: 10, w: 5, h: 5 });
  });

  it("rounds to hundredths with the right edge exactly where it is said to be", () => {
    const moved = resizeCrop({ x: 12.345, y: 0, w: 87.655, h: 100 }, "w", 0.0001, 0);
    expect(moved.x + moved.w).toBeCloseTo(100, 10);
    expect(moved.x).toBe(12.35);
    const odd = resizeCrop({ x: 0, y: 0, w: 100, h: 100 }, "w", 33.333, 0);
    expect(odd.x + odd.w).toBeCloseTo(100, 10);
  });
});

describe("moving the picture under the crop", () => {
  it("moves the crop by the amount asked and never out of the file", () => {
    const crop = { x: 20, y: 10, w: 50, h: 80 };
    expect(panCrop(crop, 5, -5)).toEqual({ x: 25, y: 5, w: 50, h: 80 });
    expect(panCrop(crop, 500, 500)).toEqual({ x: 50, y: 20, w: 50, h: 80 });
    expect(panCrop(crop, -500, -500)).toEqual({ x: 0, y: 0, w: 50, h: 80 });
  });

  it("does nothing to a crop of the whole file", () => {
    expect(panCrop(FULL, 10, 10)).toEqual(FULL);
  });
});

describe("fitting a box to its picture", () => {
  const square = { w: 100, h: 100 };

  it("keeps the width and sets the height to the picture's shape", () => {
    // 2 to 1 on a 16 by 9 slide: 40 percent across is 768 px, so the box is 384 px high, which is 35.6 percent.
    expect(fitBox({ x: 10, y: 10, w: 40, h: 30 }, { w: 200, h: 100 }, FULL)).toEqual({
      x: 10,
      y: 10,
      w: 40,
      h: 35.6,
    });
    // A square is 40 percent across and 71.1 percent down.
    expect(fitBox({ x: 10, y: 10, w: 40, h: 30 }, square, FULL)).toEqual({ x: 10, y: 10, w: 40, h: 71.1 });
  });

  it("follows the crop, since that is the part that shows", () => {
    // Half the width of a 2 to 1 file is a square.
    expect(fitBox({ x: 10, y: 10, w: 40, h: 30 }, { w: 200, h: 100 }, { x: 0, y: 0, w: 50, h: 100 }).h).toBe(
      71.1,
    );
  });

  it("shrinks both when the new height would leave the slide", () => {
    // Only 20 percent is left under the box, so the height is 20 and the width follows: 20 * 9 / 16 = 11.25.
    expect(fitBox({ x: 10, y: 80, w: 40, h: 10 }, square, FULL)).toEqual({ x: 10, y: 80, w: 11.3, h: 20 });
  });
});

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;
const SCENE = "method";
const IMAGE = "method-diagram";

beforeEach(async () => {
  server = new FakeServer();
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select(SCENE);
});
afterEach(() => {
  end();
  editor.destroy();
  vi.restoreAllMocks();
});

const image = () => {
  const block = store.session.doc.scenes[SCENE]?.blocks.find((candidate) => candidate.id === IMAGE);
  if (block?.type !== "image") throw new Error("the demo deck should have a picture here");
  return block;
};
const scene = () => store.session.doc.scenes[SCENE];
const find = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const choose = () => find(`.ed-frame [data-id='${IMAGE}']`)?.click();
const tool = (name: string) => find(`.ed-toolbar [data-tb='${name}']`) as HTMLButtonElement;
const set = (changes: Record<string, unknown>) => {
  const result = store.session.apply([{ op: "block.set", scene: SCENE, id: IMAGE, set: changes }]);
  if (!result.ok) throw new Error("the change should be accepted");
};

describe("the image toolbar", () => {
  it("has Crop, a Fill toggle and Reset picture, and none of them on other blocks", () => {
    choose();
    expect([tool("crop"), tool("fill"), tool("reset")].map((node) => node.textContent)).toEqual([
      "Crop",
      "Fill",
      "Reset picture",
    ]);
    find<HTMLElement>("[data-id='method-body'] [data-edit], [data-id='method-body'][data-edit]")?.focus();
    expect(find(".ed-toolbar [data-tb='crop']")).toBeNull();
  });

  it("writes fit when Fill is pressed, shows it pressed, and takes it off when pressed again", () => {
    choose();
    // A picture outside a slot is shown whole until it is told to fill.
    expect(tool("fill").getAttribute("aria-pressed")).toBe("false");
    tool("fill").click();
    expect(image().fit).toBe("cover");
    expect(tool("fill").getAttribute("aria-pressed")).toBe("true");
    tool("fill").click();
    // Back to what it does when it says nothing, so nothing is written for it.
    expect(image().fit).toBeUndefined();
    expect(tool("fill").getAttribute("aria-pressed")).toBe("false");
  });

  it("resets the fit, the crop and the focus in one change that Undo takes back whole", () => {
    set({ fit: "cover", crop: { x: 10, y: 10, w: 50, h: 50 }, focus: { x: 20, y: 30 } });
    choose();
    expect(tool("reset").disabled).toBe(false);
    tool("reset").click();
    expect(image().fit).toBeUndefined();
    expect(image().crop).toBeUndefined();
    expect(image().focus).toBeUndefined();
    expect(tool("reset").disabled).toBe(true);
    store.session.undo();
    expect(image().fit).toBe("cover");
    expect(image().crop).toEqual({ x: 10, y: 10, w: 50, h: 50 });
    expect(image().focus).toEqual({ x: 20, y: 30 });
  });

  it("has nothing to reset on a picture that was never changed", () => {
    choose();
    expect(tool("reset").disabled).toBe(true);
  });
});

describe("the Edit popover", () => {
  const edit = () => {
    tool("edit").click();
    return find(".ed-toolbar [data-tb='edit']")?.closest(".ed-tb-chip-wrap") as HTMLElement;
  };
  const box = (root: HTMLElement) =>
    root.querySelector("[data-field='image:decorative']") as HTMLInputElement;

  it("marks a picture decorative and unmarks it, and keeps the alt text while it is", () => {
    choose();
    const root = edit();
    const alt = (parent: HTMLElement) => parent.querySelector("[data-field='image:alt']") as HTMLInputElement;
    const text = image().alt;
    expect(alt(root).disabled).toBe(false);
    box(root).click();
    expect(image().decorative).toBe(true);
    expect(image().alt).toBe(text);
    expect(alt(edit().parentElement as HTMLElement).disabled).toBe(true);
    box(find(".ed-toolbar") as HTMLElement).click();
    expect(image().decorative).toBeUndefined();
    expect(image().alt).toBe(text);
  });

  it("lets a decorative picture lose its alt text without a problem", () => {
    choose();
    set({ decorative: true, alt: "x" });
    store.session.apply([{ op: "block.set", scene: SCENE, id: IMAGE, set: { alt: null } }]);
    expect(image().decorative).toBe(true);
    expect(image().alt).toBeUndefined();
  });
});

describe("the menu and the palette", () => {
  const menuFor = (selector: string) => {
    find(selector)?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }),
    );
    return [...host.querySelectorAll(".ed-menu:not([hidden]) .ed-menu-item")].map((node) =>
      (node.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
  };

  it("lists the picture's commands for an image and none for other blocks", () => {
    const labels = menuFor(`.ed-frame [data-id='${IMAGE}']`);
    expect(labels).toEqual(expect.arrayContaining(["Crop", "Fit", "Fill", "Use as slide background"]));
    expect(labels).not.toContain("Reset picture");
    expect(labels).not.toContain("Remove background");
    expect(labels).not.toContain("Fit box to picture");
  });

  it("offers Reset picture once the picture has a fit, a crop or a focus", () => {
    set({ focus: { x: 40, y: 40 } });
    expect(menuFor(`.ed-frame [data-id='${IMAGE}']`)).toContain("Reset picture");
  });

  it("offers Remove background only on a slide that has one, and Use as slide background only on an image", () => {
    store.session.apply([
      {
        op: "scene.set",
        id: SCENE,
        set: { background: { asset: image().asset, scrim: 40, decorative: true } },
      },
    ]);
    expect(menuFor(`.ed-frame [data-id='${IMAGE}']`)).toContain("Remove background");
    const others = menuFor(".ed-frame [data-id='method-body']");
    expect(others).not.toContain("Use as slide background");
    expect(others).toContain("Remove background");
  });

  it("finds them in the palette by name", () => {
    choose();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    const names = [...host.querySelectorAll<HTMLElement>(".ed-palette [data-command]")].map(
      (node) => node.dataset.command,
    );
    expect(names).toEqual(
      expect.arrayContaining(["picture-crop", "picture-fit", "picture-fill", "picture-bg"]),
    );
  });
});

describe("using a picture as the slide's background", () => {
  const blocksBefore = () => scene()?.blocks.map((block) => block.id);

  it("moves the picture to the background in one undo step, keeping its alt text and focus", () => {
    set({ focus: { x: 30, y: 60 }, alt: "A diagram of the method" });
    const before = blocksBefore();
    const asset = image().asset;
    choose();
    run(
      {
        session: store.session,
        canvas: { element: host, nodeOf: () => undefined },
        hooks: {
          edits: { act: (ops) => store.session.apply(ops), type: (ops) => store.session.apply(ops) },
          problem() {},
          focusBlock() {},
        },
        scene: SCENE,
      },
      "bg",
      IMAGE,
    );
    expect(blocksBefore()).toEqual(before?.filter((id) => id !== IMAGE));
    expect(scene()?.background).toEqual({
      asset,
      scrim: 40,
      alt: "A diagram of the method",
      focus: { x: 30, y: 60 },
    });
    store.session.undo();
    expect(blocksBefore()).toEqual(before);
    expect(scene()?.background).toBeUndefined();
  });

  it("carries the decorative mark, and removing the background is one change", () => {
    set({ decorative: true });
    const hooks = {
      edits: {
        act: (ops: never) => store.session.apply(ops),
        type: (ops: never) => store.session.apply(ops),
      },
      problem() {},
      focusBlock() {},
    };
    const picture = {
      session: store.session,
      canvas: { element: host, nodeOf: () => undefined },
      hooks,
      scene: SCENE,
    };
    run(picture, "bg", IMAGE);
    expect(scene()?.background?.decorative).toBe(true);
    run(picture, "nobg", "");
    expect(scene()?.background).toBeUndefined();
    store.session.undo();
    expect(scene()?.background?.decorative).toBe(true);
  });
});

describe("crop mode", () => {
  /** The sizes crop mode needs, since nothing is laid out here: a 1000 by 500 stage and a picture drawn in 400 by 200. */
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
  let stage: HTMLElement;
  let problems: Array<string | undefined>;
  let focused: string[];

  const begin = (block: Record<string, unknown> = {}) => {
    set({ crop: { x: 20, y: 10, w: 50, h: 80 }, ...block });
    stage = document.createElement("div");
    document.body.append(stage);
    const node = document.createElement("figure");
    node.innerHTML = `<span class="dc-crop"><span class="dc-crop-in"><img src="assets/x.png" alt=""></span></span>`;
    const img = node.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 800 });
    Object.defineProperty(img, "naturalHeight", { value: 400 });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === stage) return rect(0, 0, 1000, 500);
      if (this.classList.contains("dc-crop") || this.classList.contains("dc-crop-in"))
        return rect(100, 100, 400, 200);
      return rect(0, 0, 0, 0);
    });
    problems = [];
    focused = [];
    run(
      {
        session: store.session,
        canvas: { element: stage, nodeOf: () => node },
        hooks: {
          edits: { act: (ops) => store.session.apply(ops), type: (ops) => store.session.apply(ops) },
          problem: (text) => problems.push(text),
          focusBlock: (id) => focused.push(id),
        },
        scene: SCENE,
      },
      "crop",
      IMAGE,
    );
  };
  const layer = () => stage.querySelector(".ed-crop") as HTMLElement;
  const part = (name: string) => layer().querySelector(`[data-h='${name}']`) as HTMLElement;
  const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }),
    );
  const pointer = (target: EventTarget, type: string, x: number, y: number) =>
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
    );
  const spokenSteps = () => stage.querySelector(".ed-crop-say")?.textContent;

  it("draws the whole file where the picture is, the crop window over it, and a handle on each edge and corner", () => {
    begin();
    const file = layer().querySelector(".ed-crop-file") as HTMLElement;
    // The crop is 50 percent of a file that is 800 px wide on the slide, and its left edge is where the picture's is.
    expect(file.style.width).toBe("80%");
    expect(file.style.height).toBe("50%");
    expect(file.style.left).toBe("-6%");
    expect(file.style.top).toBe("15%");
    const win = layer().querySelector(".ed-crop-win") as HTMLElement;
    expect([win.style.left, win.style.top, win.style.width, win.style.height]).toEqual([
      "10%",
      "20%",
      "40%",
      "40%",
    ]);
    expect([...layer().querySelectorAll("[data-h]")].map((node) => node.getAttribute("aria-label"))).toEqual([
      "The picture inside the crop. Arrow keys move it.",
      "Top edge of the crop",
      "Top-right corner of the crop",
      "Right edge of the crop",
      "Bottom-right corner of the crop",
      "Bottom edge of the crop",
      "Bottom-left corner of the crop",
      "Left edge of the crop",
      "Top-left corner of the crop",
    ]);
    expect(layer().querySelector("[data-h='focus']")).toBeNull();
    expect(spokenSteps()).toContain("Crop mode");
  });

  it("drags a handle and commits on Enter as one change that Undo takes back whole", () => {
    begin();
    const handle = part("e");
    pointer(handle, "pointerdown", 500, 200);
    // 80 px is a tenth of the file, which is 800 px wide.
    pointer(window, "pointermove", 580, 200);
    pointer(window, "pointerup", 580, 200);
    expect(image().crop).toEqual({ x: 20, y: 10, w: 50, h: 80 });
    expect(spokenSteps()).toBe("Crop 60 by 80 percent, from 20 across and 10 down.");
    key(handle, "Enter");
    expect(image().crop).toEqual({ x: 20, y: 10, w: 60, h: 80 });
    expect(layer()).toBeNull();
    expect(focused).toEqual([IMAGE]);
    store.session.undo();
    expect(image().crop).toEqual({ x: 20, y: 10, w: 50, h: 80 });
  });

  it("moves the picture under the crop when the inside is dragged", () => {
    begin();
    const win = part("pan");
    pointer(win, "pointerdown", 300, 200);
    pointer(window, "pointermove", 380, 150);
    pointer(window, "pointerup", 380, 150);
    // The picture goes 80 px right and 50 px up, so the crop goes a tenth of the file left and a fifth down, which
    // would run past the file's foot, so it stops there.
    key(win, "Enter");
    expect(image().crop).toEqual({ x: 10, y: 20, w: 50, h: 80 });
  });

  it("is cancelled by Escape, with nothing written and the keyboard back on the block", () => {
    begin();
    key(part("n"), "ArrowDown", { shiftKey: true });
    key(part("n"), "Escape");
    expect(layer()).toBeNull();
    expect(image().crop).toEqual({ x: 20, y: 10, w: 50, h: 80 });
    expect(focused).toEqual([IMAGE]);
  });

  it("commits on a click outside the window, and not on the toolbar", () => {
    begin();
    key(part("w"), "ArrowRight", { shiftKey: true });
    const bar = document.createElement("div");
    bar.className = "ed-toolbar";
    document.body.append(bar);
    pointer(bar, "pointerdown", 5, 5);
    expect(layer()).not.toBeNull();
    pointer(document.body, "pointerdown", 5, 5);
    expect(layer()).toBeNull();
    expect(image().crop).toEqual({ x: 30, y: 10, w: 40, h: 80 });
  });

  it("moves the focused handle by 1 percent with an arrow key and by 10 with Shift", () => {
    begin();
    key(part("e"), "ArrowRight");
    expect(spokenSteps()).toContain("Crop 51 by 80");
    key(part("se"), "ArrowDown", { shiftKey: true });
    expect(spokenSteps()).toContain("Crop 51 by 90");
    key(part("pan"), "ArrowLeft");
    key(part("pan"), "Enter");
    // The picture moved one percent left, so the crop moved one percent right.
    expect(image().crop).toEqual({ x: 21, y: 10, w: 51, h: 90 });
  });

  it("does not let an arrow key push a handle past the file or below the smallest crop", () => {
    begin({ crop: { x: 90, y: 0, w: 10, h: 100 } });
    key(part("e"), "ArrowRight", { shiftKey: true });
    key(part("w"), "ArrowRight", { shiftKey: true });
    key(part("w"), "ArrowRight", { shiftKey: true });
    key(part("w"), "Enter");
    expect(image().crop).toEqual({ x: 95, y: 0, w: 5, h: 100 });
  });

  it("shows a focus point on a picture that fills its box, and writes it with the crop", () => {
    begin({ fit: "cover" });
    const mark = part("focus");
    expect(mark.getAttribute("aria-label")).toBe("Focus point");
    key(mark, "ArrowRight", { shiftKey: true });
    key(mark, "ArrowUp");
    key(mark, "Enter");
    expect(image().focus).toEqual({ x: 60, y: 49 });
    expect(image().crop).toEqual({ x: 20, y: 10, w: 50, h: 80 });
    // The crop and the focus were one change.
    store.session.undo();
    expect(image().focus).toBeUndefined();
  });

  it("writes the focus and the crop in the same change when both moved", () => {
    begin({ fit: "cover" });
    key(part("e"), "ArrowLeft", { shiftKey: true });
    key(part("focus"), "ArrowLeft", { shiftKey: true });
    key(part("focus"), "Enter");
    expect(image().crop).toEqual({ x: 20, y: 10, w: 40, h: 80 });
    expect(image().focus).toEqual({ x: 40, y: 50 });
    store.session.undo();
    expect(image().crop).toEqual({ x: 20, y: 10, w: 50, h: 80 });
    expect(image().focus).toBeUndefined();
  });

  it("writes nothing when nothing changed, and takes the crop off when it is the whole file again", () => {
    begin();
    const rev = store.session.rev;
    key(part("pan"), "Enter");
    expect(store.session.rev).toBe(rev);
    begin();
    key(part("nw"), "ArrowUp", { shiftKey: true });
    key(part("nw"), "ArrowLeft", { shiftKey: true });
    key(part("nw"), "ArrowLeft", { shiftKey: true });
    key(part("se"), "ArrowRight", { shiftKey: true });
    key(part("se"), "ArrowRight", { shiftKey: true });
    key(part("se"), "ArrowRight", { shiftKey: true });
    key(part("se"), "ArrowDown", { shiftKey: true });
    key(part("se"), "Enter");
    expect(image().crop).toBeUndefined();
  });

  it("stops when the deck changes under it, such as an undo, without writing", () => {
    begin();
    key(part("e"), "ArrowRight");
    set({ caption: "A new caption" });
    expect(layer()).toBeNull();
    expect(image().crop).toEqual({ x: 20, y: 10, w: 50, h: 80 });
  });

  it("says why when the picture is not drawn yet", () => {
    stage = document.createElement("div");
    problems = [];
    run(
      {
        session: store.session,
        canvas: { element: stage, nodeOf: () => undefined },
        hooks: {
          edits: { act: (ops) => store.session.apply(ops), type: (ops) => store.session.apply(ops) },
          problem: (text) => problems.push(text),
          focusBlock() {},
        },
        scene: SCENE,
      },
      "crop",
      IMAGE,
    );
    expect(problems.join()).toContain("not drawn yet");
    expect(stage.querySelector(".ed-crop")).toBeNull();
  });
});

describe("the Background section of the Scene popover", () => {
  const section = () => {
    find(".ed-scene-tools [data-tb='scene']")?.click();
    const details = find<HTMLDetailsElement>("details[data-section='background']") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    return details;
  };
  const field = (name: string) => find(`[data-field='bg:${name}']`) as HTMLInputElement & HTMLSelectElement;
  const background = () => scene()?.background;
  const file = () =>
    [...store.session.doc.assets].sort().find((path) => /\.(png|jpe?g|svg|webp)$/.test(path));

  it("starts with only a file to choose, and a chosen file is a decorative background under a 40 percent scrim", () => {
    section();
    expect(find("[data-field='bg:scrim']")).toBeNull();
    const choice = field("asset");
    choice.value = file() as string;
    choice.dispatchEvent(new Event("change", { bubbles: true }));
    expect(background()).toEqual({ asset: file(), scrim: 40, decorative: true });
    // One choice, one undo step.
    store.session.undo();
    expect(background()).toBeUndefined();
  });

  it("changes the scrim, the color and the focus one change at a time, and leaves the color out for the default", () => {
    store.session.apply([
      {
        op: "scene.set",
        id: SCENE,
        set: { background: { asset: file() as string, scrim: 40, decorative: true } },
      },
    ]);
    section();
    field("scrim").value = "65";
    field("scrim").dispatchEvent(new Event("input", { bubbles: true }));
    expect(background()?.scrim).toBe(65);
    field("color").value = "surface";
    field("color").dispatchEvent(new Event("change", { bubbles: true }));
    expect(background()?.color).toBe("surface");
    field("color").value = "bg";
    field("color").dispatchEvent(new Event("change", { bubbles: true }));
    expect(background()?.color).toBeUndefined();
    field("focus-y").value = "20";
    field("focus-y").dispatchEvent(new Event("input", { bubbles: true }));
    expect(background()?.focus).toEqual({ x: 50, y: 20 });
    expect([...field("color").options].map((option) => option.value)).toEqual([
      "bg",
      "surface",
      "text",
      "action",
      "evidence",
    ]);
  });

  it("asks for alt text when it is not decorative, and keeps it while it is", () => {
    store.session.apply([
      {
        op: "scene.set",
        id: SCENE,
        set: { background: { asset: file() as string, scrim: 40, decorative: true } },
      },
    ]);
    section();
    expect(find("[data-field='bg:alt']")).toBeNull();
    field("decorative").click();
    expect(background()?.decorative).toBeUndefined();
    // The schema needs alt text, so it starts as the file's name, to be written over.
    expect(background()?.alt).toBeTruthy();
    const alt = field("alt");
    expect(alt.disabled).toBe(false);
    alt.value = "A grid of colored squares";
    alt.dispatchEvent(new Event("input", { bubbles: true }));
    expect(background()?.alt).toBe("A grid of colored squares");
    field("decorative").click();
    expect(background()).toMatchObject({ decorative: true, alt: "A grid of colored squares" });
  });

  it("removes the background with its button", () => {
    store.session.apply([
      {
        op: "scene.set",
        id: SCENE,
        set: { background: { asset: file() as string, scrim: 40, decorative: true } },
      },
    ]);
    section();
    field("remove").click();
    expect(background()).toBeUndefined();
    store.session.undo();
    expect(background()?.scrim).toBe(40);
  });
});
