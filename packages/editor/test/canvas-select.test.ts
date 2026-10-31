// @vitest-environment happy-dom
import { createSession, loadDoc, type Session } from "@depthcue/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type Canvas, createCanvas } from "../src/canvas.ts";
import { FakeServer } from "./helpers.ts";

let session: Session;
let canvas: Canvas;
let picked: string[];

beforeEach(() => {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo should load");
  session = createSession(doc);
  picked = [];
  canvas = createCanvas(session, { hint: () => undefined, select: (id) => picked.push(id) });
  document.body.replaceChildren(canvas.element);
});

const pickers = () => [...canvas.element.querySelectorAll<HTMLElement>("[data-pick]")];
const picker = (id: string) => pickers().find((node) => node.dataset.id === id) as HTMLElement;
const textBox = (id: string) =>
  [...canvas.element.querySelectorAll<HTMLElement>("[data-edit]")].find(
    (node) => (node.closest("[data-id]") as HTMLElement | null)?.dataset.id === id,
  ) as HTMLElement;
const keydown = (node: Element, key: string) =>
  node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const marked = () =>
  [...canvas.element.querySelectorAll<HTMLElement>("[data-selected]")].map((node) => node.dataset.id);

describe("choosing blocks that have no text", () => {
  it("makes each image, chart and clip a button that says what it is, and leaves text alone", () => {
    canvas.render("method");
    expect(pickers().map((node) => node.dataset.id)).toEqual(["method-diagram"]);
    const node = picker("method-diagram");
    expect(node.getAttribute("role")).toBe("button");
    expect(node.tabIndex).toBe(0);
    expect(node.getAttribute("aria-label")).toMatch(/^Image: Diagram: orders from.*Select to edit\.$/);
    canvas.render("demand");
    expect(picker("chart-demand").getAttribute("aria-label")).toBe(
      "Chart: Share of orders, latest quarter. Select to edit.",
    );
    expect(pickers().some((candidate) => candidate.matches("[data-edit]"))).toBe(false);
  });

  it("selects the block when it is clicked, or when Enter or Space is pressed on it", () => {
    canvas.render("method");
    const node = picker("method-diagram");
    node.click();
    keydown(node, "Enter");
    keydown(node, " ");
    expect(picked).toEqual(["method-diagram", "method-diagram", "method-diagram"]);
  });

  it("ignores other keys, and keys pressed on something inside the block", () => {
    canvas.render("method");
    const node = picker("method-diagram");
    keydown(node, "a");
    keydown(node, "Tab");
    keydown(node.firstElementChild as Element, "Enter");
    expect(picked).toEqual([]);
  });

  it("stops Space from scrolling the page when it selects", () => {
    canvas.render("method");
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    picker("method-diagram").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("selects a block when its text is focused, and the claim when that is focused", () => {
    canvas.render("demand");
    const claim = session.doc.scenes.demand?.summary?.id as string;
    textBox(claim).focus();
    expect(picked).toEqual([claim]);
    canvas.render("opening");
    textBox("opening-sub").focus();
    expect(picked.at(-1)).toBe("opening-sub");
  });
});

describe("marking the selection", () => {
  it("marks the selected block when a scene is drawn", () => {
    canvas.render("method", "method-body");
    expect(marked()).toEqual(["method-body"]);
  });

  it("moves the mark without redrawing, and clears it", () => {
    canvas.render("method");
    const before = canvas.element.firstElementChild;
    expect(marked()).toEqual([]);
    canvas.mark("method-heading");
    expect(marked()).toEqual(["method-heading"]);
    canvas.mark("method-diagram");
    expect(marked()).toEqual(["method-diagram"]);
    canvas.mark(undefined);
    expect(marked()).toEqual([]);
    expect(canvas.element.firstElementChild).toBe(before);
  });

  it("marks nothing for an id the scene does not have", () => {
    canvas.render("method", "nope");
    expect(marked()).toEqual([]);
  });

  it("keeps a picked block focused when the scene is redrawn", () => {
    canvas.render("method");
    const node = picker("method-diagram");
    node.focus();
    canvas.render("method");
    const again = picker("method-diagram");
    expect(again).not.toBe(node);
    expect(document.activeElement).toBe(again);
  });
});
