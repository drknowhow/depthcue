// @vitest-environment happy-dom
import { type Cue, MARKER_TYPE } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CueBook, clock, createCueBook, measureClip } from "../src/cues.ts";
import { FakeServer } from "./helpers.ts";

const SOURCE = "assets/talk.mp4";
const layer = (id: string, start: number, end = start + 1): Cue => ({
  id,
  type: "circle",
  in: start,
  out: end,
});
const marker = (id: string, start: number, end = 10): Cue => ({ id, type: MARKER_TYPE, in: start, out: end });
const settle = () => new Promise((done) => setTimeout(done, 0));

let server: FakeServer;
let problems: Array<string | undefined>;
let changes: number;
let book: CueBook;

beforeEach(() => {
  server = new FakeServer();
  problems = [];
  changes = 0;
  book = createCueBook(server, {
    problem: (text) => problems.push(text),
    changed: () => {
      changes += 1;
    },
  });
});

const withMap = (cues: Cue[] = [layer("dot", 0, 2)]) => {
  server.cueMaps[SOURCE] = { duration: 10, width: 1280, height: 720, cues };
};
const loaded = async () => {
  book.entry(SOURCE);
  await settle();
};
const lastProblem = () => problems.at(-1);
const savedCues = () => server.cueMaps[SOURCE]?.cues.map((cue) => `${cue.id}@${cue.in}`);

describe("the cue book", () => {
  it("starts loading a video the first time it is asked about, and only then", async () => {
    withMap();
    expect(book.entry(SOURCE)).toMatchObject({ phase: "loading", cues: [], undoable: 0 });
    expect(book.entry(SOURCE).phase).toBe("loading");
    await settle();
    expect(server.cueLoads).toEqual([SOURCE]);
    expect(book.entry(SOURCE)).toMatchObject({ phase: "ready", state: "ok", duration: 10 });
    expect(book.entry(SOURCE).cues).toEqual([layer("dot", 0, 2)]);
    expect(changes).toBe(1);
  });

  it("knows a clip with no cue map and one whose file it cannot read", async () => {
    await loaded();
    expect(book.entry(SOURCE)).toMatchObject({
      phase: "ready",
      state: "none",
      cues: [],
      duration: undefined,
    });
    server.brokenCues.add("assets/odd.mp4");
    book.entry("assets/odd.mp4");
    await settle();
    expect(book.entry("assets/odd.mp4")).toMatchObject({ phase: "ready", state: "broken" });
  });

  it("says when the server could not be asked, and tries again on request", async () => {
    server.cueLoadFails = true;
    await loaded();
    expect(book.entry(SOURCE).phase).toBe("failed");
    server.cueLoadFails = false;
    withMap();
    book.reload(SOURCE);
    expect(book.entry(SOURCE).phase).toBe("loading");
    await settle();
    expect(book.entry(SOURCE)).toMatchObject({ phase: "ready", state: "ok" });
  });

  describe("adding a marker", () => {
    it("writes the whole list with a marker that runs to the end of the clip", async () => {
      withMap();
      await loaded();
      expect(await book.addMarker(SOURCE, 2.34567)).toBe(true);
      expect(server.cueSaves.at(-1)?.cues).toEqual([layer("dot", 0, 2), marker("marker-1", 2.346)]);
      expect(book.entry(SOURCE).cues).toEqual([layer("dot", 0, 2), marker("marker-1", 2.346)]);
      expect(book.entry(SOURCE).undoable).toBe(1);
      expect(lastProblem()).toBeUndefined();
    });

    it("keeps a time inside the clip", async () => {
      withMap([]);
      await loaded();
      await book.addMarker(SOURCE, -5);
      await book.addMarker(SOURCE, 99);
      expect(savedCues()).toEqual(["marker-1@0", "marker-2@10"]);
    });

    it("sends what the browser measured only when there is no cue map to take it from", async () => {
      await loaded();
      const size = { duration: 8, width: 640, height: 360 };
      expect(await book.addMarker(SOURCE, 3, size)).toBe(true);
      expect(server.cueSaves.at(-1)?.clip).toEqual(size);
      expect(book.entry(SOURCE)).toMatchObject({ state: "ok", duration: 8 });
      await book.addMarker(SOURCE, 4, size);
      expect(server.cueSaves.at(-1)?.clip).toBeUndefined();
    });

    it("asks for the clip to be played when its length is not known, and writes nothing", async () => {
      await loaded();
      expect(await book.addMarker(SOURCE, 3)).toBe(false);
      expect(lastProblem()).toContain("length of the video is not known");
      expect(server.cueSaves).toEqual([]);
    });

    it("runs quick changes one after another, so neither starts from a stale list", async () => {
      withMap([]);
      await loaded();
      const both = await Promise.all([book.addMarker(SOURCE, 1), book.addMarker(SOURCE, 2)]);
      expect(both).toEqual([true, true]);
      expect(savedCues()).toEqual(["marker-1@1", "marker-2@2"]);
    });

    it("says why the server refused, and leaves the cues as they were", async () => {
      withMap();
      await loaded();
      server.nextCueSaveFails = "The disk is full.";
      expect(await book.addMarker(SOURCE, 3)).toBe(false);
      expect(lastProblem()).toBe("The disk is full.");
      expect(book.entry(SOURCE)).toMatchObject({ undoable: 0, cues: [layer("dot", 0, 2)] });
    });

    it("leaves a cue file it cannot read alone", async () => {
      server.brokenCues.add(SOURCE);
      await loaded();
      expect(await book.addMarker(SOURCE, 3, { duration: 8, width: 640, height: 360 })).toBe(false);
      expect(lastProblem()).toContain("not one the editor can read");
      expect(server.cueSaves).toEqual([]);
    });
  });

  it("reads the file again before every change, so a rebuild since the last look is not written over", async () => {
    withMap([layer("dot", 0, 2), marker("marker-1", 3)]);
    await loaded();
    // A rebuild replaced the scene's cues while the editor held the old ones.
    server.cueMaps[SOURCE] = {
      duration: 10,
      width: 1280,
      height: 720,
      cues: [layer("fresh", 1, 2), marker("marker-1", 3)],
    };
    expect(await book.renameMarker(SOURCE, "marker-1", "intro")).toBe(true);
    expect(savedCues()).toEqual(["fresh@1", "intro@3"]);
  });

  describe("renaming a marker", () => {
    beforeEach(async () => {
      withMap([layer("dot", 0, 2), marker("marker-1", 3)]);
      await loaded();
    });

    it("changes only its id", async () => {
      expect(await book.renameMarker(SOURCE, "marker-1", "  the reveal ")).toBe(true);
      expect(server.cueMaps[SOURCE]?.cues).toEqual([layer("dot", 0, 2), marker("the reveal", 3)]);
    });

    it("asks for no change when the name is the same", async () => {
      const before = server.cueSaves.length;
      expect(await book.renameMarker(SOURCE, "marker-1", "marker-1 ")).toBe(true);
      expect(server.cueSaves).toHaveLength(before);
    });

    it("needs a name, and refuses one a cue already has", async () => {
      expect(await book.renameMarker(SOURCE, "marker-1", "   ")).toBe(false);
      expect(lastProblem()).toBe("A marker needs a name.");
      expect(await book.renameMarker(SOURCE, "marker-1", "dot")).toBe(false);
      expect(lastProblem()).toBe('Two cues are called "dot". Ids must differ.');
      expect(await book.renameMarker(SOURCE, "marker-1", "x".repeat(65))).toBe(false);
      expect(server.cueSaves).toEqual([]);
    });

    it("will not rename a cue of the scene, or one that is not there", async () => {
      expect(await book.renameMarker(SOURCE, "dot", "other")).toBe(false);
      expect(lastProblem()).toBe('There is no marker called "dot".');
      expect(await book.renameMarker(SOURCE, "gone", "other")).toBe(false);
      expect(server.cueSaves).toEqual([]);
    });
  });

  describe("moving a marker", () => {
    beforeEach(async () => {
      withMap([layer("dot", 0, 2), marker("marker-1", 3)]);
      await loaded();
    });

    it("sets its start, rounded, and keeps it running to the end of the clip", async () => {
      expect(await book.moveMarker(SOURCE, "marker-1", 6.12345)).toBe(true);
      expect(server.cueMaps[SOURCE]?.cues.at(-1)).toEqual(marker("marker-1", 6.123, 10));
    });

    it("keeps it inside the clip and puts it in time order", async () => {
      await book.moveMarker(SOURCE, "marker-1", -4);
      expect(savedCues()).toEqual(["dot@0", "marker-1@0"]);
      await book.moveMarker(SOURCE, "marker-1", 400);
      expect(savedCues()).toEqual(["dot@0", "marker-1@10"]);
    });

    it("leaves the cues of the scene where they are", async () => {
      await book.moveMarker(SOURCE, "dot", 5);
      expect(lastProblem()).toBe('There is no marker called "dot".');
      expect(server.cueMaps[SOURCE]?.cues[0]).toEqual(layer("dot", 0, 2));
    });
  });

  describe("removing a marker", () => {
    it("takes out that marker and nothing else", async () => {
      withMap([layer("dot", 0, 2), marker("a", 3), marker("b", 4)]);
      await loaded();
      expect(await book.removeMarker(SOURCE, "a")).toBe(true);
      expect(savedCues()).toEqual(["dot@0", "b@4"]);
    });

    it("will not remove a cue the scene made", async () => {
      withMap([layer("dot", 0, 2)]);
      await loaded();
      expect(await book.removeMarker(SOURCE, "dot")).toBe(false);
      expect(lastProblem()).toBe('There is no marker called "dot".');
      expect(savedCues()).toEqual(["dot@0"]);
    });
  });

  describe("undo", () => {
    beforeEach(async () => {
      withMap([layer("dot", 0, 2)]);
      await loaded();
    });

    it("takes back the last change to the markers, newest first", async () => {
      await book.addMarker(SOURCE, 3);
      await book.addMarker(SOURCE, 5);
      await book.renameMarker(SOURCE, "marker-1", "intro");
      expect(book.entry(SOURCE).undoable).toBe(3);
      expect(await book.undo(SOURCE)).toBe(true);
      expect(savedCues()).toEqual(["dot@0", "marker-1@3", "marker-2@5"]);
      await book.undo(SOURCE);
      await book.undo(SOURCE);
      expect(savedCues()).toEqual(["dot@0"]);
      expect(book.entry(SOURCE).undoable).toBe(0);
    });

    it("does nothing when there is nothing to take back", async () => {
      const before = server.cueSaves.length;
      expect(await book.undo(SOURCE)).toBe(false);
      expect(server.cueSaves).toHaveLength(before);
    });

    it("puts back the markers only, so a rebuild in between keeps its new cues", async () => {
      await book.addMarker(SOURCE, 3);
      await book.moveMarker(SOURCE, "marker-1", 6);
      server.cueMaps[SOURCE] = {
        duration: 10,
        width: 1280,
        height: 720,
        cues: [layer("fresh", 1, 2), marker("marker-1", 6)],
      };
      await book.undo(SOURCE);
      expect(savedCues()).toEqual(["fresh@1", "marker-1@3"]);
    });

    it("stays available when taking back the change failed", async () => {
      await book.addMarker(SOURCE, 3);
      server.nextCueSaveFails = "The disk is full.";
      expect(await book.undo(SOURCE)).toBe(false);
      expect(book.entry(SOURCE).undoable).toBe(1);
      expect(await book.undo(SOURCE)).toBe(true);
      expect(savedCues()).toEqual(["dot@0"]);
    });

    it("is not itself something that can be taken back", async () => {
      await book.addMarker(SOURCE, 3);
      await book.undo(SOURCE);
      expect(book.entry(SOURCE).undoable).toBe(0);
    });

    it("remembers the last 20 changes", async () => {
      for (let n = 0; n < 22; n++) await book.addMarker(SOURCE, (n % 9) + 0.5);
      expect(book.entry(SOURCE).undoable).toBe(20);
    });
  });

  it("keeps each video's cues apart", async () => {
    withMap([layer("dot", 0, 2)]);
    server.cueMaps["assets/other.mp4"] = { duration: 5, width: 640, height: 360, cues: [] };
    book.entry("assets/other.mp4");
    await loaded();
    await book.addMarker("assets/other.mp4", 2);
    expect(book.entry(SOURCE).undoable).toBe(0);
    expect(book.entry("assets/other.mp4").undoable).toBe(1);
    expect(savedCues()).toEqual(["dot@0"]);
  });
});

describe("clock", () => {
  it("writes minutes and whole seconds, as the player's chips do", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(7.9)).toBe("0:07");
    expect(clock(75)).toBe("1:15");
    expect(clock(600)).toBe("10:00");
  });
});

describe("measuring a clip", () => {
  const videoWith = (extra: Record<string, unknown>, src = "assets/talk.mp4") => {
    const video = document.createElement("video");
    for (const [name, value] of Object.entries({ currentSrc: src, ...extra })) {
      Object.defineProperty(video, name, { value, configurable: true });
    }
    // Only the videos measureClip makes are counted, not this one.
    probes.length = 0;
    return video;
  };
  let probes: HTMLVideoElement[];

  beforeEach(() => {
    probes = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const node = create(tag);
      if (tag === "video") probes.push(node as HTMLVideoElement);
      return node;
    }) as typeof document.createElement);
  });
  afterEach(() => vi.restoreAllMocks());

  it("takes the size from the video on the slide once it has loaded enough to say", async () => {
    const video = videoWith({ duration: 12.5, videoWidth: 1920, videoHeight: 1080 });
    expect(await measureClip(video)).toEqual({ duration: 12.5, width: 1920, height: 1080 });
    expect(probes).toEqual([]);
  });

  it("asks the file in a video of its own, and leaves the one on the slide alone", async () => {
    const video = videoWith({ duration: Number.NaN, videoWidth: 0, videoHeight: 0 });
    video.currentTime = 0;
    const answer = measureClip(video);
    const [probe] = probes;
    expect(probe?.getAttribute("src")).toBe("assets/talk.mp4");
    expect(probe?.preload).toBe("metadata");
    Object.defineProperty(probe, "duration", { value: 8 });
    Object.defineProperty(probe, "videoWidth", { value: 640 });
    Object.defineProperty(probe, "videoHeight", { value: 360 });
    probe?.dispatchEvent(new Event("loadedmetadata"));
    expect(await answer).toEqual({ duration: 8, width: 640, height: 360 });
    expect(probe?.hasAttribute("src")).toBe(false);
    expect(probes).toHaveLength(1);
  });

  it("gives up when the file cannot be read, or says nothing in time", async () => {
    const video = videoWith({ duration: Number.NaN, videoWidth: 0, videoHeight: 0 });
    const failed = measureClip(video);
    probes[0]?.dispatchEvent(new Event("error"));
    expect(await failed).toBeUndefined();
    expect(await measureClip(video, 5)).toBeUndefined();
  });

  it("has nothing to ask when the video has no source", async () => {
    const video = videoWith({ duration: Number.NaN, videoWidth: 0, videoHeight: 0 }, "");
    expect(await measureClip(video)).toBeUndefined();
    expect(probes).toEqual([]);
  });
});
