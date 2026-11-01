// @vitest-environment happy-dom
import type { Scene } from "@depthcue/core";
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { openStore } from "../src/store.ts";
import { createDrawQueue, fitThumbnails, isStale, thumbnailFrame } from "../src/thumbnail.ts";
import { FakeServer } from "./helpers.ts";

const sceneOf = async (id: string): Promise<Scene> => {
  const store = await openStore(new FakeServer(), () => memoryDraftStore());
  const scene = store.session.doc.scenes[id];
  if (!scene) throw new Error(`the demo deck should have a ${id} scene`);
  return scene;
};

describe("isStale", () => {
  it("is true until a scene is drawn, and for another scene or another theme", async () => {
    const scene = await sceneOf("opening");
    const other = await sceneOf("method");
    expect(isStale(undefined, scene, "paper")).toBe(true);
    expect(isStale({ scene, theme: "paper" }, scene, "paper")).toBe(false);
    expect(isStale({ scene, theme: "paper" }, other, "paper")).toBe(true);
    expect(isStale({ scene, theme: "paper" }, scene, "ink")).toBe(true);
  });
});

describe("thumbnailFrame", () => {
  it("draws the scene inert, in the deck's theme, with its steps shown and its pictures and videos quiet", async () => {
    const method = await sceneOf("method");
    const withClip: Scene = {
      ...method,
      blocks: [
        ...method.blocks,
        { id: "talk", type: "clip", source: "assets/talk.mp4", alt: "Someone talking" },
      ],
    };
    const frame = thumbnailFrame(withClip, "ink");
    expect(frame.classList.contains("ed-thumb-frame")).toBe(true);
    expect(frame.getAttribute("data-theme")).toBe("ink");
    expect(frame.hasAttribute("inert")).toBe(true);
    const video = frame.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.controls).toBe(false);
    for (const image of frame.querySelectorAll("img")) expect(image.loading).toBe("lazy");
  });

  it("shows a step that is still to come as if it had come", async () => {
    const frame = thumbnailFrame(await sceneOf("demand"), "paper");
    for (const node of frame.querySelectorAll<HTMLElement>("[data-gated]")) {
      expect(node.dataset.revealed).toBe("true");
    }
  });
});

describe("fitThumbnails", () => {
  const holderWith = (width: number) => {
    const holder = document.createElement("div");
    const thumb = document.createElement("div");
    thumb.className = "ed-thumb";
    Object.defineProperty(thumb, "clientWidth", { value: width });
    holder.append(thumb);
    return holder;
  };

  it("scales the 1280 px slide to the width its holder's thumbnails have", () => {
    const holder = holderWith(320);
    fitThumbnails(holder);
    expect(holder.style.getPropertyValue("--thumb-k")).toBe("0.25");
  });

  it("leaves the scale alone while nothing has a width yet, or there is no thumbnail", () => {
    const holder = holderWith(0);
    fitThumbnails(holder);
    expect(holder.style.getPropertyValue("--thumb-k")).toBe("");
    const empty = document.createElement("div");
    fitThumbnails(empty);
    expect(empty.style.getPropertyValue("--thumb-k")).toBe("");
  });
});

describe("createDrawQueue", () => {
  let waiting: Map<number, FrameRequestCallback>;
  let next: number;
  let requested: MockInstance;
  let cancelled: MockInstance;
  let drawn: string[];
  const draw = (id: string) => void drawn.push(id);
  /** Runs the one frame that is waiting, as the browser would. */
  const frame = () => {
    const [id, callback] = [...waiting][0] ?? [];
    if (id === undefined || !callback) throw new Error("a frame should be waiting");
    waiting.delete(id);
    callback(0);
  };

  beforeEach(() => {
    waiting = new Map();
    next = 0;
    drawn = [];
    requested = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      next += 1;
      waiting.set(next, callback);
      return next;
    });
    cancelled = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => void waiting.delete(id));
  });
  afterEach(() => vi.restoreAllMocks());

  it("draws two a frame in the order they were queued, and asks for another frame while any are left", () => {
    const queue = createDrawQueue(draw);
    for (const id of ["a", "b", "c"]) queue.add(id);
    expect(drawn).toEqual([]);
    queue.kick();
    expect(requested).toHaveBeenCalledTimes(1);
    frame();
    expect(drawn).toEqual(["a", "b"]);
    expect(requested).toHaveBeenCalledTimes(2);
    frame();
    expect(drawn).toEqual(["a", "b", "c"]);
    expect(requested).toHaveBeenCalledTimes(2);
    expect(waiting.size).toBe(0);
  });

  it("asks for one frame however often it is kicked, and for none when nothing is queued", () => {
    const queue = createDrawQueue(draw);
    queue.kick();
    expect(requested).not.toHaveBeenCalled();
    queue.add("a");
    queue.kick();
    queue.kick();
    expect(requested).toHaveBeenCalledTimes(1);
  });

  it("draws a thumbnail once however many times it was queued, and not at all once it is removed", () => {
    const queue = createDrawQueue(draw);
    queue.add("a");
    queue.add("a");
    queue.add("b");
    queue.remove("b");
    queue.kick();
    frame();
    expect(drawn).toEqual(["a"]);
  });

  it("draws everything now on a flush, and cancels the frame that was waiting", () => {
    const queue = createDrawQueue(draw);
    for (const id of ["a", "b", "c"]) queue.add(id);
    queue.kick();
    queue.flush();
    expect(drawn).toEqual(["a", "b", "c"]);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(waiting.size).toBe(0);
    // It can be used again: the frame it cancelled is not still counted as waiting.
    queue.add("d");
    queue.kick();
    expect(requested).toHaveBeenCalledTimes(2);
    frame();
    expect(drawn).toEqual(["a", "b", "c", "d"]);
  });

  it("forgets what was queued, and the frame, when it is destroyed, and can be used again", () => {
    const queue = createDrawQueue(draw);
    queue.add("a");
    queue.kick();
    queue.destroy();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(waiting.size).toBe(0);
    // Nothing is left to draw, so a kick asks for nothing.
    queue.kick();
    expect(requested).toHaveBeenCalledTimes(1);
    // The frame it cancelled is not still counted as waiting.
    queue.add("b");
    queue.kick();
    expect(requested).toHaveBeenCalledTimes(2);
    frame();
    expect(drawn).toEqual(["b"]);
  });
});
