// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restingBox, snap, standings } from "../src/snap.ts";

const rect = (left: number, top: number) =>
  ({
    left,
    top,
    width: 100,
    height: 50,
    right: left + 100,
    bottom: top + 50,
    x: left,
    y: top,
    toJSON() {},
  }) as DOMRect;

let root: HTMLElement;
const node = () => root.querySelector<HTMLElement>("[data-id='a']") as HTMLElement;

beforeEach(() => {
  const part = (className: string, id?: string) => {
    const made = document.createElement("p");
    made.className = className;
    if (id) made.dataset.id = id;
    return made;
  };
  root = document.createElement("div");
  // A pinned block, one in its slot, the hidden copy a pinned block leaves, and a part that is not a block.
  root.append(part("dc-block dc-pinned", "a"), part("dc-block", "b"), part("dc-ghost"), part("", "c"));
  document.body.replaceChildren(root);
});
afterEach(() => {
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("where the blocks of a slide stand", () => {
  it("is read for every block with an id, and says which are pinned", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect(30, 40));
    expect([...standings(root)]).toEqual([
      ["a", { pinned: true, left: 30, top: 40 }],
      ["b", { pinned: false, left: 30, top: 40 }],
    ]);
  });
});

describe("a browser that cannot animate", () => {
  it("leaves the blocks where they are and raises nothing", () => {
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect(160, 450));
    expect(() => snap(root, new Map([["a", { pinned: false, left: 800, top: 100 }]]))).not.toThrow();
  });
});

describe("the box of a block that is sliding", () => {
  /** A slide the way a browser has it: the box on the screen is the old one until the slide has run its length. */
  function slide() {
    const animation = { playState: "running", currentTime: 0 as number | null };
    let started = false;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() =>
      started && animation.currentTime !== 220 ? rect(800, 100) : rect(160, 450),
    );
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      writable: true,
      value() {
        started = true;
        return animation;
      },
    });
    snap(root, new Map([["a", { pinned: false, left: 800, top: 100 }]]));
    return animation;
  }

  it("is where it rests, and the slide is left as it was", () => {
    const animation = slide();
    animation.currentTime = 40;
    expect(node().getBoundingClientRect().left).toBe(800);
    expect(restingBox(node()).left).toBe(160);
    expect(restingBox(node()).top).toBe(450);
    expect(animation.currentTime).toBe(40);
  });

  it("is the box on the screen once the slide is over", () => {
    const animation = slide();
    animation.playState = "finished";
    expect(restingBox(node()).left).toBe(800);
  });

  it("is the box on the screen for a block that never slid", () => {
    slide();
    expect(restingBox(root.querySelector<HTMLElement>("[data-id='b']") as HTMLElement).left).toBe(800);
  });
});
