// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

const at = "2026-11-05T10:00:00.000Z";
const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  time: at,
  by: "agent" as const,
  kind: "edit" as const,
  summary: `change ${id}`,
  ...over,
});

async function mount(...entries: ReturnType<typeof entry>[]) {
  server = new FakeServer();
  server.audit = entries;
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
}

afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
});

const button = (action: string) =>
  host.querySelector<HTMLButtonElement>(`[data-action='${action}']`) as HTMLButtonElement;
const items = () => [...host.querySelectorAll<HTMLElement>(".ed-ai")];
const ids = () => items().map((item) => item.dataset.id);
const empty = () => host.querySelector<HTMLElement>(".ed-ai-empty") as HTMLElement;

async function openHistory() {
  button("review").click();
  button("tab-history").click();
  await vi.waitFor(() => expect(store.audit.state.ready).toBe(true));
}

describe("the History tab", () => {
  it("reads nothing until it is opened", async () => {
    await mount(entry("a", { scene: "opening" }));
    button("review").click();
    expect(server.auditLoads).toBe(0);
    button("tab-history").click();
    await vi.waitFor(() => expect(server.auditLoads).toBe(1));
  });

  it("lists the current slide's entries newest first, and follows the selection", async () => {
    await mount(
      entry("a", { scene: "opening" }),
      entry("b", { scene: "method" }),
      entry("c", { scene: "opening", by: "you" }),
    );
    await openHistory();
    expect(ids()).toEqual(["c", "a"]);
    (host.querySelector(".ed-scene-list > li[data-id='method'] .ed-scene") as HTMLElement).click();
    expect(ids()).toEqual(["b"]);
  });

  it("lists every slide's entries under All slides, and filters them by who made them", async () => {
    await mount(
      entry("a", { scene: "opening" }),
      entry("b", { scene: "method" }),
      entry("c", { scene: "opening", by: "you" }),
    );
    await openHistory();
    button("log-all-slides").click();
    expect(ids()).toEqual(["c", "b", "a"]);
    const who = button("log-by") as unknown as HTMLSelectElement;
    who.value = "agent";
    who.dispatchEvent(new Event("change"));
    expect(ids()).toEqual(["b", "a"]);
  });

  it("goes to the slide and the block an entry names", async () => {
    await mount(entry("a", { scene: "method", block: "method-body" }));
    await openHistory();
    button("log-all-slides").click();
    button("go-to-slide").click();
    expect(editor.sceneId).toBe("method");
    expect(editor.blockId).toBe("method-body");
  });

  it("disables the button of an entry whose slide is gone", async () => {
    await mount(entry("a", { scene: "deleted-scene" }));
    await openHistory();
    button("log-all-slides").click();
    expect(button("go-to-slide").disabled).toBe(true);
  });

  it("says so when the current slide has nothing logged, and when the log cannot be read", async () => {
    await mount(entry("a", { scene: "method" }));
    await openHistory();
    expect(empty().textContent).toContain("Nothing has happened on slide opening yet.");
    server.auditBroken = "The editor could not reach the server.";
    await store.audit.sync();
    expect(empty().textContent).toContain("The history cannot be read.");
  });

  it("reads the log again when the server says it changed, once it has been opened", async () => {
    await mount(entry("a", { scene: "opening" }));
    await store.audit.refresh();
    expect(server.auditLoads).toBe(0);
    await openHistory();
    server.audit = [...server.audit, entry("b", { scene: "opening" })];
    await store.audit.refresh();
    expect(ids()).toEqual(["b", "a"]);
  });
});
