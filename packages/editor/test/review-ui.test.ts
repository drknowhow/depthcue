// @vitest-environment happy-dom
import { type Doc, loadDoc, memoryDraftStore, type Op, startReview } from "@depthcue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer, openingTitle, retitle } from "./helpers.ts";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

const TITLE = "scene:opening/block:opening-title/text";
const BODY = "scene:method/block:method-body/text";
const method = (text: string): Op => ({ op: "block.set", scene: "method", id: "method-body", set: { text } });

/** Opens the editor on a deck where the agent has already made the given edits. */
async function mount(...edits: Op[][]) {
  server = new FakeServer();
  for (const ops of edits) server.agentEdit(ops);
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  await vi.waitFor(() => expect(store.review.state.ready).toBe(true));
}

afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
});

const press = (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.dispatchEvent(event);
  return event;
};
const barButton = () => host.querySelector<HTMLButtonElement>("[data-action='review']") as HTMLButtonElement;
const drawer = () => host.querySelector<HTMLElement>(".ed-review") as HTMLElement;
const rows = () => [...host.querySelectorAll<HTMLElement>(".ed-ri")];
const row = (id: string) => host.querySelector<HTMLElement>(`.ed-ri[data-id='${id}']`) as HTMLElement;
const act = (id: string, name: "accept-change" | "revert-change") =>
  row(id).querySelector<HTMLButtonElement>(`[data-action='${name}']`) as HTMLButtonElement;
const undo = () => host.querySelector<HTMLButtonElement>("[data-action='undo']") as HTMLButtonElement;
const pill = (scene: string) =>
  host.querySelector<HTMLElement>(`.ed-scene-list > li[data-id='${scene}'] .ed-scene-changed`) as HTMLElement;
const pick = (scene: string) =>
  host.querySelector<HTMLElement>(`.ed-scene-list > li[data-id='${scene}'] .ed-scene`) as HTMLElement;
const open = () => barButton().click();
const count = () => barButton().querySelector<HTMLElement>(".ed-count")?.textContent;
const words = () => barButton().querySelector<HTMLElement>(".ed-bar-words")?.textContent;

describe("the button", () => {
  it("says the deck is reviewed when nothing has changed", async () => {
    await mount();
    expect(words()).toBe("Reviewed");
    expect(count()).toBe("");
    expect(barButton().dataset.state).toBe("clear");
    expect(barButton().getAttribute("aria-label")).toContain("Nothing to review");
  });

  it("says how many changes the agent made", async () => {
    await mount([retitle("Agent title")], [method("Agent body")]);
    await vi.waitFor(() => expect(words()).toBe("Agent changed"));
    expect(count()).toBe("2");
    expect(barButton().dataset.state).toBe("changed");
    expect(barButton().getAttribute("aria-label")).toContain("The agent changed 2 changes to review");
  });

  it("says changed, and not the agent's, when only the files were edited by hand", async () => {
    await mount();
    // Somebody started a review of the deck as it is, and then edited a file by hand.
    const { doc } = loadDoc({ text: server.text, assets: server.assets });
    server.review = startReview(doc as Doc);
    server.external([method("By hand")]);
    await store.syncFromDisk();
    await store.review.sync();
    expect(words()).toBe("Changed");
    expect(count()).toBe("1");
  });

  it("follows the agent as it writes, without a reload", async () => {
    await mount();
    server.agentEdit([retitle("Agent title")]);
    await store.syncFromDisk();
    await store.review.sync();
    expect(words()).toBe("Agent changed");
    expect(count()).toBe("1");
  });

  it("says why when the review cannot be read", async () => {
    await mount();
    server.reviewBroken = "review.json is not valid JSON.";
    await store.review.sync();
    expect(barButton().getAttribute("aria-label")).toContain("review.json is not valid JSON.");
  });
});

describe("the drawer", () => {
  it("is closed until the button is pressed, and the button says whether it is open", async () => {
    await mount([retitle("Agent title")]);
    expect(drawer().hidden).toBe(true);
    expect(barButton().getAttribute("aria-expanded")).toBe("false");
    open();
    expect(drawer().hidden).toBe(false);
    expect(barButton().getAttribute("aria-expanded")).toBe("true");
    open();
    expect(drawer().hidden).toBe(true);
  });

  it("lists each change with where it is, what it was struck out, what it is marked and the two answers", async () => {
    await mount([retitle("Agent title")]);
    open();
    expect(rows()).toHaveLength(1);
    const first = row(TITLE);
    expect(first.dataset.by).toBe("agent");
    expect(first.querySelector(".ed-ri-where")?.textContent).toContain("Block opening-title · text");
    expect(first.querySelector("mark")?.textContent).toBe("Agent title");
    expect(first.querySelector("s")?.textContent).toBe("Channel B now leads demand");
    expect(act(TITLE, "accept-change").getAttribute("aria-label")).toContain("Accept:");
    expect(act(TITLE, "revert-change").getAttribute("aria-label")).toContain("Revert:");
    expect(first.querySelector(".ed-ri-by")).toBeNull();
  });

  it("tags a change made outside the agent's tools", async () => {
    await mount([retitle("Agent title")]);
    server.external([method("By hand")]);
    await store.syncFromDisk();
    open();
    expect(row(BODY).dataset.by).toBe("outside");
    expect(row(BODY).querySelector(".ed-ri-by")?.textContent).toBe("Outside");
  });

  it("says there is nothing to review, in words that tell where changes will appear", async () => {
    await mount();
    open();
    const empty = host.querySelector<HTMLElement>(".ed-review-empty") as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain("Nothing to review");
    expect((host.querySelector("[data-action='accept-all']") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says why when the review cannot be read", async () => {
    await mount();
    server.reviewBroken = "review.json is not valid JSON.";
    await store.review.sync();
    open();
    expect(host.querySelector(".ed-review-empty")?.textContent).toContain("review.json is not valid JSON.");
  });

  it("closes with Escape and hands the keyboard back to the button", async () => {
    await mount([retitle("Agent title")]);
    open();
    const event = press("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(drawer().hidden).toBe(true);
    expect(document.activeElement).toBe(barButton());
    // With it closed Escape is left to whatever else wants it.
    expect(press("Escape").defaultPrevented).toBe(false);
  });

  it("leaves Escape to whatever already took it", async () => {
    await mount([retitle("Agent title")]);
    open();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    document.dispatchEvent(event);
    expect(drawer().hidden).toBe(false);
  });

  it("lists a change to the deck itself, which has no scene to go to", async () => {
    await mount([{ op: "deck.set", set: { title: "A new deck title" } }]);
    open();
    const deck = row("deck/title");
    expect(deck.querySelector(".ed-ri-where")?.textContent).toBe("Deck · title");
    expect(deck.querySelector("[data-action='show-change']")).toBeNull();
    // It belongs to no scene, so no thumbnail is marked for it.
    expect(pill("opening").hidden).toBe(true);
  });

  it("closes with its own button", async () => {
    await mount([retitle("Agent title")]);
    open();
    (host.querySelector("[data-action='close-review']") as HTMLButtonElement).click();
    expect(drawer().hidden).toBe(true);
  });

  it("goes to the scene and the block of a change", async () => {
    await mount([method("Agent body")]);
    open();
    (row(BODY).querySelector("[data-action='show-change']") as HTMLButtonElement).click();
    expect(editor.sceneId).toBe("method");
    expect(editor.blockId).toBe("method-body");
  });

  it("follows an edit made while it is open", async () => {
    await mount([retitle("Agent title")]);
    open();
    server.agentEdit([method("Agent body")]);
    await store.syncFromDisk();
    await store.review.sync();
    expect(rows().map((item) => item.dataset.id)).toEqual([TITLE, BODY]);
  });
});

describe("accept", () => {
  it("takes the change off the list and off the button, and writes the review", async () => {
    await mount([retitle("Agent title")]);
    open();
    act(TITLE, "accept-change").click();
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    expect(server.review?.agent).toEqual([]);
    expect(words()).toBe("Reviewed");
    expect(host.querySelector(".ed-review-empty")?.textContent).toContain("Nothing to review");
  });

  it("is one Undo away, and the change is back where it was", async () => {
    await mount([retitle("Agent title")]);
    open();
    act(TITLE, "accept-change").click();
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    expect(undo().disabled).toBe(false);
    undo().click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(server.review?.agent).toEqual([TITLE]);
    expect(undo().disabled).toBe(true);
  });

  it("accepts everything at once", async () => {
    await mount([retitle("Agent title")], [method("Agent body")]);
    open();
    (host.querySelector("[data-action='accept-all']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    expect(server.review?.agent).toEqual([]);
  });

  it("hands the keyboard to the close button when accept all leaves nothing to accept", async () => {
    await mount([retitle("Agent title")]);
    open();
    const all = host.querySelector<HTMLButtonElement>("[data-action='accept-all']") as HTMLButtonElement;
    all.focus();
    all.click();
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    expect(document.activeElement).toBe(host.querySelector("[data-action='close-review']"));
  });

  it("shows what the server refused, and keeps the change", async () => {
    await mount([retitle("Agent title")]);
    open();
    server.nextReviewSave = { ok: false, kind: "rejected", message: "review.json is not valid." };
    act(TITLE, "accept-change").click();
    await vi.waitFor(() => expect(host.querySelector<HTMLElement>(".ed-review-problem")?.hidden).toBe(false));
    expect(host.querySelector(".ed-review-problem")?.textContent).toBe("review.json is not valid.");
    expect(rows()).toHaveLength(1);
  });

  it("hands the keyboard to the next row when the one it was on is answered", async () => {
    await mount([retitle("Agent title")], [method("Agent body")]);
    open();
    act(TITLE, "accept-change").focus();
    act(TITLE, "accept-change").click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(document.activeElement).toBe(act(BODY, "accept-change"));
  });
});

describe("revert", () => {
  it("puts the text back on the slide and takes the change off the list", async () => {
    await mount([retitle("Agent title")]);
    open();
    act(TITLE, "revert-change").click();
    expect(rows()).toHaveLength(0);
    expect(openingTitle(store.session.doc)).toBe("Channel B now leads demand");
    expect(words()).toBe("Reviewed");
  });

  it("is one Undo away, like any edit, and the change comes back as the agent's", async () => {
    await mount([retitle("Agent title")]);
    open();
    act(TITLE, "revert-change").click();
    undo().click();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(openingTitle(store.session.doc)).toBe("Agent title");
    expect(row(TITLE).dataset.by).toBe("agent");
  });
});

describe("the strip", () => {
  it("marks a scene with changes, and not the others", async () => {
    await mount([retitle("Agent title")]);
    expect(pill("opening").hidden).toBe(false);
    expect(pill("method").hidden).toBe(true);
    expect(pick("opening").getAttribute("aria-label")).toContain("1 change to review");
    expect(pick("method").hasAttribute("aria-label")).toBe(false);
  });

  it("lets go of the mark when the change is answered", async () => {
    await mount([retitle("Agent title")]);
    open();
    act(TITLE, "accept-change").click();
    await vi.waitFor(() => expect(pill("opening").hidden).toBe(true));
    expect(pick("opening").hasAttribute("aria-label")).toBe(false);
  });

  it("counts the changes of a scene in its name for assistive technology", async () => {
    await mount([
      retitle("Agent title"),
      { op: "block.set", scene: "opening", id: "opening-sub", set: { text: "New subtitle" } },
    ]);
    expect(pick("opening").getAttribute("aria-label")).toContain("2 changes to review");
  });
});
