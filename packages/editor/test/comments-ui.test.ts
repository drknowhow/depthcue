// @vitest-environment happy-dom
import { type CommentOp, memoryDraftStore } from "@depthcue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

const TEXT = "method-body";
const PICTURE = "method-diagram";

async function mount(seed: CommentOp[] = []) {
  server = new FakeServer();
  if (seed.length > 0) server.externalComment(seed);
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select("method");
  await vi.waitFor(() => expect(store.comments.state.ready).toBe(true));
}

afterEach(() => {
  editor.destroy();
  Reflect.deleteProperty(document, "elementsFromPoint");
  vi.restoreAllMocks();
});

const note = (text: string, over: { block?: string; ask?: boolean; scene?: string } = {}): CommentOp => ({
  op: "comment.add",
  scene: over.scene ?? "method",
  block: over.block ?? TEXT,
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
const blockNode = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-frame [data-id='${id}']`) as HTMLElement;
const catcher = () => host.querySelector<HTMLElement>(".ed-comment-catch") as HTMLElement;
const banner = () => host.querySelector<HTMLElement>(".ed-comment-banner") as HTMLElement;
const layer = () => host.querySelector<HTMLElement>(".ed-comments") as HTMLElement;
const pins = () => [...host.querySelectorAll<HTMLElement>(".ed-pin")];
const pin = (id: string) => host.querySelector<HTMLElement>(`.ed-pin[data-pin='${id}']`);
const thread = () => host.querySelector<HTMLElement>(".ed-thread");
const field = () =>
  thread()?.querySelector<HTMLTextAreaElement>("[data-comment='field']") as HTMLTextAreaElement;
const control = (name: string) =>
  thread()?.querySelector<HTMLButtonElement>(`[data-comment='${name}']`) as HTMLButtonElement;
const messages = () => [...(thread()?.querySelectorAll<HTMLElement>(".ed-thread-message") ?? [])];
const problemLine = () => thread()?.querySelector<HTMLElement>(".ed-thread-problem") as HTMLElement;
const barButton = () =>
  host.querySelector<HTMLButtonElement>("[data-action='comments']") as HTMLButtonElement;
const resolvedButton = () =>
  host.querySelector<HTMLButtonElement>("[data-action='resolved']") as HTMLButtonElement;
const quick = () => host.querySelector<HTMLButtonElement>("[data-quick='comment']") as HTMLButtonElement;
const stripItem = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-scene-list > li[data-id='${id}']`) as HTMLElement;
const stripCount = (id: string) => stripItem(id).querySelector<HTMLElement>(".ed-scene-notes") as HTMLElement;

const write = (text: string) => {
  const box = field();
  box.value = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
};

/** There is no layout here, so the block under a press is named by hand. */
const over = (...nodes: Element[]) => {
  Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => nodes });
};

/** Turns the tool on and presses a block with it, the way a person does. */
function startComment(block: string) {
  press(document, "m");
  over(blockNode(block));
  catcher().dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
}

describe("the tool", () => {
  it("is off until M is pressed, says what to do, and stops on M or Escape", async () => {
    await mount();
    expect(catcher().hidden).toBe(true);
    expect(banner().hidden).toBe(true);
    press(document, "m");
    expect(catcher().hidden).toBe(false);
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toMatch(/Click a block/);
    expect(quick().getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".ed-canvas-host")?.hasAttribute("data-commenting")).toBe(true);
    press(document, "m");
    expect(catcher().hidden).toBe(true);
    press(document, "m");
    const stop = press(document, "Escape");
    expect(stop.defaultPrevented).toBe(true);
    expect(catcher().hidden).toBe(true);
    expect(quick().getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".ed-canvas-host")?.hasAttribute("data-commenting")).toBe(false);
  });

  it("starts a comment on the block that was pressed, and puts itself away", async () => {
    await mount();
    startComment(TEXT);
    expect(catcher().hidden).toBe(true);
    expect(thread()?.dataset.thread).toBe(`new:${TEXT}`);
    expect(thread()?.querySelector(".ed-thread-title")?.textContent).toMatch(/^Comment on /);
  });

  it("says so when the press was not on a block, and stays on", async () => {
    await mount();
    press(document, "m");
    over();
    catcher().dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(thread()).toBeNull();
    expect(catcher().hidden).toBe(false);
    expect(banner().textContent).toMatch(/not a block/);
    expect(banner().hasAttribute("data-problem")).toBe(true);
  });

  it("does not take a block of another scene, which the slide under the press cannot have", async () => {
    await mount();
    press(document, "m");
    const stranger = document.createElement("div");
    stranger.dataset.id = "chart-demand";
    host.append(stranger);
    over(stranger);
    catcher().dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    expect(thread()).toBeNull();
  });

  it("comments on the claim of a scene", async () => {
    await mount();
    editor.select("demand");
    startComment("claim-shift");
    expect(thread()?.dataset.thread).toBe("new:claim-shift");
    expect(thread()?.querySelector(".ed-thread-title")?.textContent).toBe("Comment on the claim");
  });

  it("is on the palette's side too: the Comment button turns the tool on and off", async () => {
    await mount();
    quick().click();
    expect(catcher().hidden).toBe(false);
    quick().click();
    expect(catcher().hidden).toBe(true);
  });
});

describe("writing a comment", () => {
  it("opens a box with the focus in it and nothing to send yet", async () => {
    await mount();
    startComment(TEXT);
    expect(document.activeElement).toBe(field());
    expect(control("add").disabled).toBe(true);
    expect(control("ask").disabled).toBe(true);
    write("   ");
    expect(control("add").disabled).toBe(true);
    write("Cut this line");
    expect(control("add").disabled).toBe(false);
    expect(control("ask").disabled).toBe(false);
    expect(field().maxLength).toBe(2000);
  });

  it("writes the comment where it was pressed, and opens its thread with the focus in the reply box", async () => {
    await mount();
    startComment(TEXT);
    write("Cut this line");
    control("add").click();
    await vi.waitFor(() => expect(server.comments.comments).toHaveLength(1));
    const [written] = server.comments.comments;
    expect(written).toMatchObject({
      scene: "method",
      block: TEXT,
      anchor: { x: 0.5, y: 0.5 },
      resolved: false,
    });
    expect(written?.ask).toBeUndefined();
    expect(written?.thread.map((message) => [message.author, message.text])).toEqual([
      ["you", "Cut this line"],
    ]);
    await vi.waitFor(() => expect(thread()?.dataset.thread).toBe("thread:c1"));
    expect(pin("c1")?.textContent).toBe("1");
    expect(pin("c1")?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("");
    expect(control("reply")).toBeDefined();
  });

  it("asks the agent when Ask the agent is pressed, and the pin says it is waiting", async () => {
    await mount();
    startComment(TEXT);
    write("Make this shorter");
    control("ask").click();
    await vi.waitFor(() => expect(server.comments.comments).toHaveLength(1));
    expect(server.comments.comments[0]?.ask).toBe(true);
    await vi.waitFor(() => expect(pin("c1")?.getAttribute("data-state")).toBe("task"));
    expect(pin("c1")?.getAttribute("aria-label")).toMatch(/waiting for the agent/);
    expect(thread()?.querySelector(".ed-thread-state")?.textContent).toBe("Waiting for the agent.");
  });

  it("sends on Ctrl Enter, and a plain Enter only breaks the line", async () => {
    await mount();
    startComment(TEXT);
    write("Two lines");
    const plain = press(field(), "Enter");
    expect(plain.defaultPrevented).toBe(false);
    expect(server.commentSaves).toHaveLength(0);
    const sent = press(field(), "Enter", { ctrlKey: true });
    expect(sent.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(server.comments.comments).toHaveLength(1));
  });

  it("says why when the server refuses, and keeps what was written", async () => {
    await mount();
    startComment(TEXT);
    write("Cut this line");
    server.nextCommentSave = { ok: false, kind: "rejected", message: "That block is not on the scene." };
    control("add").click();
    await vi.waitFor(() => expect(problemLine().hidden).toBe(false));
    expect(problemLine().textContent).toBe("That block is not on the scene.");
    expect(field().value).toBe("Cut this line");
    expect(control("add").disabled).toBe(false);
    expect(server.comments.comments).toHaveLength(0);
  });

  it("is put away with Escape, and the keyboard goes back to the block", async () => {
    await mount();
    blockNode(TEXT).click();
    startComment(TEXT);
    const stop = press(field(), "Escape");
    expect(stop.defaultPrevented).toBe(true);
    expect(thread()).toBeNull();
  });

  it("shows an empty pin where it will point while the box is open, and takes it away with the box", async () => {
    await mount();
    startComment(TEXT);
    const draft = host.querySelector(".ed-pin-draft");
    expect(draft).not.toBeNull();
    expect(draft?.getAttribute("aria-hidden")).toBe("true");
    // It is not a comment yet, so it is no pin of the scene and is not counted.
    expect(pins().filter((node) => node.dataset.pin !== undefined)).toEqual([]);
    press(field(), "Escape");
    expect(host.querySelector(".ed-pin-draft")).toBeNull();

    startComment(TEXT);
    write("Cut this line");
    control("add").click();
    await vi.waitFor(() => expect(pin("c1")).not.toBeNull());
    expect(host.querySelector(".ed-pin-draft")).toBeNull();
  });

  it("is also what the palette's comment command opens, at the usual corner", async () => {
    await mount();
    blockNode(PICTURE).click();
    expect(editor.blockId).toBe(PICTURE);
    press(document, "k", { ctrlKey: true });
    const palette = host.querySelector<HTMLElement>(".ed-palette") as HTMLElement;
    const choice = palette.querySelector<HTMLElement>("[data-command='comment']");
    expect(choice?.textContent).toMatch(/Comment on the block/);
    choice?.click();
    expect(thread()?.dataset.thread).toBe(`new:${PICTURE}`);
    write("From the keyboard");
    control("add").click();
    await vi.waitFor(() => expect(server.comments.comments).toHaveLength(1));
    expect(server.comments.comments[0]?.anchor).toEqual({ x: 0.92, y: 0.12 });
  });
});

describe("a thread", () => {
  const seed = [note("Cut this line"), note("Is this right?", { block: PICTURE, ask: true })];

  it("opens from its pin, says who wrote what and marks the pin open", async () => {
    await mount(seed);
    expect(pins().map((node) => node.textContent)).toEqual(["1", "2"]);
    pin("c1")?.click();
    expect(thread()?.dataset.thread).toBe("thread:c1");
    expect(pin("c1")?.getAttribute("aria-expanded")).toBe("true");
    expect(pin("c2")?.getAttribute("aria-expanded")).toBe("false");
    expect(messages().map((item) => item.dataset.author)).toEqual(["you"]);
    expect(messages()[0]?.querySelector(".ed-thread-text")?.textContent).toBe("Cut this line");
    expect(messages()[0]?.querySelector(".ed-thread-who")?.textContent).toMatch(/^You/);
    expect(thread()?.getAttribute("role")).toBe("dialog");
  });

  it("closes on a second press of the pin, and the keyboard stays on the pin", async () => {
    await mount(seed);
    pin("c1")?.click();
    pin("c1")?.click();
    expect(thread()).toBeNull();
    expect(document.activeElement).toBe(pin("c1"));
  });

  it("moves from one thread to the next without keeping the first", async () => {
    await mount(seed);
    pin("c1")?.click();
    pin("c2")?.click();
    expect(document.querySelectorAll(".ed-thread")).toHaveLength(1);
    expect(thread()?.dataset.thread).toBe("thread:c2");
  });

  it("adds a reply, empties the box and keeps the focus in it for the next one", async () => {
    await mount(seed);
    pin("c1")?.click();
    write("Done, thanks");
    // Pressing a button gives it the keyboard, so the box has to take it back.
    control("reply").focus();
    expect(document.activeElement).not.toBe(field());
    control("reply").click();
    await vi.waitFor(() => expect(server.comments.comments[0]?.thread).toHaveLength(2));
    expect(server.comments.comments[0]?.thread[1]).toMatchObject({ author: "you", text: "Done, thanks" });
    await vi.waitFor(() => expect(messages()).toHaveLength(2));
    expect(field().value).toBe("");
    expect(document.activeElement).toBe(field());
    expect(control("reply").disabled).toBe(true);
  });

  it("is put away with Escape and the keyboard goes back to its pin", async () => {
    await mount(seed);
    pin("c2")?.click();
    const stop = press(field(), "Escape");
    expect(stop.defaultPrevented).toBe(true);
    expect(thread()).toBeNull();
    expect(document.activeElement).toBe(pin("c2"));
    expect(pin("c2")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("is put away by a press elsewhere when nothing is written, and kept when something is", async () => {
    await mount(seed);
    pin("c1")?.click();
    write("half a thought");
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(thread()).not.toBeNull();
    write("");
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(thread()).toBeNull();
  });

  it("is not put away by a press inside it or on a pin", async () => {
    await mount(seed);
    pin("c1")?.click();
    thread()?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    pin("c2")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(thread()).not.toBeNull();
  });

  it("resolves and reopens, stays open, and the pin keeps its number", async () => {
    await mount(seed);
    pin("c1")?.click();
    expect(control("resolve").textContent).toBe("Resolve");
    control("resolve").click();
    await vi.waitFor(() => expect(server.comments.comments[0]?.resolved).toBe(true));
    await vi.waitFor(() => expect(control("resolve").textContent).toBe("Reopen"));
    expect(thread()?.dataset.thread).toBe("thread:c1");
    expect(thread()?.querySelector(".ed-thread-state")?.textContent).toBe("Resolved.");
    // The resolved pin is not drawn, and the one that is left is still number two.
    expect(pins().map((node) => node.textContent)).toEqual(["2"]);
    control("resolve").click();
    await vi.waitFor(() => expect(server.comments.comments[0]?.resolved).toBe(false));
    await vi.waitFor(() => expect(pins().map((node) => node.textContent)).toEqual(["1", "2"]));
  });

  it("deletes only on a second press, and a press that moves on takes the first one back", async () => {
    await mount(seed);
    pin("c1")?.click();
    control("delete").focus();
    control("delete").click();
    expect(control("delete").textContent).toBe("Delete the thread?");
    expect(server.comments.comments).toHaveLength(2);
    control("delete").blur();
    expect(control("delete").textContent).toBe("Delete");
    // The first press is a question again, not the answer to the one that was taken back.
    control("delete").click();
    expect(control("delete").textContent).toBe("Delete the thread?");
    expect(server.comments.comments).toHaveLength(2);
    control("delete").click();
    await vi.waitFor(() => expect(server.comments.comments.map((comment) => comment.id)).toEqual(["c2"]));
    await vi.waitFor(() => expect(thread()).toBeNull());
    expect(pins().map((node) => node.dataset.pin)).toEqual(["c2"]);
  });

  it("shows the agent's reply as it arrives, without taking the box from under what is being written", async () => {
    await mount(seed);
    pin("c2")?.click();
    expect(pin("c2")?.getAttribute("data-state")).toBe("task");
    const box = field();
    write("a draft in progress");
    server.externalComment([{ op: "comment.reply", id: "c2", author: "agent", text: "Yes, it is right." }]);
    await store.comments.sync();
    expect(messages().map((item) => item.dataset.author)).toEqual(["you", "agent"]);
    expect(field()).toBe(box);
    expect(field().value).toBe("a draft in progress");
    expect(pin("c2")?.getAttribute("data-state")).toBe("answered");
    expect(thread()?.querySelector(".ed-thread-state")?.textContent).toBe("The agent has replied.");
  });

  it("is put away when the agent deletes the comment", async () => {
    await mount(seed);
    pin("c1")?.click();
    server.externalComment([{ op: "comment.delete", id: "c1" }]);
    await store.comments.sync();
    expect(thread()).toBeNull();
    expect(pin("c1")).toBeNull();
  });
});

describe("the pins", () => {
  it("name their block, their state and the start of what was said", async () => {
    await mount([note("Cut this line"), note("Is this right?", { block: PICTURE, ask: true })]);
    expect(pin("c1")?.getAttribute("data-state")).toBe("open");
    expect(pin("c1")?.getAttribute("aria-label")).toMatch(/^Comment 1 on .*, open: Cut this line$/);
    expect(pin("c2")?.getAttribute("aria-label")).toMatch(
      /^Comment 2 on .*, waiting for the agent: Is this right\?$/,
    );
    expect(pin("c1")?.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("are the ones of the scene on show, and follow the scene that is chosen", async () => {
    await mount([
      note("On the method"),
      note("On the opening", { scene: "opening", block: "opening-title" }),
    ]);
    expect(pins().map((node) => node.dataset.pin)).toEqual(["c1"]);
    editor.select("opening");
    expect(pins().map((node) => node.dataset.pin)).toEqual(["c2"]);
    // The number counts the comments of the scene, so the first comment of the opening is number one.
    expect(pin("c2")?.textContent).toBe("1");
  });

  it("put an open thread away when the scene changes", async () => {
    await mount([note("On the method")]);
    pin("c1")?.click();
    editor.select("opening");
    expect(thread()).toBeNull();
  });

  it("show a resolved comment dimmed only when the Resolved button is on", async () => {
    await mount([note("Done already"), note("Still open")]);
    server.externalComment([{ op: "comment.resolve", id: "c1" }]);
    await store.comments.sync();
    expect(pins().map((node) => node.dataset.pin)).toEqual(["c2"]);
    expect(resolvedButton().hidden).toBe(false);
    expect(resolvedButton().querySelector(".ed-count")?.textContent).toBe("1");
    expect(resolvedButton().getAttribute("aria-label")).toBe(
      "1 resolved comment. Hidden. Press to show them.",
    );
    expect(resolvedButton().getAttribute("aria-pressed")).toBe("false");
    resolvedButton().click();
    expect(pins().map((node) => [node.dataset.pin, node.dataset.state])).toEqual([
      ["c1", "resolved"],
      ["c2", "open"],
    ]);
    expect(resolvedButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("sit in the corner of the slide, marked, when the block they were about is gone", async () => {
    await mount([note("About the picture", { block: PICTURE })]);
    expect(pin("c1")?.hasAttribute("data-orphan")).toBe(false);
    const gone = store.session.apply([{ op: "block.remove", scene: "method", id: PICTURE }]);
    expect(gone.ok).toBe(true);
    await vi.waitFor(() => expect(pin("c1")?.hasAttribute("data-orphan")).toBe(true));
    expect(pin("c1")?.getAttribute("aria-label")).toMatch(/a block that is gone/);
    pin("c1")?.click();
    expect(thread()?.querySelector(".ed-thread-state")?.textContent).toMatch(
      /The block this was about is gone\./,
    );
  });

  it("are not drawn for a comment of a scene that was removed", async () => {
    await mount([note("On the opening", { scene: "opening", block: "opening-title" })]);
    store.session.apply([{ op: "scene.remove", id: "opening" }]);
    editor.select("method");
    expect(pins()).toEqual([]);
    expect(barButton().querySelector(".ed-count")?.textContent).toBe("");
  });
});

describe("the top bar", () => {
  it("says how many comments are open, and how many wait for the agent", async () => {
    await mount([
      note("One"),
      note("Two", { ask: true }),
      note("Three", { scene: "opening", block: "opening-title" }),
    ]);
    const count = barButton().querySelector<HTMLElement>(".ed-count") as HTMLElement;
    expect(count.textContent).toBe("3");
    expect(count.hasAttribute("data-tasks")).toBe(true);
    expect(barButton().getAttribute("aria-label")).toBe(
      "3 open comments, 1 waiting for the agent. Shown on the slides. Press to hide them.",
    );
  });

  it("writes nothing when there is nothing open", async () => {
    await mount();
    const count = barButton().querySelector<HTMLElement>(".ed-count") as HTMLElement;
    expect(count.textContent).toBe("");
    expect(barButton().getAttribute("aria-label")).toBe(
      "0 open comments. Shown on the slides. Press to hide them.",
    );
    expect(resolvedButton().hidden).toBe(true);
  });

  it("follows a comment the agent writes", async () => {
    await mount();
    server.externalComment([note("From the agent's side", { ask: true })]);
    await store.comments.sync();
    expect(barButton().querySelector(".ed-count")?.textContent).toBe("1");
    expect(pins()).toHaveLength(1);
  });

  it("hides and shows the pins, and the tool cannot be on while they are hidden", async () => {
    await mount([note("One")]);
    expect(barButton().getAttribute("aria-pressed")).toBe("true");
    barButton().click();
    expect(layer().hidden).toBe(true);
    expect(barButton().getAttribute("aria-pressed")).toBe("false");
    expect(barButton().getAttribute("aria-label")).toMatch(/Hidden\. Press to show them\.$/);
    expect(resolvedButton().hidden).toBe(true);
    // M brings them back and starts the tool, which is what pressing it asks for.
    press(document, "m");
    expect(layer().hidden).toBe(false);
    expect(catcher().hidden).toBe(false);
    expect(barButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("puts an open thread away when the pins are hidden", async () => {
    await mount([note("One")]);
    pin("c1")?.click();
    barButton().click();
    expect(thread()).toBeNull();
  });

  it("is switched off, with the reason, when the comments file cannot be read", async () => {
    server = new FakeServer();
    server.commentsBroken = "comments.json is not valid JSON.";
    store = await openStore(server, () => memoryDraftStore());
    host = document.createElement("div");
    document.body.replaceChildren(host);
    editor = mountEditor(host, store);
    editor.select("method");
    await vi.waitFor(() => expect(store.comments.state.ready).toBe(true));
    expect(barButton().disabled).toBe(true);
    expect(barButton().getAttribute("aria-label")).toMatch(/comments\.json is not valid JSON\./);
    expect(pins()).toEqual([]);
  });
});

describe("the strip", () => {
  it("counts the open comments of each scene on its thumbnail, and tells a screen reader", async () => {
    await mount([
      note("One"),
      note("Two", { ask: true }),
      note("Three", { scene: "opening", block: "opening-title" }),
    ]);
    expect(stripCount("method").hidden).toBe(false);
    expect(stripCount("method").textContent).toBe("2");
    expect(stripCount("method").hasAttribute("data-tasks")).toBe(true);
    expect(stripCount("opening").textContent).toBe("1");
    expect(stripCount("opening").hasAttribute("data-tasks")).toBe(false);
    expect(stripCount("demand").hidden).toBe(true);
    const pick = (id: string) => stripItem(id).querySelector("button") as HTMLElement;
    expect(pick("method").getAttribute("aria-label")).toMatch(/2 open comments, 1 waiting for the agent$/);
    expect(pick("opening").getAttribute("aria-label")).toMatch(/1 open comment$/);
    // A scene with none keeps the name its contents give it.
    expect(pick("demand").hasAttribute("aria-label")).toBe(false);
  });

  it("does not count a resolved comment", async () => {
    await mount([note("One"), note("Two")]);
    server.externalComment([{ op: "comment.resolve", id: "c1" }]);
    await store.comments.sync();
    expect(stripCount("method").textContent).toBe("1");
    server.externalComment([{ op: "comment.resolve", id: "c2" }]);
    await store.comments.sync();
    expect(stripCount("method").hidden).toBe(true);
  });
});
