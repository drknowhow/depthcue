// @vitest-environment happy-dom
import { type Block, checkDoc, memoryDraftStore, type Op, placeholderAlt } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { problemsOf } from "../src/ribbon.ts";
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
afterEach(() => editor.destroy());

const ribbon = () => host.querySelector<HTMLElement>(".ed-ribbon") as HTMLElement;
const part = (name: string) =>
  ribbon().querySelector<HTMLButtonElement>(`[data-ribbon='${name}']`) as HTMLButtonElement;
const count = () => ribbon().querySelector(".ed-ribbon-count")?.textContent;
const place = () => ribbon().querySelector(".ed-ribbon-place")?.textContent;
const said = () => ribbon().querySelector("[role='status']") as HTMLElement;
const method = () => store.session.doc.scenes.method?.blocks ?? [];
const diagram = () =>
  method().find((block) => block.id === "method-diagram") as Extract<Block, { type: "image" }>;

const apply = (...ops: Op[]) => {
  const result = store.session.apply(ops);
  if (!result.ok) throw new Error(`the change should apply: ${JSON.stringify(result)}`);
};
/** The picture on the method scene goes back to saying the name of its file. */
const unDescribe = (): Op => ({
  op: "block.set",
  scene: "method",
  id: "method-diagram",
  set: { alt: placeholderAlt(diagram().asset) },
});
/** The chart on the demand scene stops saying where its numbers come from. */
const uncite: Op = { op: "block.set", scene: "demand", id: "chart-demand", set: { sourceIds: null } };
const recite: Op = {
  op: "block.set",
  scene: "demand",
  id: "chart-demand",
  set: { sourceIds: ["source-report"] },
};
/** The body text on the method scene is pinned into the 4% margin at the left. */
const pinned: Op = {
  op: "block.frame",
  scene: "method",
  id: "method-body",
  frame: { x: 1, y: 30, w: 40, h: 20 },
};

describe("the problem ribbon", () => {
  it("sits between the top bar and the slide, and says all clear for a deck with nothing to check", () => {
    const app = host.querySelector(".ed-app") as HTMLElement;
    const order = [...app.children].map((node) => node.className.split(" ")[0]);
    expect(order.indexOf("ed-ribbon")).toBeGreaterThan(order.indexOf("ed-bar"));
    expect(order.indexOf("ed-ribbon")).toBeLessThan(order.indexOf("ed-scenes"));
    expect(ribbon().dataset.state).toBe("clear");
    expect(count()).toBe("All clear");
    expect(place()).toBe("");
    expect(part("show").hidden).toBe(true);
    expect(part("fix").hidden).toBe(true);
    expect(ribbon().querySelector<HTMLElement>(".ed-ribbon-nav")?.hidden).toBe(true);
    expect(said().textContent).toBe("All clear. Nothing to check on any slide.");
  });

  it("lists a picture whose alt text is still its file name, in the words `depthcue check` uses, with no Fix", () => {
    apply(unDescribe());
    expect(ribbon().dataset.state).toBe("problems");
    expect(count()).toBe("1 thing to check");
    const [warning] = checkDoc(store.session.doc).filter((d) => d.severity === "warning");
    expect(warning?.code).toBe("alt-is-filename");
    expect(part("show").textContent).toBe(warning?.message);
    // The line is cut short on a wide window when it is long, so the tooltip has all of it.
    expect(part("show").title).toBe(warning?.message);
    // Writing a description needs a person, so there is nothing for a button to do.
    expect(part("fix").hidden).toBe(true);
    expect(said().textContent).toContain("1 thing to check. 1 of 1.");
  });

  it("has a problem for every warning the core gives, and none of its own", () => {
    apply(unDescribe(), uncite, pinned);
    const warnings = checkDoc(store.session.doc).filter((d) => d.severity === "warning");
    expect(problemsOf(store.session).map((problem) => problem.text)).toEqual(
      ["demand", "method"].flatMap((id) =>
        warnings.filter((d) => d.file === `scenes/${id}.json`).map((d) => d.message),
      ),
    );
    expect(warnings.map((d) => d.code).sort()).toEqual([
      "alt-is-filename",
      "frame-outside-safe-area",
      "missing-source",
    ]);
  });

  it("names the scene when the problem is on another one", () => {
    apply(unDescribe());
    expect(part("show").textContent?.startsWith("Method")).toBe(false);
    editor.select("opening");
    const title = store.session.doc.scenes.method?.title;
    expect(part("show").textContent?.startsWith(`${title}: `)).toBe(true);
  });

  it("walks the problems of every scene with Next and Previous, choosing the scene and the block", () => {
    apply(unDescribe(), uncite);
    expect(count()).toBe("2 things to check");
    expect(place()).toBe("1 of 2");
    part("next").click();
    expect(place()).toBe("2 of 2");
    expect([editor.sceneId, editor.blockId]).toEqual(["method", "method-diagram"]);
    part("next").click();
    expect(place()).toBe("1 of 2");
    expect([editor.sceneId, editor.blockId]).toEqual(["demand", "chart-demand"]);
    part("previous").click();
    expect(place()).toBe("2 of 2");
    expect([editor.sceneId, editor.blockId]).toEqual(["method", "method-diagram"]);
  });

  it("has nothing to walk with one problem, and the buttons say so", () => {
    apply(unDescribe());
    expect(part("next").disabled).toBe(true);
    expect(part("previous").disabled).toBe(true);
    part("next").click();
    expect(editor.blockId).toBeUndefined();
  });

  it("takes the person to the problem's block when its sentence is pressed", () => {
    apply(unDescribe());
    editor.select("opening");
    part("show").click();
    expect([editor.sceneId, editor.blockId]).toEqual(["method", "method-diagram"]);
  });

  it("puts the keyboard in the block when its sentence is pressed, and not when Next is", () => {
    apply(pinned, uncite);
    editor.select("demand");
    part("next").focus();
    part("next").click();
    expect(editor.blockId).toBe("method-body");
    expect(document.activeElement).toBe(part("next"));
    part("show").click();
    expect(document.activeElement?.closest("[data-id='method-body']")).not.toBeNull();
  });

  it("stays on the same problem when one before it is settled, though it is now the first", () => {
    apply(unDescribe(), uncite, pinned);
    expect(count()).toBe("3 things to check");
    part("next").click();
    expect(place()).toBe("2 of 3");
    const second = part("show").textContent;
    // The first of the three, on the demand scene, is settled. The one we are on moves up to first place.
    apply(recite);
    expect(count()).toBe("2 things to check");
    expect(place()).toBe("1 of 2");
    expect(part("show").textContent).toBe(second);
  });

  it("stays on its problem while others are settled around it", () => {
    apply(unDescribe(), uncite);
    part("next").click();
    expect(place()).toBe("2 of 2");
    apply(recite);
    expect(count()).toBe("1 thing to check");
    expect(part("show").textContent).toContain("alt text");
    expect(ribbon().querySelector<HTMLElement>(".ed-ribbon-nav")?.hidden).toBe(true);
    // Settling the last one is what clears it.
    apply({
      op: "block.set",
      scene: "method",
      id: "method-diagram",
      set: { alt: "The four steps of the method" },
    });
    expect(ribbon().dataset.state).toBe("clear");
  });

  it("offers Back to layout for a pinned block in the margin, and it is one undo step", () => {
    apply(pinned);
    expect(part("fix").hidden).toBe(false);
    expect(part("fix").textContent).toBe("Back to layout");
    expect(part("show").textContent).toContain("margin");
    part("fix").click();
    expect(method().find((block) => block.id === "method-body")?.frame).toBeUndefined();
    expect(ribbon().dataset.state).toBe("clear");
    store.session.undo();
    expect(method().find((block) => block.id === "method-body")?.frame).toEqual(pinned.frame);
    expect(part("fix").hidden).toBe(false);
  });

  it("changes text and visibility in place, so a control is the same node before and after an edit", () => {
    const names = ["previous", "next", "show", "fix"];
    const before = [...names.map(part), ribbon().querySelector(".ed-ribbon-count")];
    apply(unDescribe(), uncite, pinned);
    apply(recite);
    const after = [...names.map(part), ribbon().querySelector(".ed-ribbon-count")];
    for (const [i, node] of before.entries()) expect(after[i]).toBe(node);
  });

  it("does not repeat to a screen reader what it already said", () => {
    apply(unDescribe());
    const seen = new MutationObserver(() => {});
    seen.observe(said(), { childList: true, characterData: true, subtree: true });
    // A new title changes the deck and none of the problems.
    apply({ op: "scene.set", id: "opening", set: { title: "A different opening" } });
    expect(seen.takeRecords()).toEqual([]);
    apply({ op: "block.set", scene: "method", id: "method-diagram", set: { alt: "The four steps" } });
    expect(seen.takeRecords().length).toBeGreaterThan(0);
    seen.disconnect();
  });

  it("is a status the screen reader hears and not a region that holds the buttons", () => {
    expect(said().getAttribute("aria-live")).toBe("polite");
    expect(ribbon().contains(said())).toBe(true);
    expect(said().querySelector("button")).toBeNull();
    expect(part("previous").getAttribute("aria-label")).toBe("Previous problem");
    expect(part("next").getAttribute("aria-label")).toBe("Next problem");
  });
});
