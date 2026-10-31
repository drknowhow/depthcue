// @vitest-environment happy-dom
import { type Cue, MARKER_TYPE, memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

const SOURCE = "assets/talk.mp4";
const layer = (id: string, start: number, end = start + 1): Cue => ({
  id,
  type: "circle",
  in: start,
  out: end,
});
const marker = (id: string, start: number, end = 10): Cue => ({ id, type: MARKER_TYPE, in: start, out: end });

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

const flush = () => new Promise((done) => setTimeout(done, 0));
const toolbar = () => host.querySelector<HTMLElement>(".ed-toolbar") as HTMLElement;
const part = <T extends HTMLElement = HTMLElement>(name: string) =>
  toolbar().querySelector(`[data-tb='${name}']`) as T;
const blockNode = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-frame [data-id='${id}']`) as HTMLElement;
const popover = () =>
  part("cues").closest(".ed-tb-chip-wrap")?.querySelector<HTMLElement>(".ed-tb-pop") as HTMLElement;
const control = <T extends HTMLElement = HTMLInputElement>(key: string): T => {
  const found = popover().querySelector<T>(`[data-field="${key}"]`);
  if (!found) throw new Error(`no control with data-field ${key} in the Cues popover`);
  return found;
};
const rows = () => [...popover().querySelectorAll<HTMLElement>(".ed-cue-row")];
const slideChips = () => [
  ...blockNode("method-clip").querySelectorAll<HTMLElement>(".dc-clip-cues [data-cue]"),
];
const hintText = () => host.querySelector(".ed-hint")?.textContent ?? "";
const video = () => blockNode("method-clip").querySelector("video") as HTMLVideoElement;
/** Puts the playhead of the video on the slide at `seconds`, as playing and pausing would. */
const playheadAt = (seconds: number) =>
  Object.defineProperty(video(), "currentTime", { value: seconds, writable: true, configurable: true });
const saved = () => server.cueMaps[SOURCE]?.cues.map((cue) => `${cue.id}@${cue.in}`);
const change = (node: HTMLInputElement, value: string) => {
  node.value = value;
  node.dispatchEvent(new Event("change", { bubbles: true }));
};
const open = async () => {
  blockNode("method-clip").click();
  part("cues").click();
  await flush();
};

async function mount() {
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select("method");
  server.assets.push(SOURCE, "assets/other.mp4");
  store.session.addAssets([SOURCE, "assets/other.mp4"]);
  store.session.apply([
    {
      op: "block.add",
      scene: "method",
      block: { id: "method-clip", type: "clip", source: SOURCE, alt: "The talk" },
    },
  ]);
  await flush();
}

beforeEach(() => {
  server = new FakeServer();
});
afterEach(() => editor.destroy());

describe("the cues of a clip", () => {
  beforeEach(async () => {
    server.cueMaps[SOURCE] = {
      duration: 10,
      width: 1280,
      height: 720,
      cues: [layer("dot", 0, 2), marker("marker-1", 3.5)],
    };
    await mount();
  });

  it("shows a Cues chip on the clip's toolbar, with the number of places to jump to", async () => {
    blockNode("method-clip").click();
    expect(part("cues").textContent).toContain("Cues");
    expect(part("cues").querySelector(".ed-tb-n")?.textContent).toBe("2");
    expect(part("cues").getAttribute("aria-label")).toBe("Cues, 2 to jump to");
    expect(part("edit")).toBeTruthy();
  });

  it("draws a chip for each cue under the clip, with the markers set apart", () => {
    expect(slideChips().map((chip) => chip.dataset.cue)).toEqual(["dot", "marker-1"]);
    expect(slideChips().map((chip) => chip.hasAttribute("data-marker"))).toEqual([false, true]);
    expect(slideChips()[1]?.getAttribute("aria-label")).toBe("marker-1, at 0:03");
    expect(blockNode("method-clip").querySelector(".dc-clip-cues")?.getAttribute("aria-label")).toBe(
      "Jump to",
    );
  });

  it("takes the video to a cue, and chooses the clip, when its chip is pressed", () => {
    playheadAt(0);
    slideChips()[1]?.click();
    expect(video().currentTime).toBe(3.5);
    expect(blockNode("method-clip").hasAttribute("data-selected")).toBe(true);
  });

  it("is a group, not a button, because it holds a player and chips of its own", () => {
    expect(blockNode("method-clip").getAttribute("role")).toBe("group");
  });

  it("lists every cue in the popover, and gives fields to the markers only", async () => {
    await open();
    expect(rows().map((row) => row.dataset.cue)).toEqual(["dot", "marker-1"]);
    const [scene, own] = rows();
    expect(scene?.querySelector("input")).toBeNull();
    expect(scene?.textContent).toContain("circle");
    expect(own?.querySelectorAll("input")).toHaveLength(2);
    expect(control("cue:name:marker-1").value).toBe("marker-1");
    expect(control("cue:time:marker-1").value).toBe("3.5");
    expect(own?.querySelector("[data-tb='cue-here']")).toBeTruthy();
    expect(own?.querySelector("[data-tb='cue-remove']")?.getAttribute("aria-label")).toBe(
      "Remove marker marker-1",
    );
    // The bin is the one the rest of the toolbar uses, so it looks like the other removes.
    expect(own?.querySelector("[data-tb='cue-remove']")?.classList.contains("ed-tb-remove")).toBe(true);
  });

  it("takes the video to a cue from the popover too", async () => {
    await open();
    playheadAt(0);
    control<HTMLButtonElement>("cue:go:dot").click();
    expect(video().currentTime).toBe(0);
    control<HTMLButtonElement>("cue:go:marker-1").click();
    expect(video().currentTime).toBe(3.5);
    expect(control("cue:go:marker-1").getAttribute("aria-label")).toBe("Go to marker-1, at 0:03");
  });

  describe("adding a marker", () => {
    it("puts one at the playhead, and moves the keyboard to its name", async () => {
      await open();
      playheadAt(7.25);
      popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.click();
      await flush();
      expect(saved()).toEqual(["dot@0", "marker-1@3.5", "marker-2@7.25"]);
      expect(rows().map((row) => row.dataset.cue)).toEqual(["dot", "marker-1", "marker-2"]);
      expect(document.activeElement).toBe(control("cue:name:marker-2"));
      expect(slideChips().map((chip) => chip.dataset.cue)).toEqual(["dot", "marker-1", "marker-2"]);
      expect(part("cues").querySelector(".ed-tb-n")?.textContent).toBe("3");
    });

    it("does not draw the video again, so it keeps its place", async () => {
      await open();
      const before = video();
      playheadAt(7.25);
      popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.click();
      await flush();
      expect(video()).toBe(before);
      expect(video().currentTime).toBe(7.25);
    });

    it("is not part of the deck, or of the Undo of the top bar", async () => {
      await open();
      const saves = server.saves.length;
      popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.click();
      await flush();
      expect(server.saves).toHaveLength(saves);
      // The last change to the deck is still the clip being added, so that is what Undo takes back.
      store.session.undo();
      expect(store.session.doc.scenes.method?.blocks.some((block) => block.id === "method-clip")).toBe(false);
    });

    it("does not move the keyboard to a later marker when the add was refused", async () => {
      await open();
      server.nextCueSaveFails = "The disk is full.";
      popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.click();
      await flush();
      expect(hintText()).toBe("The disk is full.");
      // Another marker turns up under the name the refused one would have had, and the next redraw shows it.
      server.cueMaps[SOURCE]?.cues.push(marker("marker-2", 8));
      change(control("cue:name:marker-1"), "the reveal");
      await flush();
      expect(rows().map((row) => row.dataset.cue)).toEqual(["dot", "the reveal", "marker-2"]);
      expect(document.activeElement).not.toBe(control("cue:name:marker-2"));
    });

    it("says so, and writes nothing, when the clip is not on the slide", async () => {
      await open();
      blockNode("method-clip").querySelector("video")?.remove();
      popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.click();
      await flush();
      expect(hintText()).toBe("There is no video on the slide to read the time from.");
      expect(server.cueSaves).toEqual([]);
    });
  });

  describe("editing a marker", () => {
    beforeEach(open);

    it("renames it from its field", async () => {
      change(control("cue:name:marker-1"), "the reveal");
      await flush();
      expect(saved()).toEqual(["dot@0", "the reveal@3.5"]);
      expect(slideChips().map((chip) => chip.dataset.cue)).toEqual(["dot", "the reveal"]);
    });

    it("puts the old name back, and says why, when the new one is refused", async () => {
      change(control("cue:name:marker-1"), "dot");
      await flush();
      expect(hintText()).toBe('Two cues are called "dot". Ids must differ.');
      expect(control("cue:name:marker-1").value).toBe("marker-1");
      expect(saved()).toEqual(["dot@0", "marker-1@3.5"]);
    });

    it("moves it to a typed time, and puts it in time order", async () => {
      change(control("cue:time:marker-1"), "0");
      await flush();
      expect(saved()).toEqual(["dot@0", "marker-1@0"]);
      change(control("cue:time:marker-1"), "6.5");
      await flush();
      expect(saved()).toEqual(["dot@0", "marker-1@6.5"]);
    });

    it("puts the old time back when the server refuses the new one", async () => {
      server.nextCueSaveFails = "The disk is full.";
      change(control("cue:time:marker-1"), "6.5");
      await flush();
      expect(hintText()).toBe("The disk is full.");
      expect(control("cue:time:marker-1").value).toBe("3.5");
      expect(saved()).toEqual(["dot@0", "marker-1@3.5"]);
    });

    it("puts the old time back when what was typed is not a time", async () => {
      change(control("cue:time:marker-1"), "soon");
      await flush();
      expect(hintText()).toBe("Enter a time in seconds.");
      expect(control("cue:time:marker-1").value).toBe("3.5");
      expect(server.cueSaves).toEqual([]);
    });

    it("moves it to the playhead with Here", async () => {
      playheadAt(8.125);
      control<HTMLButtonElement>("cue:go:marker-1")
        .closest(".ed-cue-row")
        ?.querySelector<HTMLButtonElement>("[data-tb='cue-here']")
        ?.click();
      await flush();
      expect(saved()).toEqual(["dot@0", "marker-1@8.125"]);
    });

    it("removes it", async () => {
      popover().querySelector<HTMLButtonElement>("[data-tb='cue-remove']")?.click();
      await flush();
      expect(saved()).toEqual(["dot@0"]);
      expect(rows().map((row) => row.dataset.cue)).toEqual(["dot"]);
      expect(slideChips().map((chip) => chip.dataset.cue)).toEqual(["dot"]);
    });

    it("takes the last change back with Undo marker change, which starts out unavailable", async () => {
      const undo = () =>
        popover().querySelector<HTMLButtonElement>("[data-tb='cue-undo']") as HTMLButtonElement;
      expect(undo().disabled).toBe(true);
      change(control("cue:name:marker-1"), "the reveal");
      await flush();
      expect(undo().disabled).toBe(false);
      undo().click();
      await flush();
      expect(saved()).toEqual(["dot@0", "marker-1@3.5"]);
      expect(undo().disabled).toBe(true);
    });

    it("says what the server said when it refuses to save", async () => {
      server.nextCueSaveFails = "The disk is full.";
      popover().querySelector<HTMLButtonElement>("[data-tb='cue-remove']")?.click();
      await flush();
      expect(hintText()).toBe("The disk is full.");
      expect(saved()).toEqual(["dot@0", "marker-1@3.5"]);
    });
  });

  it("loads the cues of another video when the clip is pointed at it", async () => {
    server.cueMaps["assets/other.mp4"] = {
      duration: 4,
      width: 640,
      height: 360,
      cues: [layer("intro", 0, 1)],
    };
    store.session.apply([
      { op: "block.set", scene: "method", id: "method-clip", set: { source: "assets/other.mp4" } },
    ]);
    await flush();
    expect(server.cueLoads).toContain("assets/other.mp4");
    expect(slideChips().map((chip) => chip.dataset.cue)).toEqual(["intro"]);
  });
});

describe("a clip with no cue map", () => {
  beforeEach(async () => {
    await mount();
    await open();
  });

  it("shows no chips on the slide and no number on the chip, and says how a map starts", () => {
    expect(slideChips()).toEqual([]);
    expect(part("cues").querySelector(".ed-tb-n")?.textContent).toBe("");
    expect(popover().querySelector("[data-cue-state='none']")?.textContent).toContain(
      "first marker starts one",
    );
    expect(rows()).toEqual([]);
  });

  it("starts one from what the video on the slide measures", async () => {
    playheadAt(2);
    Object.defineProperties(video(), {
      duration: { value: 8, configurable: true },
      videoWidth: { value: 640, configurable: true },
      videoHeight: { value: 360, configurable: true },
    });
    popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.click();
    await flush();
    expect(server.cueSaves.at(-1)).toMatchObject({
      source: SOURCE,
      clip: { duration: 8, width: 640, height: 360 },
    });
    expect(saved()).toEqual(["marker-1@2"]);
    expect(slideChips().map((chip) => chip.dataset.cue)).toEqual(["marker-1"]);
  });

  it("says so when the length of the video cannot be read, and writes nothing", async () => {
    playheadAt(2);
    // A file that will not load answers with an error from the video that asks about it.
    const asked: HTMLVideoElement[] = [];
    const create = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      const node = create(tag);
      if (tag === "video") asked.push(node as HTMLVideoElement);
      return node;
    }) as typeof document.createElement;
    try {
      popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.click();
      asked[0]?.dispatchEvent(new Event("error"));
      await flush();
    } finally {
      document.createElement = create;
    }
    expect(asked).toHaveLength(1);
    expect(hintText()).toBe("The length of the video could not be read. Press play on it, then try again.");
    expect(server.cueSaves).toEqual([]);
  });
});

describe("a cue file the editor cannot read", () => {
  it("leaves it alone: the marker button is off and the popover says why", async () => {
    server.brokenCues.add(SOURCE);
    await mount();
    await open();
    expect(popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.disabled).toBe(true);
    expect(popover().querySelector("[data-cue-state='broken']")?.textContent).toContain(
      "assets/talk.cues.json is not a cue file the editor can read",
    );
    expect(slideChips()).toEqual([]);
  });
});

describe("cues that could not be loaded", () => {
  it("say so, and are asked for again with Try again", async () => {
    server.cueLoadFails = true;
    await mount();
    await open();
    expect(popover().textContent).toContain("The cues could not be read.");
    expect(popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.disabled).toBe(true);
    server.cueLoadFails = false;
    server.cueMaps[SOURCE] = { duration: 10, width: 1280, height: 720, cues: [layer("dot", 0, 2)] };
    popover().querySelector<HTMLButtonElement>("[data-tb='cue-retry']")?.click();
    await flush();
    expect(rows().map((row) => row.dataset.cue)).toEqual(["dot"]);
    expect(slideChips().map((chip) => chip.dataset.cue)).toEqual(["dot"]);
  });

  it("say they are being read while the server has not answered", async () => {
    let release = () => {};
    server.cueGate = new Promise<void>((done) => {
      release = done;
    });
    await mount();
    blockNode("method-clip").click();
    part("cues").click();
    expect(popover().textContent).toContain("Reading the cues…");
    expect(popover().querySelector<HTMLButtonElement>("[data-tb='cue-add']")?.disabled).toBe(true);
    release();
    await flush();
    expect(popover().textContent).not.toContain("Reading the cues…");
  });
});
