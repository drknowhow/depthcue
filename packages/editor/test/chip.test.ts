// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { fitPopover } from "../src/chip.ts";

const bounds = { left: 0, right: 400, top: 0, bottom: 600 };

/** A popover whose box is the one given, as the browser would measure it with `left` and the height limit reset. */
function popover(box: { left: number; top: number; width: number; height: number }) {
  const pop = document.createElement("div");
  pop.getBoundingClientRect = () =>
    ({
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      width: box.width,
      height: box.height,
    }) as DOMRect;
  return pop;
}

describe("fitting a popover to the room it has", () => {
  it("leaves one that fits where it is", () => {
    const pop = popover({ left: 20, top: 50, width: 300, height: 200 });
    fitPopover(pop, bounds, false);
    expect(pop.style.maxHeight).toBe("");
    expect(pop.hasAttribute("data-up")).toBe(false);
  });

  it("slides one that overhangs the right edge back in", () => {
    const pop = popover({ left: 250, top: 50, width: 300, height: 200 });
    fitPopover(pop, bounds, false);
    expect(pop.style.left).toBe("-150px");
  });

  it("slides one that overhangs the left edge back in", () => {
    const pop = popover({ left: -30, top: 50, width: 300, height: 200 });
    fitPopover(pop, bounds, false);
    expect(pop.style.left).toBe("30px");
  });

  it("shortens one that is taller than the room below it", () => {
    const pop = popover({ left: 20, top: 50, width: 300, height: 700 });
    fitPopover(pop, bounds, false);
    // 550 px lie between its top and the bottom edge, less 8 px of margin.
    expect(pop.style.maxHeight).toBe("542px");
  });

  it("opens upward and counts the room above its chip", () => {
    const pop = popover({ left: 20, top: -300, width: 300, height: 700 });
    fitPopover(pop, bounds, true);
    expect(pop.hasAttribute("data-up")).toBe(true);
    // The popover ends at 400, which leaves 400 px above it down to the top edge, less 8 px of margin.
    expect(pop.style.maxHeight).toBe("392px");
  });

  it("clears a height limit it set before when the popover has shrunk", () => {
    const pop = popover({ left: 20, top: 50, width: 300, height: 200 });
    pop.style.maxHeight = "300px";
    fitPopover(pop, bounds, false);
    expect(pop.style.maxHeight).toBe("");
  });
});
