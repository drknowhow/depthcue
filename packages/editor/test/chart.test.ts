// @vitest-environment happy-dom
import { type Block, createSession, loadDoc, type Session } from "@depthcue/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type Canvas, createCanvas } from "../src/canvas.ts";
import { addedRow, snapped, sortedRows, stepsOf } from "../src/chart.ts";
import { FakeServer } from "./helpers.ts";

let session: Session;
let canvas: Canvas;
let hints: Array<{ text: string; problem: boolean }>;
let picked: string[];
let deselected: number;
/** The pointers a bar asked the browser to keep sending to it, so a drag goes on when the pointer leaves the bar. */
let captured: number[];

// The demo's chart: Channel A at 40 and Channel B at 60, in percent.
const chart = () => {
  const block = session.doc.scenes.demand?.blocks.find((candidate) => candidate.id === "chart-demand");
  if (block?.type !== "bar-chart") throw new Error("the chart should be there");
  return block as Extract<Block, { type: "bar-chart" }>;
};
const values = () => chart().data.map((row) => row.value);
const bars = () => [...canvas.element.querySelectorAll<HTMLElement>(".dc-bar")];
const labelCells = () => [...canvas.element.querySelectorAll<HTMLElement>('th[scope="row"]')];
const readouts = () =>
  [...canvas.element.querySelectorAll<HTMLElement>(".dc-value")].map((n) => n.textContent);
const width = (bar: HTMLElement) => Number(bar.style.getPropertyValue("--w"));

/** Happy-dom lays nothing out, so a bar is given the width the stylesheet would give it: 380px for the largest. */
function lay(node: HTMLElement) {
  Object.defineProperty(node, "offsetWidth", { configurable: true, get: () => width(node) * 380 });
  node.setPointerCapture = (id) => {
    captured.push(id);
  };
}

function draw() {
  canvas.render("demand");
  for (const bar of bars()) lay(bar);
}

beforeEach(() => {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo should load");
  session = createSession(doc);
  hints = [];
  picked = [];
  deselected = 0;
  captured = [];
  canvas = createCanvas(session, {
    hint: (text, problem) => hints.push({ text, problem }),
    select: (id) => picked.push(id),
    deselect: () => {
      deselected += 1;
    },
  });
  document.body.replaceChildren(canvas.element);
  draw();
});

function pointer(node: HTMLElement, type: string, x: number, init: PointerEventInit = {}) {
  node.dispatchEvent(
    new PointerEvent(type, {
      clientX: x,
      button: 0,
      isPrimary: true,
      pointerId: 1,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}
const press = (node: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
function type(node: HTMLElement, text: string) {
  node.textContent = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the bars of a chart", () => {
  it("are sliders named for their row, with the value as the audience reads it", () => {
    const [first, second] = bars() as [HTMLElement, HTMLElement];
    expect(first.getAttribute("role")).toBe("slider");
    expect(first.getAttribute("aria-label")).toBe("Channel A");
    expect(first.getAttribute("aria-valuenow")).toBe("40");
    expect(first.getAttribute("aria-valuetext")).toBe("40%");
    expect(first.getAttribute("aria-valuemin")).toBe("0");
    expect(second.getAttribute("aria-valuetext")).toBe("60%");
    expect(first.tabIndex).toBe(0);
    expect(first.hasAttribute("aria-hidden")).toBe(false);
  });

  it("do not make the chart a button, which may not hold a slider", () => {
    const figure = canvas.nodeOf("chart-demand");
    expect(figure?.getAttribute("role")).toBe("group");
  });

  it("choose the chart when the keyboard reaches one", () => {
    (bars()[0] as HTMLElement).focus();
    expect(picked).toContain("chart-demand");
  });
});

describe("dragging a bar", () => {
  // 380px stand for 60, so 95px is 15.
  it("sets the row's value from how far the pointer moved, a bar at a time", () => {
    const first = bars()[0] as HTMLElement;
    pointer(first, "pointerdown", 100);
    pointer(first, "pointermove", 195);
    expect(values()).toEqual([55, 60]);
    expect(readouts()).toEqual(["55%", "60%"]);
    expect(first.getAttribute("aria-valuenow")).toBe("55");
    pointer(first, "pointerup", 195);
    expect(values()).toEqual([55, 60]);
  });

  it("is one undo step however far it goes", () => {
    const first = bars()[0] as HTMLElement;
    pointer(first, "pointerdown", 100);
    for (const x of [130, 160, 195, 290]) pointer(first, "pointermove", x);
    pointer(first, "pointerup", 290);
    expect(values()).toEqual([70, 60]);
    expect(session.undo()).toBe(true);
    expect(values()).toEqual([40, 60]);
    expect(session.canUndo).toBe(false);
  });

  it("keeps the bar it is dragging, and scales the rest to it only when it lets go", () => {
    const [first, second] = bars() as [HTMLElement, HTMLElement];
    pointer(first, "pointerdown", 100);
    pointer(first, "pointermove", 290);
    expect(bars()[0]).toBe(first);
    // Held at the scale it started with, so the bar follows the pointer: 70 of 60.
    expect(width(first)).toBeCloseTo(70 / 60);
    expect(width(second)).toBeCloseTo(1);
    pointer(first, "pointerup", 290);
    expect(width(first)).toBe(1);
    expect(width(second)).toBeCloseTo(60 / 70);
  });

  it("marks the bar while it is held, with a mark of its own: the strip dims what has data-dragging", () => {
    const first = bars()[0] as HTMLElement;
    pointer(first, "pointerdown", 100);
    expect(first.hasAttribute("data-sliding")).toBe(true);
    expect(first.hasAttribute("data-dragging")).toBe(false);
    pointer(first, "pointerup", 100);
    expect(first.hasAttribute("data-sliding")).toBe(false);
  });

  it("never takes a value below nothing", () => {
    const first = bars()[0] as HTMLElement;
    pointer(first, "pointerdown", 400);
    pointer(first, "pointermove", -2000);
    expect(values()[0]).toBe(0);
  });

  it("keeps the precision the chart has: whole numbers stay whole", () => {
    const first = bars()[0] as HTMLElement;
    pointer(first, "pointerdown", 100);
    pointer(first, "pointermove", 143);
    expect(Number.isInteger(values()[0])).toBe(true);
  });

  it("changes nothing for a move that rounds to the same value", () => {
    const first = bars()[0] as HTMLElement;
    pointer(first, "pointerdown", 100);
    pointer(first, "pointermove", 102);
    expect(values()).toEqual([40, 60]);
    expect(session.canUndo).toBe(false);
  });

  it("stops following the pointer once it is let go, or taken away", () => {
    const first = bars()[0] as HTMLElement;
    pointer(first, "pointerdown", 100);
    pointer(first, "pointerup", 100);
    pointer(first, "pointermove", 290);
    expect(values()).toEqual([40, 60]);
    pointer(first, "pointerdown", 100);
    pointer(first, "pointercancel", 100);
    pointer(first, "pointermove", 290);
    expect(values()).toEqual([40, 60]);
  });

  it("ignores any button but the main one, and a second finger", () => {
    const first = bars()[0] as HTMLElement;
    pointer(first, "pointerdown", 100, { button: 2 });
    pointer(first, "pointermove", 290);
    pointer(first, "pointerdown", 100, { isPrimary: false });
    pointer(first, "pointermove", 290);
    expect(values()).toEqual([40, 60]);
  });

  it("chooses the chart", () => {
    pointer(bars()[0] as HTMLElement, "pointerdown", 100);
    expect(picked).toContain("chart-demand");
  });

  it("asks the browser to keep the pointer, so the drag goes on outside the bar", () => {
    pointer(bars()[0] as HTMLElement, "pointerdown", 100, { pointerId: 7 });
    expect(captured).toEqual([7]);
  });

  it("starts from nothing when every bar is nothing, a full bar standing for one hundred", () => {
    session.apply([
      {
        op: "block.set",
        scene: "demand",
        id: "chart-demand",
        set: {
          data: [
            { label: "Channel A", value: 0 },
            { label: "Channel B", value: 0 },
          ],
        },
      },
    ]);
    draw();
    const first = bars()[0] as HTMLElement;
    // Nothing is wide enough to measure, so the cell stands in: 76% of 500px is 380px for 100.
    Object.defineProperty(first.parentElement, "clientWidth", { configurable: true, value: 500 });
    pointer(first, "pointerdown", 0);
    pointer(first, "pointermove", 190);
    expect(values()[0]).toBe(50);
  });
});

describe("the keyboard on a bar", () => {
  it("adds and takes away one step with the arrows, and five with Shift", () => {
    const first = bars()[0] as HTMLElement;
    first.focus();
    press(first, "ArrowRight");
    expect(values()[0]).toBe(41);
    press(first, "ArrowUp");
    expect(values()[0]).toBe(42);
    press(first, "ArrowRight", { shiftKey: true });
    expect(values()[0]).toBe(47);
    press(first, "ArrowLeft");
    press(first, "ArrowDown");
    expect(values()[0]).toBe(45);
    press(first, "ArrowLeft", { shiftKey: true });
    expect(values()[0]).toBe(40);
  });

  it("goes to nothing with Home and to the largest value with End", () => {
    const first = bars()[0] as HTMLElement;
    first.focus();
    press(first, "Home");
    expect(values()[0]).toBe(0);
    press(first, "End");
    expect(values()[0]).toBe(60);
  });

  it("stops at nothing", () => {
    const first = bars()[0] as HTMLElement;
    first.focus();
    press(first, "Home");
    press(first, "ArrowLeft", { shiftKey: true });
    expect(values()[0]).toBe(0);
  });

  it("is one undo step for a visit, and a new one when it comes back", () => {
    const first = bars()[0] as HTMLElement;
    first.focus();
    press(first, "ArrowRight");
    press(first, "ArrowRight");
    press(first, "ArrowRight", { shiftKey: true });
    first.blur();
    first.focus();
    press(first, "ArrowLeft");
    expect(values()[0]).toBe(46);
    session.undo();
    expect(values()[0]).toBe(47);
    session.undo();
    expect(values()[0]).toBe(40);
    expect(session.canUndo).toBe(false);
  });

  it("keeps each bar's changes apart", () => {
    const [first, second] = bars() as [HTMLElement, HTMLElement];
    first.focus();
    press(first, "ArrowRight");
    second.focus();
    press(second, "ArrowLeft");
    expect(values()).toEqual([41, 59]);
    session.undo();
    expect(values()).toEqual([41, 60]);
  });

  it("leaves Control, Alt and Meta shortcuts to the page, so undo still works", () => {
    const first = bars()[0] as HTMLElement;
    first.focus();
    press(first, "ArrowRight", { ctrlKey: true });
    press(first, "ArrowRight", { altKey: true });
    press(first, "ArrowRight", { metaKey: true });
    expect(values()).toEqual([40, 60]);
  });

  it("brings the bar and its readout up to date as it goes", () => {
    const first = bars()[0] as HTMLElement;
    first.focus();
    press(first, "ArrowRight", { shiftKey: true });
    expect(readouts()[0]).toBe("45%");
    expect(first.getAttribute("aria-valuetext")).toBe("45%");
    expect(width(first)).toBeCloseTo(45 / 60);
  });

  it("lets go of the choice on Escape", () => {
    const first = bars()[0] as HTMLElement;
    first.focus();
    press(first, "Escape");
    expect(deselected).toBe(1);
    expect(document.activeElement).not.toBe(first);
  });

  it("keeps the keyboard on the same bar when the slide is drawn again, as after an undo", () => {
    const [, second] = bars() as [HTMLElement, HTMLElement];
    second.focus();
    press(second, "ArrowRight");
    session.undo();
    canvas.render("demand");
    expect(document.activeElement).toBe(bars()[1]);
  });

  it("does nothing for other keys", () => {
    const first = bars()[0] as HTMLElement;
    first.focus();
    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    first.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(values()).toEqual([40, 60]);
  });
});

describe("the labels of a chart", () => {
  it("are text boxes on the slide, named for their bar", () => {
    const [first] = labelCells() as [HTMLElement];
    expect(first.getAttribute("role")).toBe("textbox");
    expect(first.getAttribute("aria-label")).toBe("Bar 1 label");
    expect(first.tabIndex).toBe(0);
    expect(labelCells()).toHaveLength(2);
  });

  it("change the row's label as they are typed", () => {
    const [first] = labelCells() as [HTMLElement];
    first.focus();
    type(first, "Direct");
    expect(chart().data[0]).toEqual({ label: "Direct", value: 40 });
    expect(hints.at(-1)).toEqual({ text: "Bar 1 label 6 of 40", problem: false });
  });

  it("leave the other rows as they were", () => {
    const [, second] = labelCells() as [HTMLElement, HTMLElement];
    second.focus();
    type(second, "Partners");
    expect(chart().data).toEqual([
      { label: "Channel A", value: 40 },
      { label: "Partners", value: 60 },
    ]);
  });

  it("refuse an empty label, and say why", () => {
    const [first] = labelCells() as [HTMLElement];
    first.focus();
    type(first, "");
    expect(chart().data[0]?.label).toBe("Channel A");
    expect(hints.at(-1)).toEqual({ text: "A bar needs a label.", problem: true });
    expect(first.hasAttribute("data-invalid")).toBe(true);
    first.blur();
    expect(first.textContent).toBe("Channel A");
  });

  it("refuse a label of more than forty characters, and say by how many", () => {
    const [first] = labelCells() as [HTMLElement];
    first.focus();
    type(first, "x".repeat(43));
    expect(chart().data[0]?.label).toBe("Channel A");
    expect(hints.at(-1)).toEqual({ text: "3 over the limit of 40.", problem: true });
  });

  it("are one undo step for a visit to a label", () => {
    const [first] = labelCells() as [HTMLElement];
    first.focus();
    type(first, "D");
    type(first, "Di");
    type(first, "Direct");
    expect(session.undo()).toBe(true);
    expect(chart().data[0]?.label).toBe("Channel A");
    expect(session.canUndo).toBe(false);
  });

  it("keep two labels' typing apart", () => {
    const [first, second] = labelCells() as [HTMLElement, HTMLElement];
    first.focus();
    type(first, "One");
    second.focus();
    type(second, "Two");
    session.undo();
    expect(chart().data.map((row) => row.label)).toEqual(["One", "Channel B"]);
  });

  it("do not mistake a chart's label for its text", () => {
    expect(canvas.element.querySelectorAll("[data-edit]").length).toBeGreaterThan(labelCells().length);
  });
});

describe("the row helpers", () => {
  const rows = [
    { label: "A", value: 2 },
    { label: "B", value: 5 },
    { label: "C", value: 3 },
  ];

  it("add a bar named for its place, at nothing", () => {
    expect(addedRow(rows).at(-1)).toEqual({ label: "Item 4", value: 0 });
    expect(addedRow(rows)).toHaveLength(4);
    expect(rows).toHaveLength(3);
  });

  it("sort largest first, and then smallest first", () => {
    const down = sortedRows(rows);
    expect(down.map((row) => row.label)).toEqual(["B", "C", "A"]);
    expect(sortedRows(down).map((row) => row.label)).toEqual(["A", "C", "B"]);
  });

  it("find the precision a chart already uses, up to three places", () => {
    const of = (...numbers: number[]) => stepsOf(numbers.map((value) => ({ label: "x", value }))).places;
    expect(of(40, 60)).toBe(0);
    expect(of(0.5, 2)).toBe(1);
    expect(of(1.25, 3)).toBe(2);
    expect(of(0.1234, 1)).toBe(3);
    expect(of(1.1, 2.2)).toBe(1);
  });

  it("nudge by about a hundredth of the largest, as 1, 2 or 5 of a power of ten", () => {
    const of = (...numbers: number[]) => stepsOf(numbers.map((value) => ({ label: "x", value }))).nudge;
    expect(of(40, 60)).toBe(1);
    expect(of(3, 5)).toBe(1);
    expect(of(0, 0)).toBe(1);
    expect(of(100, 250)).toBe(2);
    expect(of(600, 120)).toBe(5);
    expect(of(1200, 14000)).toBe(100);
    expect(of(0.5, 2.25)).toBe(0.02);
    expect(of(0.5, 0.75)).toBe(0.01);
  });

  it("snap to the chart's precision and never below nothing", () => {
    expect(snapped(0.1 + 0.2, 3)).toBe(0.3);
    expect(snapped(41.7, 0)).toBe(42);
    expect(snapped(-5, 0)).toBe(0);
  });
});
