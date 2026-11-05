import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { voiceKey } from "../src/voice.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/kokoro-stub.mjs", import.meta.url));
const options = { python: [process.execPath, stub] };

let root: string;
let folder: string;
let log: string;
const saved: Record<string, string | undefined> = {};

const env = (name: string, value: string) => {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
};

function sceneFile(id: string) {
  return join(folder, "scenes", `${id}.json`);
}
const readScene = (id: string) => JSON.parse(readFileSync(sceneFile(id), "utf8"));
function speak(id: string, voiceover: object) {
  const scene = readScene(id);
  scene.voiceover = voiceover;
  writeFileSync(sceneFile(id), JSON.stringify(scene, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-voice-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  log = join(root, "python.log");
  env("STUB_LOG", log);
  speak("opening", { text: "Channel B now leads." });
  speak("demand", { text: "Sixty to forty.", voice: "bf_emma" });
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

const generations = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .filter((args) => args[0] === "-I")
    : [];

describe("depthcue voice build", () => {
  it("voices every scene that has a voiceover and names the files in the scene", async () => {
    const { io, lines, errors } = capture();
    expect(await run(["voice", "build", folder], io, options)).toBe(0);
    expect(errors).toEqual([]);
    expect(lines[0]).toMatch(
      /^Voiced opening: assets\/opening\.voice\.wav, 1\.6 s, af_heart, [\d.]+ s to make\.$/,
    );
    expect(lines[1]).toMatch(/^Voiced demand: assets\/demand\.voice\.wav, 1\.2 s, bf_emma, /);
    for (const file of ["opening.voice.wav", "opening.voice.words.json", "demand.voice.wav"]) {
      expect(existsSync(join(folder, "assets", file)), file).toBe(true);
    }
    expect(readScene("opening").voiceover).toEqual({
      text: "Channel B now leads.",
      voice: "af_heart",
      audio: "assets/opening.voice.wav",
      words: "assets/opening.voice.words.json",
      key: voiceKey("Channel B now leads.", "af_heart"),
    });
    expect(readScene("method").voiceover).toBeUndefined();
  });

  it("leaves a deck that passes check", async () => {
    await run(["voice", "build", folder], capture().io, options);
    const { io, errors } = capture();
    expect(await run(["check", folder], io)).toBe(0);
    expect(errors).toEqual([]);
  });

  it("makes nothing again when the text and voice did not change", async () => {
    await run(["voice", "build", folder], capture().io, options);
    const { io, lines } = capture();
    expect(await run(["voice", "build", folder], io, options)).toBe(0);
    expect(lines).toEqual([
      "Up to date: opening. Nothing was made again.",
      "Up to date: demand. Nothing was made again.",
    ]);
    expect(generations()).toHaveLength(2);
  });

  it("voices again when the text changes, and only that scene", async () => {
    await run(["voice", "build", folder], capture().io, options);
    const scene = readScene("opening");
    scene.voiceover.text = "Channel B leads by twenty points.";
    writeFileSync(sceneFile("opening"), JSON.stringify(scene, null, 2));
    expect(await run(["voice", "build", folder], capture().io, options)).toBe(0);
    expect(generations()).toHaveLength(3);
    expect(readFileSync(join(folder, "assets", "opening.voice.wav"), "utf8")).toContain("twenty points");
  });

  it("takes one scene, and --voice replaces the scene's voice", async () => {
    const { io, lines } = capture();
    expect(await run(["voice", "build", folder, "demand", "--voice", "af_nova"], io, options)).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Voiced demand: .*af_nova/);
    expect(readScene("opening").voiceover.audio).toBeUndefined();
  });

  it("prints one JSON object with --json", async () => {
    const { io, lines } = capture();
    expect(await run(["voice", "build", folder, "opening", "--json"], io, options)).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: true,
      scenes: [{ scene: "opening", built: true, audio: "assets/opening.voice.wav", duration: 1.6 }],
    });
  });

  it("exits 2 and says how to install Kokoro when Python cannot import it", async () => {
    env("STUB_MISSING", "kokoro");
    const { io, errors } = capture();
    expect(await run(["voice", "build", folder], io, options)).toBe(2);
    expect(errors[0]).toContain("pip install kokoro soundfile");
    expect(readScene("opening").voiceover.audio).toBeUndefined();
  });

  it("exits 1 and shows Kokoro's own message when it fails", async () => {
    env("STUB_FAIL", "1");
    const { io, errors } = capture();
    expect(await run(["voice", "build", folder], io, options)).toBe(1);
    expect(errors[0]).toContain("Kokoro failed (exit 4)");
    expect(errors[0]).toContain("failed on purpose");
  });

  it("exits 2 when Python is not there", async () => {
    const { io, errors } = capture();
    expect(await run(["voice", "build", folder], io, { python: [join(root, "no-python")] })).toBe(2);
    expect(errors[0]).toContain("--python");
  });

  it("exits 2 for a scene with no voiceover, an unknown scene and a bad voice name", async () => {
    for (const [args, message] of [
      [["method"], /has no voiceover/],
      [["nothing"], /There is no scene "nothing"/],
      [["opening", "--voice", "Not A Voice"], /not a Kokoro voice name/],
    ] as const) {
      const { io, errors } = capture();
      expect(await run(["voice", "build", folder, ...args], io, options)).toBe(2);
      expect(errors[0]).toMatch(message);
    }
  });

  it("exits 2 when the folder is not a deck", async () => {
    const { io, errors } = capture();
    expect(await run(["voice", "build", root], io, options)).toBe(2);
    expect(errors[0]).toContain("has no deck.json");
  });
});

describe("depthcue voice doctor", () => {
  it("says Python is ready, and names what is missing otherwise", async () => {
    const ready = capture();
    expect(await run(["voice", "doctor"], ready.io, options)).toBe(0);
    expect(ready.lines[0]).toContain("can import kokoro, soundfile and numpy");

    env("STUB_MISSING", "soundfile");
    const missing = capture();
    expect(await run(["voice", "doctor"], missing.io, options)).toBe(1);
    expect(missing.lines[0]).toContain("cannot import soundfile");
  });
});

describe("voice flags", () => {
  it("--voice and --python belong to voice", async () => {
    const { io, errors } = capture();
    expect(await run(["check", folder, "--voice", "af_heart"], io, options)).toBe(2);
    expect(errors[0]).toContain("belong to voice");
  });
});
