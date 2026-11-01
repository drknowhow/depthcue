// @vitest-environment happy-dom
import { memoryDraftStore, type Op } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiDiagnostic } from "../src/api.ts";
import { createLayoutWatch, type LayoutWatch } from "../src/layout-watch.ts";
import { problemsOf } from "../src/ribbon.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

let server: FakeServer;
let store: EditorStore;
let watch: LayoutWatch | undefined;
let shown = "opening";
let changes = 0;

const quiet = { quietMs: 1, retryMs: 40 };
const start = (options: { quietMs?: number; retryMs?: number } = quiet) => {
  watch = createLayoutWatch(
    store,
    {
      scene: () => shown,
      changed: () => {
        changes += 1;
      },
    },
    options,
  );
  return watch;
};

const overflow = (
  at: string,
  message = "The scene is 40px taller than the 1280x720 stage.",
): ApiDiagnostic => ({
  code: "overflow",
  at,
  severity: "error",
  message,
});
const edit = (text: string): Op => ({
  op: "block.set",
  scene: "method",
  id: "method-body",
  set: { text },
});
const settle = (ms = 30) => new Promise((done) => setTimeout(done, ms));

beforeEach(async () => {
  server = new FakeServer();
  store = await openStore(server, () => memoryDraftStore());
  shown = "opening";
  changes = 0;
});
afterEach(() => {
  watch?.destroy();
  watch = undefined;
  store.dispose();
});

describe("the layout watch", () => {
  it("asks about the scene on show first and then the others in deck order, one question at a time", async () => {
    shown = "demand";
    start();
    await vi.waitFor(() => expect(server.layoutCalls).toHaveLength(3));
    expect(server.layoutCalls).toEqual(["demand", "opening", "method"]);
  });

  it("asks about a scene once, however many times the deck is looked at", async () => {
    start();
    await vi.waitFor(() => expect(server.layoutCalls).toHaveLength(3));
    await settle();
    expect(server.layoutCalls).toHaveLength(3);
  });

  it("takes what a render found, names the block it is about, and says so when it has an answer", async () => {
    server.layouts.method = [overflow("scenes/method.json/blocks/1")];
    const before = changes;
    const current = start();
    await vi.waitFor(() => expect(current.of("method")).toHaveLength(1));
    expect(current.of("method")).toEqual([
      { code: "overflow", message: overflow("").message, block: "method-body" },
    ]);
    expect(current.of("opening")).toEqual([]);
    expect(changes).toBeGreaterThan(before);
  });

  it("names no block for a problem of the scene as a whole", async () => {
    server.layouts.method = [overflow("scenes/method.json")];
    const current = start();
    await vi.waitFor(() => expect(current.of("method")).toHaveLength(1));
    expect(current.of("method")[0]?.block).toBeUndefined();
  });

  it("waits while the deck has changes that are not saved, because a render shows the files on disk", async () => {
    start();
    await vi.waitFor(() => expect(server.layoutCalls).toHaveLength(3));
    server.layoutCalls.length = 0;
    store.session.apply([edit("A different method.")]);
    await settle(40);
    expect(server.layoutCalls).toEqual([]);
    await store.save();
    await vi.waitFor(() => expect(server.layoutCalls).toEqual(["method"]));
  });

  it("asks again about the scene that changed and no other", async () => {
    start();
    await vi.waitFor(() => expect(server.layoutCalls).toHaveLength(3));
    server.layoutCalls.length = 0;
    store.session.apply([edit("Shorter.")]);
    await store.save();
    await vi.waitFor(() => expect(server.layoutCalls.length).toBeGreaterThan(0));
    await settle();
    expect(server.layoutCalls).toEqual(["method"]);
  });

  it("asks again about every scene when the deck's own settings change, because a theme is on all of them", async () => {
    start();
    await vi.waitFor(() => expect(server.layoutCalls).toHaveLength(3));
    server.layoutCalls.length = 0;
    store.session.apply([{ op: "deck.set", set: { theme: "ink" } }]);
    await store.save();
    await vi.waitFor(() => expect(server.layoutCalls).toHaveLength(3));
    expect([...server.layoutCalls].sort()).toEqual(["demand", "method", "opening"]);
  });

  it("keeps the last answer for a scene until the next one comes, so a problem does not blink while someone types", async () => {
    server.layouts.method = [overflow("scenes/method.json/blocks/1")];
    const current = start();
    await vi.waitFor(() => expect(current.of("method")).toHaveLength(1));
    let release: () => void = () => {};
    server.layoutGate = new Promise<void>((done) => {
      release = done;
    });
    server.layouts.method = [];
    server.layoutCalls.length = 0;
    store.session.apply([edit("Short enough now.")]);
    await store.save();
    // The new question is out and unanswered, and the old answer is still what the ribbon has.
    await vi.waitFor(() => expect(server.layoutCalls).toEqual(["method"]));
    expect(current.of("method")).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(current.of("method")).toEqual([]));
  });

  it("drops an answer that was about text that has changed since the question was sent", async () => {
    let release: () => void = () => {};
    server.layoutGate = new Promise<void>((done) => {
      release = done;
    });
    server.layouts.opening = [overflow("scenes/opening.json/blocks/0")];
    const current = start();
    await vi.waitFor(() => expect(server.layoutCalls).toEqual(["opening"]));
    store.session.apply([
      { op: "block.set", scene: "opening", id: "opening-title", set: { text: "A new headline" } },
    ]);
    release();
    await settle(40);
    expect(current.of("opening")).toEqual([]);
  });

  it("does not list a problem on a block that has since gone", async () => {
    server.layouts.method = [overflow("scenes/method.json/blocks/1")];
    const current = start();
    await vi.waitFor(() => expect(current.of("method")).toHaveLength(1));
    store.session.apply([{ op: "block.remove", scene: "method", id: "method-body" }]);
    const listed = problemsOf(store.session, current.of).filter((problem) => problem.scene === "method");
    expect(listed.map((problem) => problem.block)).not.toContain("method-body");
  });

  it("leaves the editor as it was on a server with no browser, and tries again only after a while", async () => {
    server.noRender = true;
    const current = start({ quietMs: 1, retryMs: 400 });
    await vi.waitFor(() => expect(server.layoutCalls).toHaveLength(1));
    await settle(100);
    expect(server.layoutCalls).toHaveLength(1);
    expect(current.of("opening")).toEqual([]);
    expect(changes).toBe(0);
    server.noRender = false;
    await vi.waitFor(() => expect(server.layoutCalls.length).toBeGreaterThan(1), { timeout: 2000 });
  });

  it("asks nothing more once it is destroyed", async () => {
    const current = start({ quietMs: 30 });
    current.destroy();
    await settle(60);
    expect(server.layoutCalls).toEqual([]);
  });
});
