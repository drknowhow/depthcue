// @vitest-environment happy-dom
import { type CommentOp, memoryDraftStore, type Op, placeholderAlt } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { problemsOf } from "../src/ribbon.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { newScene } from "../src/templates.ts";
import { FakeServer, retitle } from "./helpers.ts";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

async function mount(seed: CommentOp[] = [], ...agent: Op[][]) {
  server = new FakeServer();
  if (seed.length > 0) server.externalComment(seed);
  for (const ops of agent) server.agentEdit(ops);
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select("method");
  await vi.waitFor(() => {
    expect(store.comments.state.ready).toBe(true);
    expect(store.review.state.ready).toBe(true);
  });
}

beforeEach(() => mount());
afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
});

const note = (text: string, over: { scene?: string; ask?: boolean } = {}): CommentOp => ({
  op: "comment.add",
  scene: over.scene ?? "method",
  block: over.scene === "opening" ? "opening-title" : "method-body",
  anchor: { x: 0.25, y: 0.5 },
  author: "you",
  text,
  ...(over.ask ? { ask: true } : {}),
});

const press = (node: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  return event;
};
const until = async (test: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await new Promise((done) => setTimeout(done, 10));
  expect(test()).toBe(true);
};

const opener = () => host.querySelector<HTMLButtonElement>("[data-action='storyboard']") as HTMLButtonElement;
const board = () => host.querySelector<HTMLElement>(".ed-board") as HTMLElement;
const cards = () => [...board().querySelectorAll<HTMLLIElement>(".ed-card")];
const order = () => cards().map((li) => li.dataset.id);
const card = (id: string) =>
  board().querySelector<HTMLLIElement>(`.ed-card[data-id='${id}']`) as HTMLLIElement;
const pick = (id: string) => card(id).querySelector<HTMLButtonElement>(".ed-card-pick") as HTMLButtonElement;
const pills = (id: string) => [...card(id).querySelectorAll<HTMLElement>(".ed-pill")];
const said = (id: string) => pills(id).map((pill) => pill.textContent);
const pillOf = (id: string, kind: string) =>
  card(id).querySelector<HTMLElement>(`.ed-pill[data-kind='${kind}']`) as HTMLElement;
const frames = () => board().querySelectorAll(".ed-thumb-frame");
const apply = (...ops: Op[]) => {
  const result = store.session.apply(ops);
  if (!result.ok) throw new Error(`the change should apply: ${JSON.stringify(result)}`);
};
const open = () => opener().click();
const search = (words: string) => {
  press(document, "k", { ctrlKey: true });
  const palette = host.querySelector<HTMLElement>(".ed-palette") as HTMLElement;
  const input = palette.querySelector("input") as HTMLInputElement;
  input.value = words;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  press(input, "Enter");
};

describe("opening and closing", () => {
  it("is shut until it is asked for, and the strip has a button that asks", () => {
    expect(board().hidden).toBe(true);
    expect(opener().textContent).toContain("Storyboard");
    expect(host.querySelector(".ed-scenes")?.firstElementChild).toBe(opener());
    open();
    expect(board().hidden).toBe(false);
    expect(board().getAttribute("role")).toBe("dialog");
    expect(board().getAttribute("aria-modal")).toBe("true");
    expect(board().querySelector("h2")?.textContent).toBe("Storyboard");
    expect(board().querySelector(".ed-board-count")?.textContent).toBe("3 scenes");
  });

  it("opens on the G key, and from the palette", () => {
    const event = press(document, "g");
    expect(event.defaultPrevented).toBe(true);
    expect(board().hidden).toBe(false);
    press(document.activeElement as Element, "Escape");
    expect(board().hidden).toBe(true);
    search("storyboard");
    expect(board().hidden).toBe(false);
  });

  it("does not open on a G typed into a field", () => {
    const field = document.createElement("input");
    host.append(field);
    press(field, "g");
    expect(board().hidden).toBe(true);
  });

  it("closes on Esc, and hands the keyboard back to what opened it", () => {
    opener().focus();
    open();
    expect(document.activeElement).not.toBe(opener());
    const event = press(document.activeElement as Element, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(board().hidden).toBe(true);
    expect(document.activeElement).toBe(opener());
  });

  it("closes on Esc when the keyboard is on nothing in particular", () => {
    open();
    (document.activeElement as HTMLElement).blur();
    press(document.body, "Escape");
    expect(board().hidden).toBe(true);
  });

  it("closes on the button that goes back to the slide", () => {
    opener().focus();
    open();
    const back = board().querySelector<HTMLButtonElement>("[data-action='close-storyboard']");
    expect(back?.textContent).toBe("Back to the slide");
    back?.click();
    expect(board().hidden).toBe(true);
    expect(document.activeElement).toBe(opener());
  });

  it("keeps the scene on show when it closes without choosing one", () => {
    open();
    press(document.activeElement as Element, "Escape");
    expect(editor.sceneId).toBe("method");
  });

  it("makes the rest of the editor unreachable while it is up, and gives it back after", () => {
    const others = () => [...(board().parentElement?.children ?? [])].filter((node) => node !== board());
    const notices = host.querySelector(".ed-notices") as HTMLElement;
    notices.setAttribute("inert", ""); // something that was inert already stays inert
    open();
    expect(others().every((node) => node.hasAttribute("inert"))).toBe(true);
    expect(board().hasAttribute("inert")).toBe(false);
    press(document.activeElement as Element, "Escape");
    expect(others().filter((node) => node.hasAttribute("inert"))).toEqual([notices]);
  });

  it("only gives back what it made inert, each time, and not what something else made inert since", () => {
    const notices = host.querySelector(".ed-notices") as HTMLElement;
    open();
    press(document.activeElement as Element, "Escape");
    expect(notices.hasAttribute("inert")).toBe(false);
    notices.setAttribute("inert", "");
    open();
    press(document.activeElement as Element, "Escape");
    expect(notices.hasAttribute("inert")).toBe(true);
  });

  it("lets go of its cards when it closes, and builds new ones when it opens", () => {
    open();
    expect(cards()).toHaveLength(3);
    const before = card("method");
    press(document.activeElement as Element, "Escape");
    expect(cards()).toHaveLength(0);
    open();
    expect(cards()).toHaveLength(3);
    expect(card("method")).not.toBe(before);
  });

  it("opens only once however many times it is asked, and a close with nothing open does nothing", () => {
    opener().focus();
    open();
    const first = card("method");
    open();
    expect(card("method")).toBe(first);
    press(document.activeElement as Element, "Escape");
    // Asking again did not make the board's own card the place the keyboard goes back to.
    expect(document.activeElement).toBe(opener());
    press(document.body, "Escape");
    expect(board().hidden).toBe(true);
  });

  it("starts on the scene on show each time it opens, not where the keyboard was when it closed", () => {
    open();
    press(document.activeElement as Element, "ArrowLeft");
    expect((document.activeElement as HTMLElement).closest("li")?.dataset.id).toBe("demand");
    press(document.activeElement as Element, "Escape");
    editor.select("opening");
    open();
    expect((document.activeElement as HTMLElement).closest("li")?.dataset.id).toBe("opening");
  });

  it("stops hearing keys when the editor is taken down while it is open", () => {
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    open();
    editor.destroy();
    press(document.body, "x");
    document.removeEventListener("keydown", heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("the cards", () => {
  it("are one for each scene, numbered, with its title", () => {
    open();
    expect(order()).toEqual(["opening", "demand", "method"]);
    const titles = order().map((id) => store.session.doc.scenes[id as string]?.title);
    expect(cards().map((li) => li.querySelector(".ed-card-name")?.textContent)).toEqual(titles);
    expect(cards().map((li) => li.querySelector(".ed-card-number")?.textContent)).toEqual(["1", "2", "3"]);
  });

  it("give a screen reader the scene, its lead and what is waiting on it, in one name", () => {
    open();
    const title = store.session.doc.scenes.method?.title;
    expect(pick("method").getAttribute("aria-label")).toBe(`Scene 3, ${title}. Lead: Human.`);
  });

  it("mark the scene on show, and follow it when another is chosen", () => {
    open();
    expect(pick("method").getAttribute("aria-current")).toBe("true");
    expect(card("method").hasAttribute("data-current")).toBe(true);
    expect(pick("opening").getAttribute("aria-current")).toBe("false");
    expect(card("opening").hasAttribute("data-current")).toBe(false);
    editor.select("demand");
    expect(pick("demand").getAttribute("aria-current")).toBe("true");
    expect(pick("method").getAttribute("aria-current")).toBe("false");
  });

  it("draw each scene's real content, inert and hidden from assistive tech, the scene on show first", async () => {
    // A frame at a time, so what is drawn first can be seen.
    const waiting: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => waiting.push(callback));
    open();
    expect(frames()).toHaveLength(0);
    waiting.shift()?.(0);
    expect(card("method").querySelector(".ed-thumb-frame")).not.toBeNull();
    expect(card("opening").querySelector(".ed-thumb-frame")).not.toBeNull();
    expect(card("demand").querySelector(".ed-thumb-frame")).toBeNull();
    waiting.shift()?.(0);
    expect(frames()).toHaveLength(3);
    expect(card("opening").textContent).toContain("Channel B now leads demand");
    for (const li of cards()) {
      const thumb = li.querySelector(".ed-thumb") as HTMLElement;
      expect(thumb.getAttribute("aria-hidden")).toBe("true");
      expect(thumb.querySelector(".ed-thumb-frame")?.hasAttribute("inert")).toBe(true);
    }
  });

  it("are drawn again when their scene changes while the board is up", async () => {
    open();
    await until(() => frames().length === 3);
    expect(card("opening").textContent).not.toContain("Brand new headline");
    apply(retitle("Brand new headline"));
    await until(() => card("opening").textContent?.includes("Brand new headline") === true);
  });

  it("keep their picture when something else in the deck changes", async () => {
    open();
    await until(() => frames().length === 3);
    const before = card("demand").querySelector(".ed-thumb-frame");
    apply(retitle("Brand new headline"));
    await until(() => card("opening").textContent?.includes("Brand new headline") === true);
    expect(card("demand").querySelector(".ed-thumb-frame")).toBe(before);
  });
});

describe("choosing a scene", () => {
  it("opens it on the slide from its card, and closes", () => {
    opener().focus();
    open();
    pick("demand").click();
    expect(editor.sceneId).toBe("demand");
    expect(board().hidden).toBe(true);
    expect(document.activeElement).toBe(opener());
  });

  it("opens it from its picture too", () => {
    open();
    (card("opening").querySelector(".ed-thumb") as HTMLElement).click();
    expect(editor.sceneId).toBe("opening");
    expect(board().hidden).toBe(true);
  });

  it("leaves the selected block alone when the scene chosen is the one on show", () => {
    open();
    pick("method").click();
    expect(editor.sceneId).toBe("method");
    expect(board().hidden).toBe(true);
  });
});

describe("the keyboard", () => {
  /** There is no layout here, so the cards are put in rows of two: opening and demand over method. */
  const inRowsOfTwo = () => {
    const tops = new Map([
      ["opening", 0],
      ["demand", 0],
      ["method", 240],
    ]);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const top = this instanceof HTMLElement ? (tops.get(this.dataset.id ?? "") ?? 0) : 0;
      return {
        top,
        left: 0,
        width: 300,
        height: 200,
        right: 300,
        bottom: top + 200,
        x: 0,
        y: top,
      } as DOMRect;
    });
  };
  const focused = () => (document.activeElement as HTMLElement).closest("li")?.dataset.id;
  const tabbable = () =>
    cards().filter((li) => (li.querySelector(".ed-card-pick") as HTMLElement).tabIndex === 0);

  it("starts on the card of the scene on show, which is the only one in the tab order", () => {
    open();
    expect(focused()).toBe("method");
    expect(tabbable().map((li) => li.dataset.id)).toEqual(["method"]);
  });

  it("moves with the arrows, takes the tab order with it, and stops at the ends", () => {
    inRowsOfTwo();
    open();
    const go = (key: string) => {
      const event = press(document.activeElement as Element, key);
      expect(event.defaultPrevented).toBe(true);
    };
    // The scene on show, method, is the last card, alone on the second row.
    go("ArrowRight");
    expect(focused()).toBe("method");
    expect(tabbable().map((li) => li.dataset.id)).toEqual(["method"]);
    go("ArrowUp");
    expect(focused()).toBe("opening");
    go("ArrowLeft");
    expect(focused()).toBe("opening");
    go("ArrowRight");
    expect(focused()).toBe("demand");
    expect(tabbable().map((li) => li.dataset.id)).toEqual(["demand"]);
    go("ArrowDown");
    expect(focused()).toBe("method");
    go("Home");
    expect(focused()).toBe("opening");
    go("End");
    expect(focused()).toBe("method");
    go("ArrowLeft");
    expect(focused()).toBe("demand");
  });

  it("goes down onto the last card from a column the short last row does not have", () => {
    inRowsOfTwo();
    open();
    press(document.activeElement as Element, "ArrowLeft"); // demand, the second column
    press(document.activeElement as Element, "ArrowDown");
    expect(focused()).toBe("method");
  });

  it("brings the keyboard back to the board's own card from nowhere, on the first arrow", () => {
    open();
    const element = board();
    element.focus();
    expect(document.activeElement).toBe(element);
    press(element, "ArrowRight");
    expect(focused()).toBe("method");
  });

  it("keeps the card the keyboard is on in the tab order when the cards are brought up to date", () => {
    open();
    apply(retitle("Something else entirely"));
    expect(tabbable().map((li) => li.dataset.id)).toEqual(["method"]);
  });

  it("does not move up or down when every card fits in one row", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, left: 0, width: 300, height: 200, right: 300, bottom: 200, x: 0, y: 0 }) as DOMRect,
    );
    open();
    press(document.activeElement as Element, "ArrowLeft"); // demand, in the middle
    for (const key of ["ArrowDown", "ArrowUp"]) {
      press(document.activeElement as Element, key);
      expect(focused()).toBe("demand");
    }
  });

  it("leaves a key that something earlier handled, and a key typed into an input method, alone", () => {
    const handled = (event: Event) => event.preventDefault();
    document.addEventListener("keydown", handled, true);
    open();
    press(document.activeElement as Element, "ArrowLeft");
    expect(focused()).toBe("method");
    press(document.activeElement as Element, "Escape");
    expect(board().hidden).toBe(false);
    document.removeEventListener("keydown", handled, true);
    const composing = press(document.activeElement as Element, "ArrowLeft", { isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(focused()).toBe("method");
  });

  it("leaves Enter, Space and Tab to the browser, which presses the button", () => {
    open();
    for (const key of ["Enter", " ", "Tab"])
      expect(press(document.activeElement as Element, key).defaultPrevented).toBe(false);
  });

  it("does not move on an arrow held with Ctrl, Command or Alt, which belong to the browser", () => {
    open();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const event = press(document.activeElement as Element, "ArrowRight", init);
      expect(event.defaultPrevented).toBe(false);
      expect(focused()).toBe("method");
    }
  });

  it("keeps every key from the editor behind it", () => {
    const blocks = () => store.session.doc.scenes.method?.blocks.length;
    const title = () =>
      store.session.doc.scenes.opening?.blocks.find((block) => block.id === "opening-title");
    apply(retitle("Edited"));
    const before = [blocks(), title()];
    open();
    const target = document.activeElement as Element;
    press(target, "t"); // would add a text
    press(target, "c"); // would add a chart
    press(target, "z", { ctrlKey: true }); // would undo the retitle
    press(target, "k", { ctrlKey: true }); // would open the palette
    press(target, "?"); // would open the sheet
    press(target, "m"); // would start the comment tool
    expect([blocks(), title()]).toEqual(before);
    expect(host.querySelector<HTMLElement>(".ed-palette")?.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>(".ed-sheet")?.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>(".ed-comment-catch")?.hidden).toBe(true);
    press(target, "Escape");
    press(document, "t");
    expect(blocks()).toBe((before[0] as number) + 1);
  });
});

describe("the marks", () => {
  it("names who leads each scene, and sets the agent's apart", () => {
    apply({ op: "scene.set", id: "method", set: { lead: "agent" } });
    open();
    expect(said("opening")).toEqual(["Human"]);
    expect(said("method")).toEqual(["Agent"]);
    expect(pillOf("method", "lead").dataset.lead).toBe("agent");
    expect(pick("method").getAttribute("aria-label")).toContain("Lead: Agent.");
  });

  it("counts the changes the agent made since the last review", async () => {
    await mount([], [retitle("Agent title")]);
    await vi.waitFor(() => expect(store.review.changes().length).toBe(1));
    open();
    expect(said("opening")).toEqual(["Human", "1 changed"]);
    expect(said("method")).toEqual(["Human"]);
    expect(pick("opening").getAttribute("aria-label")).toContain("1 change to review.");
  });

  it("counts a scene's open comments, and marks the ones the agent is being waited on", async () => {
    await mount([note("One"), note("Two", { ask: true }), note("Three", { scene: "opening" })]);
    open();
    expect(said("method")).toEqual(["Human", "2 comments"]);
    expect(pillOf("method", "comments").hasAttribute("data-tasks")).toBe(true);
    expect(said("opening")).toEqual(["Human", "1 comment"]);
    expect(pillOf("opening", "comments").hasAttribute("data-tasks")).toBe(false);
    expect(said("demand")).toEqual(["Agent"]); // the demo's demand scene is led by the agent, and has no comments
    expect(pick("method").getAttribute("aria-label")).toContain("2 open comments, 1 waiting for the agent.");
  });

  it("does not count a resolved comment, and follows the comments as they change", async () => {
    await mount([note("One"), note("Two")]);
    open();
    expect(said("method")).toEqual(["Human", "2 comments"]);
    server.externalComment([{ op: "comment.resolve", id: "c1" }]);
    await store.comments.sync();
    expect(said("method")).toEqual(["Human", "1 comment"]);
    server.externalComment([{ op: "comment.resolve", id: "c2" }]);
    await store.comments.sync();
    expect(said("method")).toEqual(["Human"]);
  });

  it("counts the blocks pinned where they are", () => {
    apply({ op: "block.frame", scene: "method", id: "method-body", frame: { x: 10, y: 30, w: 40, h: 20 } });
    open();
    expect(said("method")).toEqual(["Human", "1 pinned"]);
    expect(pick("method").getAttribute("aria-label")).toContain("1 pinned block.");
    apply({ op: "block.unframe", scene: "method", id: "method-body" });
    expect(said("method")).toEqual(["Human"]);
  });

  /** The picture on the method scene goes back to saying the name of its file. */
  const unDescribe = (): Op => {
    const diagram = store.session.doc.scenes.method?.blocks.find((block) => block.id === "method-diagram");
    if (diagram?.type !== "image") throw new Error("the method scene should have a picture");
    return {
      op: "block.set",
      scene: "method",
      id: "method-diagram",
      set: { alt: placeholderAlt(diagram.asset) },
    };
  };

  it("counts what the ribbon would list for the scene, so the two say the same", () => {
    apply(unDescribe());
    apply({ op: "block.frame", scene: "method", id: "method-body", frame: { x: 1, y: 30, w: 40, h: 20 } });
    const listed = problemsOf(store.session).filter((problem) => problem.scene === "method");
    expect(listed).toHaveLength(2);
    open();
    expect(pillOf("method", "check").textContent).toBe("2 to check");
    expect(pick("method").getAttribute("aria-label")).toContain("2 things to check.");
    expect(pills("opening").some((pill) => pill.dataset.kind === "check")).toBe(false);
  });

  it("says one thing to check in the singular", () => {
    apply(unDescribe());
    open();
    expect(pillOf("method", "check").textContent).toBe("1 to check");
    expect(pick("method").getAttribute("aria-label")).toContain("1 thing to check.");
  });

  it("puts the marks in the order lead, changed, to check, comments, pinned", async () => {
    const body: Op = { op: "block.set", scene: "method", id: "method-body", set: { text: "Agent body" } };
    await mount([note("One")], [body]);
    await vi.waitFor(() => expect(store.review.changes().length).toBe(1));
    apply(unDescribe());
    apply({ op: "scene.set", id: "method", set: { lead: "shared" } });
    apply({
      op: "block.frame",
      scene: "method",
      id: "method-diagram",
      frame: { x: 50, y: 10, w: 30, h: 20 },
    });
    open();
    expect(said("method")).toEqual(["Shared", "1 changed", "1 to check", "1 comment", "1 pinned"]);
    expect(pills("method").map((pill) => pill.dataset.kind)).toEqual([
      "lead",
      "changed",
      "check",
      "comments",
      "pinned",
    ]);
  });
});

describe("while it is up", () => {
  it("follows a scene's name changed, in the same card", () => {
    open();
    const same = card("opening");
    apply({ op: "scene.set", id: "opening", set: { title: "A different name" } });
    expect(card("opening")).toBe(same);
    expect(same.querySelector(".ed-card-name")?.textContent).toBe("A different name");
    expect(pick("opening").getAttribute("aria-label")).toContain("Scene 1, A different name.");
  });

  it("shows a scene added, in its place", () => {
    open();
    const scene = newScene(store.session.doc, "title");
    apply({ op: "scene.add", scene, after: "opening" });
    expect(order()).toEqual(["opening", scene.id, "demand", "method"]);
    expect(card(scene.id).querySelector(".ed-card-number")?.textContent).toBe("2");
    expect(card("method").querySelector(".ed-card-number")?.textContent).toBe("4");
    expect(board().querySelector(".ed-board-count")?.textContent).toBe("4 scenes");
  });

  it("drops a scene that is removed, and numbers the rest again", () => {
    open();
    apply({ op: "scene.remove", id: "opening" });
    expect(order()).toEqual(["demand", "method"]);
    expect(cards().map((li) => li.querySelector(".ed-card-number")?.textContent)).toEqual(["1", "2"]);
    expect(board().querySelector(".ed-board-count")?.textContent).toBe("2 scenes");
  });

  it("says one scene, not one scenes", () => {
    open();
    apply({ op: "scene.remove", id: "opening" }, { op: "scene.remove", id: "demand" });
    expect(board().querySelector(".ed-board-count")?.textContent).toBe("1 scene");
  });

  it("follows a scene moved, and keeps the keyboard on the card it was on", () => {
    open();
    const held = pick("method");
    expect(document.activeElement).toBe(held);
    apply({ op: "scene.move", id: "demand", after: null });
    expect(order()).toEqual(["demand", "opening", "method"]);
    expect(document.activeElement).toBe(held);
  });

  it("puts the keyboard on the card of the scene on show when the card it was on is removed", () => {
    open();
    expect(document.activeElement).toBe(pick("method"));
    apply({ op: "scene.remove", id: "method" });
    expect(order()).toEqual(["opening", "demand"]);
    expect(editor.sceneId).toBe("opening");
    expect(pick("opening").tabIndex).toBe(0);
    expect(document.activeElement).toBe(pick("opening"));
  });

  it("leaves the keyboard where it is when a card it is not on is removed", () => {
    open();
    expect(document.activeElement).toBe(pick("method"));
    apply({ op: "scene.remove", id: "demand" });
    expect(document.activeElement).toBe(pick("method"));
  });

  it("follows a change of the agent's as it arrives", async () => {
    open();
    expect(said("opening")).toEqual(["Human"]);
    server.agentEdit([retitle("Agent title")]);
    await store.syncFromDisk();
    await store.review.sync();
    await vi.waitFor(() => expect(said("opening")).toEqual(["Human", "1 changed"]));
  });

  it("leaves the grid alone when no card came, went or moved, and puts it right when one did", () => {
    open();
    const grid = board().querySelector(".ed-board-grid") as HTMLElement;
    const put = vi.spyOn(grid, "replaceChildren");
    apply(retitle("Brand new headline"));
    expect(put).not.toHaveBeenCalled();
    apply({ op: "scene.move", id: "demand", after: null });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("keeps a card's marks as they were when they did not change", () => {
    open();
    const lead = pills("opening")[0];
    apply(retitle("Brand new headline"));
    expect(pills("opening")[0]).toBe(lead);
  });

  it("does not spend a frame on the picture of a scene that is gone", () => {
    const waiting: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => waiting.push(callback));
    open();
    apply({ op: "scene.remove", id: "opening" });
    waiting.shift()?.(0);
    expect(frames()).toHaveLength(2);
  });

  it("stops the frames still waiting to draw a picture when it closes", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 7);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    open();
    press(document.activeElement as Element, "Escape");
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("draws the pictures again when the deck's theme changes", async () => {
    open();
    await until(() => frames().length === 3);
    expect(frames()[0]?.getAttribute("data-theme")).toBe("paper");
    apply({ op: "deck.set", set: { theme: "ink" } });
    await until(() => [...frames()].every((frame) => frame.getAttribute("data-theme") === "ink"));
  });

  it("is not redrawn while it is shut, so a deck being edited pays nothing for it", () => {
    const grid = board().querySelector(".ed-board-grid") as HTMLElement;
    apply(retitle("Edited while shut"));
    expect(grid.children).toHaveLength(0);
  });
});
