import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CUE_MAP_FORMAT, type CueMap, MAX_CUES } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClip,
  type ClipBuildOptions,
  ClipError,
  kineCommand,
  nameFromScene,
  readProbe,
} from "../src/clip.ts";

const stub = fileURLToPath(new URL("./fixtures/kine-stub.mjs", import.meta.url));
const kine = [process.execPath, stub];

const probe = {
  canvas: { w: 1920, h: 1080, fps: 30, duration: 4.2, frames: 126 },
  layers: [
    { id: "title", type: "text", in: 1, out: 4.2, parent: null },
    { id: "dot", type: "circle", in: 0, out: 1.1, parent: null },
    { id: "glow", type: "circle", in: 0.5, out: 1.1, parent: "dot" },
  ],
  audio: [{ id: "voice", role: "narration", src: "voice.m4a", in: 0.4, out: 3.9 }],
};

let root: string;
let folder: string;
let log: string;
const saved: Record<string, string | undefined> = {};

function env(name: string, value: string | undefined) {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue clip & test-"));
  folder = join(root, "deck");
  mkdirSync(join(folder, "assets"), { recursive: true });
  log = join(root, "kine.log");
  env("STUB_LOG", log);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function scene(extra: Record<string, unknown> = {}, file = "intro.json"): string {
  const path = join(root, file);
  writeFileSync(path, JSON.stringify({ probe, ...extra }));
  return path;
}

const calls = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    : [];
const ran = (command: string) => calls().filter((args) => args[0] === command);
const build = (options: Partial<ClipBuildOptions> & { scene: string }) =>
  buildClip({ folder, kine, ...options });
const cueMap = (name = "intro") =>
  JSON.parse(readFileSync(join(folder, "assets", `${name}.cues.json`), "utf8")) as CueMap;

describe("building a clip", () => {
  it("writes the video, the poster and the cue map into the deck's assets", async () => {
    const result = await build({ scene: scene() });
    expect(result).toMatchObject({
      name: "intro",
      source: "assets/intro.mp4",
      poster: "assets/intro.png",
      cues: "assets/intro.cues.json",
      built: true,
      cueCount: 3,
      duration: 4.2,
      width: 960,
      height: 540,
      kinescript: "kinescript 9.9.9-stub",
    });
    expect(readdirSync(join(folder, "assets")).sort()).toEqual(["intro.cues.json", "intro.mp4", "intro.png"]);
    expect(readFileSync(join(folder, "assets", "intro.mp4"), "utf8")).toContain("video render");
  });

  it("puts a place to jump to for each top-level layer and sound, in time order", async () => {
    await build({ scene: scene() });
    const map = cueMap();
    expect(map.format).toBe(CUE_MAP_FORMAT);
    expect(map.source).toBe("assets/intro.mp4");
    expect(map.cues).toEqual([
      { id: "dot", type: "circle", in: 0, out: 1.1 },
      { id: "voice", type: "audio", in: 0.4, out: 3.9 },
      { id: "title", type: "text", in: 1, out: 4.2 },
    ]);
    expect(map.build).toMatchObject({
      kinescript: "kinescript 9.9.9-stub",
      quality: "standard",
      scale: 1,
      scene: "intro.json",
    });
    expect(map.build?.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("asks for the quality and scale, and takes the poster from the middle of the clip", async () => {
    await build({ scene: scene(), quality: "draft", scale: 0.5 });
    const [render] = ran("render");
    expect(render?.slice(-4)).toEqual(["-q", "draft", "--scale", "0.5"]);
    const [still] = ran("still");
    expect(still?.slice(2, 4)).toEqual(["--at", "2.1"]);
    expect(still?.slice(-2)).toEqual(["--scale", "0.5"]);
    expect(cueMap().build).toMatchObject({ quality: "draft", scale: 0.5 });
  });

  it("leaves --scale off at full size", async () => {
    await build({ scene: scene() });
    expect(ran("render")[0]).not.toContain("--scale");
    expect(ran("still")[0]).not.toContain("--scale");
  });

  it("keeps the poster on a real frame for a scene shorter than a frame's half", async () => {
    const short = { ...probe, canvas: { w: 100, h: 100, fps: 10, duration: 0.05, frames: 1 } };
    await build({ scene: scene({ probe: short }) });
    expect(ran("still")[0]?.[3]).toBe("0");
  });

  it("names the clip after the scene file, or as asked", async () => {
    expect((await build({ scene: scene({}, "Intro Title.json") })).name).toBe("intro-title");
    expect((await build({ scene: scene(), name: "opening-clip" })).source).toBe("assets/opening-clip.mp4");
    expect(nameFromScene("/x/Scene 2 (final).json")).toBe("scene-2-final");
  });

  it("shortens a long scene file name to one that can name a clip", async () => {
    const long = "a".repeat(100);
    expect(nameFromScene(`/x/${long}.json`)).toBe("a".repeat(63));
    expect((await build({ scene: scene({}, `${long}.json`) })).name).toBe("a".repeat(63));
  });

  it("makes the assets folder when the deck has none yet", async () => {
    rmSync(join(folder, "assets"), { recursive: true });
    await build({ scene: scene() });
    expect(readdirSync(join(folder, "assets")).sort()).toEqual(["intro.cues.json", "intro.mp4", "intro.png"]);
  });

  it("works from a folder whose path has spaces and an ampersand", async () => {
    // The temp folder is called "depthcue clip & test-…": nothing is run through a shell.
    const result = await build({ scene: scene() });
    expect(result.built).toBe(true);
  });
});

describe("a build that is already up to date", () => {
  it("renders nothing the second time", async () => {
    const path = scene();
    await build({ scene: path });
    const again = await build({ scene: path });
    expect(again).toMatchObject({
      built: false,
      cueCount: 3,
      width: 960,
      height: 540,
      source: "assets/intro.mp4",
    });
    expect(ran("render")).toHaveLength(1);
    expect(ran("still")).toHaveLength(1);
    expect(ran("probe")).toHaveLength(1);
  });

  it("rebuilds when the scene changes", async () => {
    await build({ scene: scene() });
    await build({ scene: scene({ title: "changed" }) });
    expect(ran("render")).toHaveLength(2);
  });

  it("rebuilds when a file the scene uses changes, though the scene does not", async () => {
    writeFileSync(join(root, "voice.m4a"), "one");
    const path = scene();
    await build({ scene: path });
    writeFileSync(join(root, "voice.m4a"), "two");
    await build({ scene: path });
    expect(ran("render")).toHaveLength(2);
  });

  it("ignores a file name that points at nothing", async () => {
    const path = scene({ note: "missing.png" });
    await build({ scene: path });
    await build({ scene: path });
    expect(ran("render")).toHaveLength(1);
  });

  it("ignores a folder that happens to have a file's kind of name", async () => {
    mkdirSync(join(root, "frames.png"));
    const result = await build({ scene: scene({ note: "frames.png" }) });
    expect(result.built).toBe(true);
  });

  it("rebuilds for another quality, another scale, or another Kinescript", async () => {
    const path = scene();
    await build({ scene: path });
    await build({ scene: path, quality: "high" });
    await build({ scene: path, quality: "high", scale: 0.5 });
    env("STUB_VERSION", "kinescript 10.0.0");
    await build({ scene: path, quality: "high", scale: 0.5 });
    expect(ran("render")).toHaveLength(4);
  });

  it("rebuilds when a file it made has gone", async () => {
    const path = scene();
    await build({ scene: path });
    rmSync(join(folder, "assets", "intro.png"));
    await build({ scene: path });
    expect(ran("render")).toHaveLength(2);
    expect(existsSync(join(folder, "assets", "intro.png"))).toBe(true);
  });

  it("rebuilds when the cue map is not one of ours", async () => {
    const path = scene();
    await build({ scene: path });
    writeFileSync(join(folder, "assets", "intro.cues.json"), "not json");
    await build({ scene: path });
    expect(ran("render")).toHaveLength(2);
    expect(cueMap().format).toBe(CUE_MAP_FORMAT);
  });
});

describe("a build that goes wrong", () => {
  it("says how to install Kinescript when it cannot be run", async () => {
    const error = await build({ scene: scene(), kine: [join(root, "no-such-kine")] }).catch((e) => e);
    expect(error).toBeInstanceOf(ClipError);
    expect(error.code).toBe("kine-missing");
    expect(error.message).toContain("pip install kinescript");
    expect(error.message).toContain("--kine");
    expect(error.message).toContain("DEPTHCUE_KINE");
  });

  it("reports what Kinescript said, and leaves nothing behind", async () => {
    env("STUB_FAIL", "render");
    const error = await build({ scene: scene() }).catch((e) => e);
    expect(error.code).toBe("kine-failed");
    expect(error.message).toContain("kine render failed (exit 3)");
    expect(error.message).toContain("stub: render failed on purpose");
    expect(readdirSync(join(folder, "assets"))).toEqual([]);
  });

  it("shows the last lines of what Kinescript said, not all of it", async () => {
    env("STUB_FAIL", "render");
    env("STUB_NOISE", "10");
    const error = await build({ scene: scene() }).catch((e) => e);
    expect(error.message).toMatch(/stub noise 6$/m);
    expect(error.message).toMatch(/stub noise 10$/m);
    expect(error.message).not.toMatch(/stub noise 5$/m);
  });

  it("does not trust a render that wrote no video", async () => {
    env("STUB_NO_OUTPUT", "1");
    const error = await build({ scene: scene() }).catch((e) => e);
    expect(error.code).toBe("kine-failed");
    expect(error.message).toContain("without writing clip.mp4");
    expect(readdirSync(join(folder, "assets"))).toEqual([]);
  });

  it("keeps the last good clip when a rebuild fails", async () => {
    const path = scene();
    await build({ scene: path });
    const before = readFileSync(join(folder, "assets", "intro.mp4"), "utf8");
    env("STUB_FAIL", "still");
    await expect(build({ scene: scene({ title: "new" }) })).rejects.toThrow("kine still failed");
    expect(readFileSync(join(folder, "assets", "intro.mp4"), "utf8")).toBe(before);
    expect(readdirSync(join(folder, "assets")).sort()).toEqual(["intro.cues.json", "intro.mp4", "intro.png"]);
  });

  it("fails a scene Kinescript cannot read before it renders anything", async () => {
    const error = await build({ scene: scene({ probe: undefined }) }).catch((e) => e);
    expect(error.code).toBe("kine-failed");
    expect(ran("render")).toHaveLength(0);
  });

  it("names a scene file it cannot read", async () => {
    const error = await build({ scene: join(root, "nope.json") }).catch((e) => e);
    expect(error.code).toBe("bad-scene");
    expect(error.message).toContain("nope.json");
  });

  it("refuses a name that cannot be an asset", async () => {
    for (const name of ["Intro", "a/b", "..", "x y", ""]) {
      const error = await build({ scene: scene(), name }).catch((e) => e);
      expect(error.code, name).toBe("bad-name");
    }
    expect(calls()).toEqual([]);
  });

  it("stops the render and cleans up when cancelled", async () => {
    const pidFile = join(root, "kine.pid");
    env("STUB_SLOW", "1");
    env("STUB_PID", pidFile);
    const stop = new AbortController();
    const building = build({ scene: scene(), signal: stop.signal }).catch((e) => e);
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    stop.abort();
    const error = await building;
    expect(error.code).toBe("cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(readdirSync(join(folder, "assets"))).toEqual([]);
  });

  it("does not start when it was cancelled already", async () => {
    const stop = new AbortController();
    stop.abort();
    const error = await build({ scene: scene(), signal: stop.signal }).catch((e) => e);
    expect(error.code).toBe("cancelled");
    expect(ran("render")).toHaveLength(0);
  });
});

describe("reading what kine probe printed", () => {
  const text = (value: unknown) => JSON.stringify(value);
  const base = { canvas: probe.canvas };

  it("takes the scene's size, rate and length", () => {
    expect(readProbe(text(probe))).toMatchObject({ width: 1920, height: 1080, fps: 30, duration: 4.2 });
  });

  it("skips what is malformed, rather than trusting another program's output", () => {
    const { cues } = readProbe(
      text({
        ...base,
        layers: [
          null,
          "x",
          { id: "", type: "text", in: 0, out: 1, parent: null },
          { id: "x".repeat(65), type: "text", in: 0, out: 1, parent: null },
          { id: "negative", type: "text", in: -1, out: 1, parent: null },
          { id: "backwards", type: "text", in: 2, out: 1, parent: null },
          { id: "nan", type: "text", in: "0", out: 1, parent: null },
          { id: 7, type: "text", in: 0, out: 1, parent: null },
          { id: "good", type: "text", in: 0, out: 1 },
        ],
        audio: "nope",
      }),
    );
    expect(cues).toEqual([{ id: "good", type: "text", in: 0, out: 1 }]);
  });

  it("keeps the first of two cues with the same id", () => {
    const { cues } = readProbe(
      text({
        ...base,
        layers: [
          { id: "a", type: "text", in: 2, out: 3, parent: null },
          { id: "a", type: "text", in: 0, out: 1, parent: null },
        ],
      }),
    );
    expect(cues).toEqual([{ id: "a", type: "text", in: 2, out: 3 }]);
  });

  it(`stops at ${MAX_CUES} cues, keeping the earliest`, () => {
    const layers = Array.from({ length: 80 }, (_, i) => ({
      id: `layer-${i}`,
      type: "text",
      in: 80 - i,
      out: 100,
      parent: null,
    }));
    const { cues } = readProbe(text({ ...base, layers }));
    expect(cues).toHaveLength(MAX_CUES);
    expect(cues[0]?.id).toBe("layer-79");
  });

  it("needs a size and a length, and a JSON object", () => {
    expect(() => readProbe("not json")).toThrow(ClipError);
    expect(() => readProbe("[]")).toThrow("did not print a JSON object");
    expect(() => readProbe(text({ layers: [] }))).toThrow("size and duration");
    expect(() => readProbe(text({ canvas: { w: 1, h: 1, fps: "30", duration: 1 } }))).toThrow(
      "size and duration",
    );
  });

  it("cuts a long type name down", () => {
    const { cues } = readProbe(text({ ...base, layers: [{ id: "a", type: "t".repeat(50), in: 0, out: 1 }] }));
    expect(cues[0]?.type).toHaveLength(32);
  });
});

describe("finding Kinescript", () => {
  it("prefers the flag, then the environment, then the PATH", () => {
    expect(kineCommand("/opt/kine", { DEPTHCUE_KINE: "/env/kine" })).toEqual(["/opt/kine"]);
    expect(kineCommand(undefined, { DEPTHCUE_KINE: "/env/kine" })).toEqual(["/env/kine"]);
    expect(kineCommand(undefined, {})).toEqual(["kine"]);
  });
});
