// @vitest-environment happy-dom
import { type Block, memoryDraftStore, type NewScene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { createCanvas } from "../src/canvas.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

const text = (id: string): Block => ({ id, type: "text", role: "body", text: id });

const order: NewScene = {
  id: "order",
  title: "Order",
  layout: "claim-evidence",
  summary: { id: "order-claim", text: "A claim", evidenceIds: ["order-a"] },
  blocks: [text("order-a"), text("order-b"), text("order-c")],
  steps: [
    { id: "order-s1", reveal: ["order-claim"] },
    { id: "order-s2", reveal: ["order-a", "order-b"] },
  ],
};
// Three blocks named round and round in the most steps a scene holds, and a fourth that no step names.
const crammed: NewScene = {
  id: "crammed",
  title: "Crammed",
  layout: "title",
  blocks: [text("c-0"), text("c-1"), text("c-2"), text("c-extra")],
  steps: Array.from({ length: 24 }, (_, i) => ({ id: `c-step-${i}`, reveal: [`c-${i % 3}`] })),
};

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

beforeEach(async () => {
  server = new FakeServer();
  store = await openStore(server, () => memoryDraftStore());
  const added = store.session.apply([order, crammed].map((scene) => ({ op: "scene.add" as const, scene })));
  if (!added.ok) throw new Error(JSON.stringify(added.diagnostics));
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select("order");
});
afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
});

const toggle = () => host.querySelector<HTMLButtonElement>("[data-quick='build']") as HTMLButtonElement;
const badges = () => [...host.querySelectorAll<HTMLButtonElement>(".ed-badge")];
const badge = (id: string) => {
  const found = badges().find((node) => node.dataset.badge === id);
  if (!found) throw new Error(`no badge for ${id}`);
  return found;
};
const menu = () => host.querySelector<HTMLElement>(".ed-build-menu");
const choices = () => [...(menu()?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']") ?? [])];
const choice = (label: string) => {
  const found = choices().find((node) => node.textContent === label);
  if (!found) throw new Error(`no choice called ${label}`);
  return found;
};
const stepsOf = (id: string) =>
  (store.session.doc.scenes[id]?.steps ?? []).map((step) => [step.id, ...step.reveal]);
const numbers = () => badges().map((node) => node.textContent);
const hintText = () => host.querySelector(".ed-hint")?.textContent ?? "";

describe("the build order button", () => {
  it("is in the quick bar, off, and shows no badges until it is pressed", () => {
    expect(toggle().closest(".ed-quick")).not.toBeNull();
    expect(toggle().textContent).toBe("Build order");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(badges()).toHaveLength(0);
  });

  it("shows a badge beside the claim and each block, in reading order, when it is pressed", () => {
    toggle().click();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(badges().map((node) => node.dataset.badge)).toEqual([
      "order-claim",
      "order-a",
      "order-b",
      "order-c",
    ]);
  });

  it("numbers a badge by the step that shows its part, and gives a part there from the start a dot", () => {
    toggle().click();
    expect(numbers()).toEqual(["1", "2", "2", "•"]);
    expect(badge("order-c").hasAttribute("data-step")).toBe(false);
    expect(badge("order-a").dataset.step).toBe("2");
  });

  it("says in words what each badge means, for a screen reader", () => {
    toggle().click();
    expect(badge("order-claim").getAttribute("aria-label")).toBe(
      "The claim: appears at step 1. Change when it appears.",
    );
    expect(badge("order-c").getAttribute("aria-label")).toMatch(/there from the start/);
    expect(badge("order-c").getAttribute("aria-haspopup")).toBe("menu");
  });

  it("puts the badges away when it is pressed again", () => {
    toggle().click();
    toggle().click();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(badges()).toHaveLength(0);
  });

  it("stays on from one scene to the next, and shows the dots of a scene that has no steps", () => {
    toggle().click();
    editor.select("method");
    expect(badges().length).toBeGreaterThan(0);
    expect(new Set(numbers())).toEqual(new Set(["•"]));
  });

  it("changes nothing in the deck by being shown", () => {
    const before = store.session.rev;
    toggle().click();
    expect(store.session.rev).toBe(before);
  });
});

describe("choosing when a part appears", () => {
  beforeEach(() => toggle().click());

  it("opens a list of the places it could go, with the present one marked", () => {
    badge("order-a").click();
    expect(menu()).not.toBeNull();
    expect(choices().map((node) => node.textContent)).toEqual([
      "From the start",
      "Step 1",
      "Step 2",
      "A new step",
    ]);
    expect(choices().map((node) => node.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
      "false",
    ]);
    expect(badge("order-a").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(choice("Step 2"));
  });

  it("names the part the list is about", () => {
    badge("order-claim").click();
    expect(menu()?.getAttribute("aria-label")).toBe("When The claim appears");
  });

  it("marks the start for a part that has none", () => {
    badge("order-c").click();
    expect(choice("From the start").getAttribute("aria-checked")).toBe("true");
  });

  it("puts a part with a step that is there, as one undo step", () => {
    badge("order-c").click();
    choice("Step 1").click();
    expect(stepsOf("order")).toEqual([
      ["order-s1", "order-claim", "order-c"],
      ["order-s2", "order-a", "order-b"],
    ]);
    expect(numbers()).toEqual(["1", "2", "2", "1"]);
    expect(menu()).toBeNull();
    store.session.undo();
    expect(stepsOf("order")).toEqual([
      ["order-s1", "order-claim"],
      ["order-s2", "order-a", "order-b"],
    ]);
    expect(numbers()).toEqual(["1", "2", "2", "•"]);
  });

  it("takes a part back to the start, and the steps after an emptied one count one less", () => {
    badge("order-claim").click();
    choice("From the start").click();
    expect(stepsOf("order")).toEqual([["order-s2", "order-a", "order-b"]]);
    expect(numbers()).toEqual(["•", "1", "1", "•"]);
  });

  it("gives a part a step of its own", () => {
    badge("order-a").click();
    choice("A new step").click();
    expect(stepsOf("order")).toEqual([
      ["order-s1", "order-claim"],
      ["order-s2", "order-b"],
      ["order-step-3", "order-a"],
    ]);
    expect(numbers()).toEqual(["1", "3", "2", "•"]);
  });

  it("changes nothing, and adds no undo step, when the present place is chosen", () => {
    const before = store.session.doc.scenes.order;
    badge("order-a").click();
    choice("Step 2").click();
    expect(store.session.doc.scenes.order).toBe(before);
    expect(menu()).toBeNull();
    // The last step on the undo stack is still the one that added the scene.
    store.session.undo();
    expect(store.session.doc.scenes.order).toBeUndefined();
  });

  it("keeps the keyboard on the badge that was used, which is drawn again", () => {
    badge("order-c").click();
    choice("Step 1").click();
    expect(document.activeElement).toBe(badge("order-c"));
    expect(document.activeElement?.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes with Escape and gives the keyboard back to the badge", () => {
    badge("order-a").click();
    choice("Step 2").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(badge("order-a"));
    expect(badge("order-a").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps Escape to the list, so nothing else on the page hears it", () => {
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    try {
      badge("order-a").click();
      choice("Step 2").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } finally {
      document.removeEventListener("keydown", heard);
    }
    expect(heard).not.toHaveBeenCalled();
  });

  it("closes when a press lands anywhere else", () => {
    badge("order-a").click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeNull();
  });

  it("stays open for a press inside it", () => {
    badge("order-a").click();
    menu()?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu()).not.toBeNull();
  });

  it("closes when its own badge is pressed again", () => {
    badge("order-a").click();
    badge("order-a").click();
    expect(menu()).toBeNull();
  });

  it("moves to another badge's list when that badge is pressed", () => {
    badge("order-a").click();
    badge("order-b").click();
    expect(host.querySelectorAll(".ed-build-menu")).toHaveLength(1);
    expect(badge("order-a").getAttribute("aria-expanded")).toBe("false");
    expect(badge("order-b").getAttribute("aria-expanded")).toBe("true");
  });

  it("closes the list when the mode is turned off", () => {
    badge("order-a").click();
    toggle().click();
    expect(menu()).toBeNull();
  });

  it("closes the list when the scene changes under it", () => {
    badge("order-a").click();
    editor.select("method");
    expect(menu()).toBeNull();
  });

  it("opens again for the same badge after the slide was drawn again under an open list", () => {
    badge("order-a").click();
    editor.select("order");
    expect(menu()).toBeNull();
    badge("order-a").click();
    expect(menu()).not.toBeNull();
  });

  it("does not let go of the chosen block when a badge is pressed", () => {
    host
      .querySelector<HTMLElement>("[data-id='order-b'] [data-edit], [data-id='order-b'][data-edit]")
      ?.focus();
    expect(editor.blockId).toBe("order-b");
    badge("order-a").click();
    expect(editor.blockId).toBe("order-b");
  });
});

describe("what is refused", () => {
  beforeEach(() => {
    editor.select("crammed");
    toggle().click();
  });

  it("says a scene holds at most 24 steps, and changes nothing", () => {
    const before = store.session.doc.scenes.crammed;
    badge("c-extra").click();
    choice("A new step").click();
    expect(store.session.doc.scenes.crammed).toBe(before);
    expect(hintText()).toMatch(/at most 24 steps/);
    expect(host.querySelector(".ed-hint")?.hasAttribute("data-problem")).toBe(true);
  });

  it("clears the line when a later choice works", () => {
    badge("c-extra").click();
    choice("A new step").click();
    badge("c-extra").click();
    choice("Step 24").click();
    expect(hintText()).toBe("");
    expect(store.session.doc.scenes.crammed?.steps?.at(-1)?.reveal).toEqual(["c-2", "c-extra"]);
  });

  it("lists every step the scene has", () => {
    badge("c-0").click();
    expect(choices()).toHaveLength(26);
  });
});

describe("where the badges sit", () => {
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

  it("lies over the grips, so a list that opens across one gets the press, and under the toolbar", () => {
    const layers = [...(host.querySelector(".ed-overlay")?.children ?? [])].map((node) => node.className);
    const build = layers.indexOf("ed-build");
    expect(build).toBeGreaterThan(layers.indexOf("ed-grips"));
    expect(build).toBeLessThan(layers.findIndex((name) => name.includes("ed-toolbar")));
  });

  it("puts each badge just right of its part and level with its top, in the slide's own coordinates", () => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("ed-canvas-host")) return box(100, 50, 800, 450);
      if (this.dataset.id === "order-a") return box(160, 120, 300, 40);
      if (this.dataset.id === "order-b") return box(160, 200, 300, 40);
      return real.call(this);
    });
    toggle().click();
    expect(badge("order-a").style.left).toBe("368px");
    expect(badge("order-a").style.top).toBe("70px");
    expect(badge("order-b").style.top).toBe("150px");
  });

  it("keeps a badge inside the slide when its part reaches the right edge", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("ed-canvas-host")) return box(0, 0, 400, 300);
      if (this.dataset.id === "order-a") return box(20, 20, 380, 40);
      return box(0, 0, 0, 0);
    });
    toggle().click();
    const left = Number.parseFloat(badge("order-a").style.left);
    expect(left).toBeLessThanOrEqual(400);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it("hides a badge whose part has left the slide, and puts the others where they were", () => {
    toggle().click();
    host.querySelector("[data-id='order-c']")?.removeAttribute("data-id");
    // Typing in a field places everything against the slide again.
    host
      .querySelector<HTMLElement>("[data-id='order-a'] [data-edit], [data-id='order-a'][data-edit]")
      ?.dispatchEvent(new Event("input", { bubbles: true }));
    expect(badge("order-c").hidden).toBe(true);
    expect(badge("order-a").hidden).toBe(false);
  });
});

describe("a canvas on its own", () => {
  it("shows badges for a scene and none once the scene is gone", () => {
    const canvas = createCanvas(store.session, { hint: () => {}, select: () => {} });
    document.body.append(canvas.element);
    canvas.setBuild(true);
    canvas.render("order");
    expect(canvas.element.querySelectorAll(".ed-badge")).toHaveLength(4);
    canvas.render("missing");
    expect(canvas.element.querySelectorAll(".ed-badge")).toHaveLength(0);
    canvas.destroy();
  });
});
