// @vitest-environment happy-dom
import { type CommentOp, memoryDraftStore } from "@depthcue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { notLoaded, PARTS, type Part, type Parts, part } from "../src/lazy.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer, retitle } from "./helpers.ts";

/** A part whose every fetch waits for the test to let it arrive, or to make it fail as a dropped server would. */
function stub<T>(module: T) {
  const fetches: Array<{ arrive(): void; fail(): void }> = [];
  const from: Part<T> = part(
    () =>
      new Promise<T>((ok, no) =>
        fetches.push({
          arrive: () => ok(module),
          fail: () => no(new TypeError("Failed to fetch dynamically imported module")),
        }),
      ),
  );
  const last = () => fetches.at(-1) as { arrive(): void; fail(): void };
  return { from, fetches, arrive: () => last().arrive(), fail: () => last().fail() };
}

const flush = () => new Promise((done) => setTimeout(done, 0));
const real = async <K extends keyof Parts>(name: K) => {
  const module = await PARTS[name].load();
  if (!module) throw new Error(`the ${name} part should load in a test`);
  return module as NonNullable<Parts[K]["ready"]>;
};

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor | undefined;

async function mount(parts: Partial<Parts>, seed: CommentOp[] = [], before?: (fake: FakeServer) => void) {
  server = new FakeServer();
  if (seed.length > 0) server.externalComment(seed);
  before?.(server);
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store, { ...PARTS, ...parts });
}

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  vi.restoreAllMocks();
});

const hint = () => host.querySelector<HTMLElement>(".ed-hint") as HTMLElement;
const action = (name: string) =>
  host.querySelector<HTMLButtonElement>(`[data-action='${name}']`) as HTMLButtonElement;
const blockNode = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-frame [data-id='${id}']`) as HTMLElement;
/** The editor goes on working while a part is away: an edit still lands on the slide. */
const stillEdits = (text: string) => {
  editor?.select("opening");
  expect(store.session.apply([retitle(text)]).ok).toBe(true);
  expect(blockNode("opening-title").textContent).toContain(text);
};

describe("a part of the editor", () => {
  it("is fetched once however many ask for it, and is ready once it is in", async () => {
    const parts = stub("the module");
    const asks = [parts.from.load(), parts.from.load()];
    expect(parts.fetches).toHaveLength(1);
    expect(parts.from.ready).toBeUndefined();
    parts.arrive();
    expect(await Promise.all(asks)).toEqual(["the module", "the module"]);
    expect(parts.from.ready).toBe("the module");
    await parts.from.load();
    expect(parts.fetches).toHaveLength(1);
  });

  it("answers undefined when it does not arrive, and the next use fetches it again", async () => {
    const parts = stub("the module");
    const first = parts.from.load();
    parts.fail();
    expect(await first).toBeUndefined();
    expect(parts.from.ready).toBeUndefined();
    const second = parts.from.load();
    expect(parts.fetches).toHaveLength(2);
    parts.arrive();
    expect(await second).toBe("the module");
  });

  it("says what did not load, and what to do, in plain words", () => {
    expect(notLoaded("the storyboard")).toBe(
      "Could not load the storyboard. Check that depthcue edit is still running, then try again.",
    );
  });
});

describe("the list of changes, a part fetched when it is first opened", () => {
  const drawer = () => host.querySelector<HTMLElement>("#ed-review");

  it("is not fetched until it is opened, and opens when it arrives", async () => {
    const parts = stub(await real("review"));
    await mount({ review: parts.from });
    expect(parts.fetches).toHaveLength(0);
    expect(drawer()).toBeNull();
    action("review").click();
    expect(parts.fetches).toHaveLength(1);
    stillEdits("Typed while it loads");
    parts.arrive();
    await flush();
    expect(drawer()?.hidden).toBe(false);
    expect(action("review").getAttribute("aria-expanded")).toBe("true");
  });

  it("says so in plain words when it does not arrive, and the next press tries again", async () => {
    const parts = stub(await real("review"));
    await mount({ review: parts.from });
    action("review").click();
    parts.fail();
    await flush();
    expect(hint().textContent).toBe(notLoaded("the list of changes"));
    expect(hint().hasAttribute("data-problem")).toBe(true);
    expect(drawer()).toBeNull();
    stillEdits("Still editing");
    action("review").click();
    expect(parts.fetches).toHaveLength(2);
    parts.arrive();
    await flush();
    expect(drawer()?.hidden).toBe(false);
  });
});

describe("the storyboard, a part fetched when it is first opened", () => {
  const board = () => host.querySelector<HTMLElement>(".ed-board");

  it("opens when it arrives, with every scene on it", async () => {
    const parts = stub(await real("storyboard"));
    await mount({ storyboard: parts.from });
    expect(board()).toBeNull();
    action("storyboard").click();
    stillEdits("Typed while it loads");
    parts.arrive();
    await flush();
    expect(board()?.hidden).toBe(false);
    expect(board()?.querySelectorAll(".ed-card")).toHaveLength(store.session.doc.deck.scenes.length);
  });

  it("says so when it does not arrive, and the editor goes on", async () => {
    const parts = stub(await real("storyboard"));
    await mount({ storyboard: parts.from });
    action("storyboard").click();
    parts.fail();
    await flush();
    expect(hint().textContent).toBe(notLoaded("the storyboard"));
    expect(board()).toBeNull();
    stillEdits("Still editing");
  });
});

describe("the comment pins, a part fetched once there is a comment or the Comment tool is taken", () => {
  const quick = () => host.querySelector<HTMLButtonElement>("[data-quick='comment']") as HTMLButtonElement;
  const note: CommentOp = {
    op: "comment.add",
    scene: "opening",
    block: "opening-title",
    anchor: { x: 0.25, y: 0.5 },
    author: "you",
    text: "Shorter?",
  };

  it("is not fetched for a deck with no comments until the tool is taken, which is on when it arrives", async () => {
    const parts = stub(await real("comments"));
    await mount({ comments: parts.from });
    await vi.waitFor(() => expect(store.comments.state.ready).toBe(true));
    expect(parts.fetches).toHaveLength(0);
    quick().click();
    expect(parts.fetches).toHaveLength(1);
    expect(quick().getAttribute("aria-pressed")).toBe("true");
    parts.arrive();
    await flush();
    expect(host.querySelector(".ed-comment-catch")).not.toBeNull();
    expect(quick().getAttribute("aria-pressed")).toBe("true");
  });

  it("is fetched for a deck that has comments, and draws their pins when it arrives", async () => {
    const parts = stub(await real("comments"));
    await mount({ comments: parts.from }, [note]);
    await vi.waitFor(() => expect(parts.fetches).toHaveLength(1));
    expect(host.querySelector(".ed-pin")).toBeNull();
    parts.arrive();
    await vi.waitFor(() => expect(host.querySelectorAll(".ed-pin")).toHaveLength(1));
  });

  it("turns the tool off again and says so when it does not arrive", async () => {
    const parts = stub(await real("comments"));
    await mount({ comments: parts.from });
    await vi.waitFor(() => expect(store.comments.state.ready).toBe(true));
    quick().click();
    parts.fail();
    await flush();
    expect(quick().getAttribute("aria-pressed")).toBe("false");
    expect(hint().textContent).toBe(notLoaded("the comments"));
    stillEdits("Still editing");
    quick().click();
    expect(parts.fetches).toHaveLength(2);
  });
});

describe("templates and styles, a part fetched when first wanted", () => {
  const picker = () => host.querySelector<HTMLDialogElement>("dialog[data-dialog='picker']");
  const slots = () => host.querySelectorAll(".ed-canvas-host .ed-slot");
  const quoteScene = {
    id: "said",
    title: "Said",
    template: "quote",
    blocks: [
      {
        id: "said-quote",
        type: "text" as const,
        role: "quote" as const,
        text: "Less, but better.",
        slot: "quote",
      },
    ],
  };

  it("is not fetched for a deck with no template scene until the picker is opened, which opens when it arrives", async () => {
    const parts = stub(await real("brand"));
    await mount({ brand: parts.from });
    expect(parts.fetches).toHaveLength(0);
    action("pick-template").click();
    expect(parts.fetches).toHaveLength(1);
    expect(picker()).toBeNull();
    stillEdits("Typed while it loads");
    parts.arrive();
    await flush();
    expect(picker()).not.toBeNull();
  });

  it("says so when it does not arrive, the editor goes on, and the next press tries again", async () => {
    const parts = stub(await real("brand"));
    await mount({ brand: parts.from });
    action("pick-template").click();
    parts.fail();
    await flush();
    expect(hint().textContent).toBe(notLoaded("the templates and styles"));
    expect(picker()).toBeNull();
    stillEdits("Still editing");
    action("pick-template").click();
    expect(parts.fetches).toHaveLength(2);
    parts.arrive();
    await flush();
    expect(picker()).not.toBeNull();
  });

  it("draws a template scene's empty slots once it arrives", async () => {
    const parts = stub(await real("brand"));
    await mount({ brand: parts.from });
    expect(store.session.apply([{ op: "scene.add", scene: quoteScene, after: null }]).ok).toBe(true);
    editor?.select("said");
    expect(parts.fetches).toHaveLength(1);
    expect(slots()).toHaveLength(0);
    parts.arrive();
    await flush();
    expect([...slots()].map((slot) => (slot as HTMLElement).dataset.slot)).toEqual(["attribution"]);
  });

  it("says once when the slots cannot be drawn, and the slide goes on without them", async () => {
    const parts = stub(await real("brand"));
    await mount({ brand: parts.from });
    store.session.apply([{ op: "scene.add", scene: quoteScene, after: null }]);
    editor?.select("said");
    parts.fail();
    await flush();
    expect(hint().textContent).toBe(notLoaded("the templates and styles"));
    store.session.apply([retitle("Edited")]);
    expect(parts.fetches).toHaveLength(1);
    expect(blockNode("said-quote").textContent).toContain("Less, but better.");
  });

  it("is fetched quietly once a block is chosen, so the right-click menu can list the styles", async () => {
    const parts = stub(await real("brand"));
    await mount({ brand: parts.from });
    editor?.select("method");
    blockNode("method-diagram").click();
    expect(parts.fetches).toHaveLength(1);
    parts.fail();
    await flush();
    expect(hint().hasAttribute("data-problem")).toBe(false);
  });
});

describe("the cue editor, a part fetched when a clip's Cues chip is first filled", () => {
  const SOURCE = "assets/talk.mp4";
  const chip = () =>
    host.querySelector<HTMLButtonElement>(".ed-toolbar [data-tb='cues']") as HTMLButtonElement;
  const pop = () =>
    chip().closest(".ed-tb-chip-wrap")?.querySelector<HTMLElement>(".ed-tb-pop") as HTMLElement;

  async function withClip(parts: ReturnType<typeof stub>) {
    await mount({ cues: parts.from as Parts["cues"] }, [], (fake) => {
      fake.cueMaps[SOURCE] = {
        duration: 10,
        width: 1280,
        height: 720,
        cues: [{ id: "dot", type: "circle", in: 0, out: 2 }],
      };
    });
    editor?.select("method");
    server.assets.push(SOURCE);
    store.session.addAssets([SOURCE]);
    store.session.apply([
      {
        op: "block.add",
        scene: "method",
        block: { id: "method-clip", type: "clip", source: SOURCE, alt: "The talk" },
      },
    ]);
    await flush();
    blockNode("method-clip").click();
    chip().click();
    await flush();
  }

  it("shows the chip at once, and the editor in its popover when the part arrives", async () => {
    const parts = stub<unknown>(await real("cues"));
    await withClip(parts);
    expect(chip().textContent).toContain("Cues");
    expect(pop().textContent).toContain("Loading");
    parts.arrive();
    await flush();
    expect(pop().textContent).not.toContain("Loading");
    expect(pop().querySelectorAll(".ed-cue-row")).toHaveLength(1);
  });

  it("says so in the popover when the part does not arrive", async () => {
    const parts = stub<unknown>(await real("cues"));
    await withClip(parts);
    parts.fail();
    await flush();
    expect(pop().textContent).toBe(notLoaded("the cue editor"));
    stillEdits("Still editing");
  });
});
