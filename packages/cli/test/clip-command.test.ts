import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";

const stub = fileURLToPath(new URL("./fixtures/kine-stub.mjs", import.meta.url));
const options = { kine: [process.execPath, stub] };

const probe = {
  canvas: { w: 1920, h: 1080, fps: 30, duration: 4.2, frames: 126 },
  layers: [{ id: "title", type: "text", in: 1, out: 4.2, parent: null }],
  audio: [],
};

let root: string;
let folder: string;
let scene: string;
let log: string;
const saved: Record<string, string | undefined> = {};

function env(name: string, value: string | undefined) {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-clip-"));
  folder = join(root, "deck");
  mkdirSync(join(folder, "assets"), { recursive: true });
  writeFileSync(join(folder, "deck.json"), "{}");
  scene = join(root, "intro.json");
  writeFileSync(scene, JSON.stringify({ probe }));
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

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) },
  };
}

const calls = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    : [];

describe("depthcue clip build", () => {
  it("builds a clip, says what was written and how to use it, and exits 0", async () => {
    const { io, lines, errors } = capture();
    expect(await run(["clip", "build", folder, scene], io, options)).toBe(0);
    expect(errors).toEqual([]);
    expect(lines[0]).toMatch(
      /^Built assets\/intro\.mp4: 4\.2 s, 960x540, 1 cue, [\d.]+ s with kinescript 9\.9\.9-stub\.$/,
    );
    expect(lines[1]).toBe("  poster assets/intro.png");
    expect(lines[2]).toBe("  cues   assets/intro.cues.json");
    expect(JSON.parse(lines[3]?.replace(/^Add it to a scene as a block: /, "") ?? "")).toEqual({
      type: "clip",
      source: "assets/intro.mp4",
      poster: "assets/intro.png",
      alt: "...",
    });
    for (const file of ["intro.mp4", "intro.png", "intro.cues.json"]) {
      expect(existsSync(join(folder, "assets", file)), file).toBe(true);
    }
  });

  it("says nothing was rebuilt the second time", async () => {
    await run(["clip", "build", folder, scene], capture().io, options);
    const { io, lines } = capture();
    expect(await run(["clip", "build", folder, scene], io, options)).toBe(0);
    expect(lines[0]).toBe("Up to date: assets/intro.mp4. Nothing was rebuilt.");
    expect(calls().filter((args) => args[0] === "render")).toHaveLength(1);
  });

  it("prints one JSON object with --json", async () => {
    const { io, lines } = capture();
    expect(await run(["clip", "build", folder, scene, "--json"], io, options)).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: true,
      built: true,
      name: "intro",
      source: "assets/intro.mp4",
      poster: "assets/intro.png",
      cues: "assets/intro.cues.json",
      cueCount: 1,
      duration: 4.2,
      width: 960,
      height: 540,
      kinescript: "kinescript 9.9.9-stub",
    });
  });

  it("passes the name, quality and scale along, in either flag spelling", async () => {
    const { io } = capture();
    expect(
      await run(
        ["clip", "build", folder, scene, "--name", "opening", "--quality=draft", "--scale", "0.5"],
        io,
        options,
      ),
    ).toBe(0);
    expect(existsSync(join(folder, "assets", "opening.mp4"))).toBe(true);
    expect(
      calls()
        .find((args) => args[0] === "render")
        ?.slice(-4),
    ).toEqual(["-q", "draft", "--scale", "0.5"]);
  });

  it("asks for what it needs before running anything", async () => {
    const cases: Array<[string[], string]> = [
      [["clip"], "clip needs a subcommand"],
      [["clip", "make", folder, scene], "clip needs a subcommand"],
      [["clip", "build"], "needs a deck folder and a Kinescript scene file"],
      [["clip", "build", folder], "needs a deck folder and a Kinescript scene file"],
      [["clip", "build", folder, scene, "extra"], "Unexpected argument extra"],
      [["clip", "build", folder, scene, "--quality", "ultra"], "--quality is one of draft, standard, high"],
      [["clip", "build", folder, scene, "--scale", "2"], "--scale needs a number from 0.1 to 1"],
      [["clip", "build", folder, scene, "--scale", "0"], "--scale needs a number from 0.1 to 1"],
      [["clip", "build", folder, scene, "--scale", "half"], "--scale needs a number from 0.1 to 1"],
      [
        ["clip", "build", folder, scene, "--port", "1"],
        "takes --name, --quality, --scale, --kine and --json",
      ],
      [["clip", "build", folder, scene, "--out", "x"], "takes --name, --quality, --scale, --kine and --json"],
      [
        ["clip", "build", folder, scene, "--base-rev", "x"],
        "takes --name, --quality, --scale, --kine and --json",
      ],
      [["clip", "build", folder, scene, "--wat"], "Unknown option --wat"],
    ];
    for (const [argv, message] of cases) {
      const { io, errors } = capture();
      expect(await run(argv, io, options), argv.join(" ")).toBe(2);
      expect(errors[0], argv.join(" ")).toContain(message);
      expect(errors[0], argv.join(" ")).toContain("depthcue clip build <deck-folder>");
    }
    expect(calls()).toEqual([]);
  });

  it("refuses a folder that is not a deck", async () => {
    const { io, errors } = capture();
    expect(await run(["clip", "build", root, scene], io, options)).toBe(2);
    expect(errors[0]).toContain("is not a deck folder: it has no deck.json.");
    expect(calls()).toEqual([]);
  });

  it("exits 2 and says how to install Kinescript when it is not there", async () => {
    const { io, errors } = capture();
    expect(await run(["clip", "build", folder, scene, "--kine", join(root, "no-kine")], io)).toBe(2);
    expect(errors[0]).toContain("pip install kinescript");
  });

  it("looks for the program in DEPTHCUE_KINE when there is no flag", async () => {
    env("DEPTHCUE_KINE", join(root, "nowhere", "kine"));
    const { io, errors } = capture();
    expect(await run(["clip", "build", folder, scene], io)).toBe(2);
    expect(errors[0]).toContain(join(root, "nowhere", "kine"));
  });

  it("exits 1 with what Kinescript said when it cannot build the scene", async () => {
    env("STUB_FAIL", "render");
    const { io, errors } = capture();
    expect(await run(["clip", "build", folder, scene], io, options)).toBe(1);
    expect(errors[0]).toContain("kine render failed (exit 3)");
  });

  it("reports a failure as JSON too, so a program can read it", async () => {
    env("STUB_FAIL", "render");
    const { io, lines, errors } = capture();
    expect(await run(["clip", "build", folder, scene, "--json"], io, options)).toBe(1);
    expect(errors).toEqual([]);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ ok: false, code: "kine-failed" });
  });

  it("reports a name that cannot be an asset", async () => {
    const { io, errors } = capture();
    expect(await run(["clip", "build", folder, scene, "--name", "Not Allowed"], io, options)).toBe(2);
    expect(errors[0]).toContain('"Not Allowed" cannot name a clip');
  });

  it("leaves no interrupt handler behind", async () => {
    const before = process.listenerCount("SIGINT");
    await run(["clip", "build", folder, scene], capture().io, options);
    env("STUB_FAIL", "render");
    await run(["clip", "build", folder, scene, "--name", "again"], capture().io, options);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("keeps its own flags off the other commands", async () => {
    for (const flag of ["--name=x", "--quality=draft", "--scale=0.5", "--kine=k"]) {
      const { io, errors } = capture();
      expect(await run(["check", folder, flag], io, options), flag).toBe(2);
      expect(errors[0], flag).toContain("belong to clip build");
    }
  });
});

// The real thing, for a machine that has Kinescript. CI does not, so this skips there.
const kineProgram = process.env.DEPTHCUE_KINE ?? "kine";
const kineFound = spawnSync(kineProgram, ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!kineFound)("with Kinescript installed", () => {
  it("builds a real clip and reads its cues", async () => {
    const real = join(root, "hello.json");
    writeFileSync(
      real,
      JSON.stringify({
        canvas: { w: 320, h: 180, fps: 12 },
        layers: [
          { id: "title", type: "text", text: "Hello", x: "50%", y: "50%", size: 40, at: 0.2, dur: 0.8 },
          { id: "dot", type: "circle", x: "20%", y: "20%", r: 8, fill: "#ffffff", at: 0, dur: 1 },
        ],
      }),
    );
    const { io, lines, errors } = capture();
    const code = await run(["clip", "build", folder, real, "--quality", "draft", "--json"], io, {
      kine: [kineProgram],
    });
    expect(errors).toEqual([]);
    expect(code).toBe(0);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: true,
      built: true,
      source: "assets/hello.mp4",
    });
    const cues = JSON.parse(readFileSync(join(folder, "assets", "hello.cues.json"), "utf8"));
    expect(cues.cues.map((cue: { id: string }) => cue.id).sort()).toEqual(["dot", "title"]);
    expect(cues.width).toBe(320);
    expect(readFileSync(join(folder, "assets", "hello.mp4")).length).toBeGreaterThan(500);
    expect(
      readFileSync(join(folder, "assets", "hello.png"))
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
  });
});
