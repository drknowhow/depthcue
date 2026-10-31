// @vitest-environment happy-dom
import type { Block, Scene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrate } from "../src/modules/clip.ts";
import type { HydrateContext, ModuleInstance } from "../src/modules.ts";
import { renderScene } from "../src/scene.ts";
import { demoSource, sceneWith } from "./helpers.ts";

const cueMap = {
  format: "depthcue-cues/1",
  source: "assets/intro.mp4",
  duration: 4.2,
  width: 960,
  height: 540,
  fps: 30,
  cues: [
    { id: "dot", type: "circle", in: 0, out: 1.1 },
    { id: "title", type: "text", in: 1, out: 4.2 },
    { id: "sub", type: "text", in: 1.8, out: 4.2 },
  ],
};

let root: HTMLElement;
let instance: ModuleInstance | undefined;
let announced: string[];
let fetched: Array<{ url: string; signal: AbortSignal | undefined }>;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  announced = [];
  fetched = [];
});

afterEach(() => {
  instance?.dispose?.();
  instance = undefined;
  root.remove();
  vi.unstubAllGlobals();
});

type Answer = { ok?: boolean; json?: () => Promise<unknown> } | Error;

function answer(reply: Answer) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      fetched.push({ url, signal: init?.signal });
      if (reply instanceof Error) throw reply;
      return { ok: reply.ok ?? true, json: reply.json ?? (async () => cueMap) };
    }),
  );
}

const clipScene = (source = "assets/intro.mp4"): Scene =>
  sceneWith({
    id: "clips",
    layout: "text-media",
    blocks: [{ id: "intro-clip", type: "clip", source, poster: "assets/intro.png", alt: "The opening" }],
  });

/** Renders the clip as the player does, gives its video a clock the test controls, then hydrates. */
async function mount(scene = clipScene()) {
  root.append(renderScene(scene, { assetBase: "/deck" }));
  const node = root.querySelector<HTMLElement>("[data-id='intro-clip']") as HTMLElement;
  const video = node.querySelector("video");
  const clock = { time: 0 };
  const play = vi.fn(() => Promise.resolve());
  const pause = vi.fn();
  if (video) {
    Object.defineProperty(video, "currentTime", {
      get: () => clock.time,
      set: (value: number) => {
        clock.time = value;
      },
    });
    Object.assign(video, { play, pause });
  }
  const context: HydrateContext = {
    block: scene.blocks.find((block) => block.id === "intro-clip") as Block,
    node,
    scene,
    deck: demoSource().deck,
    assetBase: "/deck",
    reducedMotion: true,
    announce: (message) => announced.push(message),
  };
  instance = await hydrate(context);
  return { node, video, clock, play, pause };
}

const chips = (node: HTMLElement) => [...node.querySelectorAll<HTMLButtonElement>("[data-cue]")];
const current = (node: HTMLElement) =>
  chips(node)
    .filter((chip) => chip.hasAttribute("aria-current"))
    .map((c) => c.dataset.cue);

describe("what hydrating adds", () => {
  it("reads the cue map beside the video and adds a chip for each cue, in time order", async () => {
    answer({});
    const { node } = await mount();
    expect(fetched.map((call) => call.url)).toEqual(["/deck/assets/intro.cues.json"]);
    expect(chips(node).map((chip) => chip.dataset.cue)).toEqual(["dot", "title", "sub"]);
    expect(node.querySelector(".dc-clip-cues")?.getAttribute("role")).toBe("group");
    expect(node.querySelector(".dc-clip-cues")?.getAttribute("aria-label")).toBe("Jump to");
  });

  it("names each chip by its cue and when it starts", async () => {
    answer({});
    const { node } = await mount();
    const [dot, , sub] = chips(node);
    expect(dot?.getAttribute("aria-label")).toBe("dot, at 0:00");
    expect(dot?.textContent).toBe("dot0:00");
    expect(sub?.getAttribute("aria-label")).toBe("sub, at 0:01");
    expect(dot?.type).toBe("button");
  });

  it("formats minutes", async () => {
    answer({ json: async () => ({ ...cueMap, duration: 900, cues: [{ id: "late", in: 754.9, out: 800 }] }) });
    const { node } = await mount();
    expect(chips(node)[0]?.getAttribute("aria-label")).toBe("late, at 12:34");
  });

  it("keeps the video as it was, with its poster and its cheap loading", async () => {
    answer({});
    const { node, video } = await mount();
    expect(video?.getAttribute("preload")).toBe("none");
    expect(video?.getAttribute("poster")).toBe("/deck/assets/intro.png");
    expect(node.querySelectorAll("video")).toHaveLength(1);
  });
});

describe("a clip with no usable cue map", () => {
  const plain = async () => {
    const { node, video } = await mount();
    expect(node.querySelector(".dc-clip-cues")).toBeNull();
    expect(node.dataset.cues).toBe("none");
    expect(video).not.toBeNull();
  };

  it("stays plain when there is no cue map", async () => {
    answer({ ok: false });
    await plain();
  });

  it("stays plain when the request fails", async () => {
    answer(new Error("offline"));
    await plain();
  });

  it("stays plain when the file is not JSON", async () => {
    answer({
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    await plain();
  });

  it("stays plain when it is not a cue map", async () => {
    answer({ json: async () => ({ format: "something-else" }) });
    await plain();
  });

  it("stays plain when no cue in it is usable", async () => {
    answer({ json: async () => ({ ...cueMap, cues: [{ id: "", in: 0, out: 1 }] }) });
    await plain();
  });

  it("does not ask for anything when the clip has no video to put chips under", async () => {
    answer({});
    const { node } = await mount(clipScene("not-an-asset.mp4"));
    expect(fetched).toEqual([]);
    expect(node.querySelector(".dc-clip-cues")).toBeNull();
  });

  it("gives a plain clip no commands", async () => {
    answer({ ok: false });
    await mount();
    expect(instance?.commands).toBeUndefined();
  });

  const bare = (block: Block, node: HTMLElement): HydrateContext => ({
    block,
    node,
    scene: clipScene(),
    deck: demoSource().deck,
    assetBase: "/deck",
    reducedMotion: true,
    announce: (message) => announced.push(message),
  });
  const withVideo = () => {
    const node = document.createElement("figure");
    node.append(document.createElement("video"));
    return node;
  };

  it("refuses a block that is not a clip", async () => {
    answer({});
    const image = { id: "pic", type: "image", source: "assets/intro.png", alt: "x" } as unknown as Block;
    await expect(hydrate(bare(image, withVideo()))).rejects.toThrow("only takes clip blocks");
    expect(fetched).toEqual([]);
  });

  it("asks for nothing when the source is not an asset path, even with a video in place", async () => {
    answer({});
    const node = withVideo();
    const clip = { id: "c", type: "clip", source: "not-an-asset.mp4", alt: "x" } as Block;
    expect(await hydrate(bare(clip, node))).toEqual({});
    expect(fetched).toEqual([]);
    expect(node.querySelector(".dc-clip-cues")).toBeNull();
  });
});

describe("using the chips", () => {
  it("jumps to the cue and plays when a chip is pressed, and says so", async () => {
    answer({});
    const { node, clock, play } = await mount();
    chips(node)[1]?.click();
    expect(clock.time).toBe(1);
    expect(play).toHaveBeenCalledTimes(1);
    expect(announced).toEqual(["Playing from title."]);
  });

  it("handles a press on a chip's time, which is inside the button", async () => {
    answer({});
    const { node, clock } = await mount();
    chips(node)[2]?.querySelector<HTMLElement>(".dc-cue-time")?.click();
    expect(clock.time).toBe(1.8);
  });

  it("ignores a click on the row that is not on a chip", async () => {
    answer({});
    const { node, clock, play } = await mount();
    (node.querySelector(".dc-clip-cues") as HTMLElement).click();
    expect(clock.time).toBe(0);
    expect(play).not.toHaveBeenCalled();
  });

  it("does not break when the browser refuses to play", async () => {
    answer({});
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", note);
    const { node, video } = await mount();
    // A plain function: a vi.fn would attach its own handler to the rejection and hide it.
    let asked = 0;
    Object.assign(video as HTMLVideoElement, {
      play: () => {
        asked += 1;
        return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      },
    });
    chips(node)[0]?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off("unhandledRejection", note);
    expect(asked).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it("marks the cue the clip is in, the latest to have started when several overlap", async () => {
    answer({});
    const { node, video, clock } = await mount();
    expect(current(node)).toEqual(["dot"]);
    clock.time = 1.05;
    video?.dispatchEvent(new Event("timeupdate"));
    expect(current(node)).toEqual(["title"]);
    clock.time = 2;
    video?.dispatchEvent(new Event("timeupdate"));
    expect(current(node)).toEqual(["sub"]);
    clock.time = 4.2;
    video?.dispatchEvent(new Event("timeupdate"));
    expect(current(node)).toEqual([]);
  });

  it("follows a jump the person made with the video's own controls", async () => {
    answer({});
    const { node, video, clock } = await mount();
    clock.time = 1.5;
    video?.dispatchEvent(new Event("seeked"));
    expect(current(node)).toEqual(["title"]);
  });

  it("marks a cue the moment a chip is pressed, before the video reports back", async () => {
    answer({});
    const { node } = await mount();
    chips(node)[2]?.click();
    expect(current(node)).toEqual(["sub"]);
  });

  it("stops following the video once the module is closed", async () => {
    answer({});
    const { node, video, clock } = await mount();
    const held = chips(node);
    instance?.dispose?.();
    clock.time = 2;
    video?.dispatchEvent(new Event("timeupdate"));
    expect(held.filter((chip) => chip.hasAttribute("aria-current")).map((chip) => chip.dataset.cue)).toEqual([
      "dot",
    ]);
  });
});

describe("commands, for an agent holding the lease", () => {
  it("seek moves to a cue and does not play", async () => {
    answer({});
    const { node, clock, play } = await mount();
    instance?.commands?.seek?.({ cue: "sub" });
    expect(clock.time).toBe(1.8);
    expect(play).not.toHaveBeenCalled();
    expect(current(node)).toEqual(["sub"]);
  });

  it("play starts from a cue, or from where the clip is", async () => {
    answer({});
    const { clock, play } = await mount();
    instance?.commands?.play?.({ cue: "title" });
    expect(clock.time).toBe(1);
    clock.time = 3;
    instance?.commands?.play?.({});
    instance?.commands?.play?.(undefined);
    expect(clock.time).toBe(3);
    expect(play).toHaveBeenCalledTimes(3);
  });

  it("pause pauses", async () => {
    answer({});
    const { pause } = await mount();
    instance?.commands?.pause?.(undefined);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it("names the cues there are when asked for one that is not", async () => {
    answer({});
    await mount();
    expect(() => instance?.commands?.seek?.({ cue: "nope" })).toThrow(
      'There is no cue "nope". Cues are: dot, title, sub.',
    );
    expect(() => instance?.commands?.seek?.({})).toThrow("There is no cue");
    expect(() => instance?.commands?.seek?.(null)).toThrow("There is no cue");
    expect(() => instance?.commands?.play?.({ cue: 3 })).toThrow('There is no cue "3"');
  });
});

describe("letting go", () => {
  it("removes the chips and the mark, and stops listening to the video", async () => {
    answer({});
    const { node, video, clock } = await mount();
    instance?.dispose?.();
    expect(node.querySelector(".dc-clip-cues")).toBeNull();
    expect(node.dataset.cues).toBeUndefined();
    const before = node.outerHTML;
    clock.time = 2;
    video?.dispatchEvent(new Event("timeupdate"));
    expect(node.outerHTML).toBe(before);
  });

  it("leaves a plain clip's mark off when it lets go", async () => {
    answer({ ok: false });
    const { node } = await mount();
    instance?.dispose?.();
    expect(node.dataset.cues).toBeUndefined();
  });
});
