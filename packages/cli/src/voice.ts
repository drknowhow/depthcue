import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { revisionOf, type Scene } from "@depthcue/core";
import { applyToFolder, openDeck } from "./deck-api.ts";

/**
 * Reads a scene's `voiceover.text` aloud with Kokoro and writes the audio and word times into the deck's assets/
 * folder. Kokoro is the `kokoro` Python package, run as a separate program; a deck that has voice-over plays without
 * Python because the output is ordinary files. See docs/voice.md.
 */

export const DEFAULT_VOICE = "af_heart";
export const WORDS_FORMAT = "depthcue-words/1";
const KEY_FORMAT = "depthcue-voice/1";
const VOICE_PATTERN = /^[a-z]{2}_[a-z0-9]{2,32}$/;

export type VoiceErrorCode =
  | "python-missing"
  | "kokoro-missing"
  | "kokoro-failed"
  | "bad-deck"
  | "bad-scene"
  | "bad-voice"
  | "not-saved"
  | "cancelled";

/** A failure with a message that says what to do next. The CLI prints it and exits 2, or 1 for kokoro-failed. */
export class VoiceError extends Error {
  constructor(
    readonly code: VoiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

export interface VoiceBuildOptions {
  /** The deck folder. */
  folder: string;
  /** One scene id. Without it, every scene that has a voiceover. */
  scene?: string;
  /** Overrides the scene's own voice. Defaults to the scene's, then af_heart. */
  voice?: string;
  /** The command that runs Python, then any arguments that go before the helper script. */
  python?: readonly string[];
  signal?: AbortSignal;
}

export interface VoiceSceneResult {
  scene: string;
  voice: string;
  audio: string;
  words: string;
  /** False when the files were already up to date and nothing was generated. */
  built: boolean;
  duration: number;
  seconds: number;
}

/** `python` from the `--python` flag, then DEPTHCUE_PYTHON, then the PATH. */
export function pythonCommand(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  return [flag ?? env.DEPTHCUE_PYTHON ?? (process.platform === "win32" ? "python" : "python3")];
}

const MISSING_PYTHON = (command: string) =>
  `Could not run "${command}". Depthcue reads voice-over with Kokoro, which needs Python. ` +
  "Point to it with --python <path> or the DEPTHCUE_PYTHON variable.";

const MISSING_KOKORO = (module: string) =>
  `Python could not import "${module}". Install Kokoro with \`pip install kokoro soundfile\` (Kokoro needs Python 3.10 to 3.12 ` +
  "and espeak-ng on the PATH), or point to a Python that has it with --python or DEPTHCUE_PYTHON.";

/** Written to a temporary folder for each run, so nothing about it has to be installed or shipped as a file. */
const HELPER = `import json, sys

def main():
    given = dict(zip(sys.argv[1::2], sys.argv[2::2]))
    try:
        import numpy
        import soundfile
        from kokoro import KPipeline
    except ImportError as error:
        sys.stderr.write("missing module: %s\\n" % (error.name or error))
        sys.exit(3)
    with open(given["--text-file"], encoding="utf-8") as handle:
        text = handle.read()
    voice = given["--voice"]
    pipeline = KPipeline(lang_code=voice[0])
    rate = 24000
    chunks, words, offset = [], [], 0.0
    for result in pipeline(text, voice=voice):
        audio = result.audio.numpy()
        for token in result.tokens or []:
            if token.start_ts is not None and token.end_ts is not None and any(c.isalnum() for c in token.text):
                words.append({"text": token.text, "start": round(offset + token.start_ts, 3), "end": round(offset + token.end_ts, 3)})
        chunks.append(audio)
        offset += len(audio) / rate
    if not chunks:
        sys.stderr.write("Kokoro made no audio for this text.\\n")
        sys.exit(4)
    soundfile.write(given["--out"], numpy.concatenate(chunks), rate)
    with open(given["--words"], "w", encoding="utf-8") as handle:
        json.dump({"format": "${WORDS_FORMAT}", "duration": round(offset, 3), "words": words}, handle)

main()
`;

interface Ran {
  code: number | null;
  stderr: string;
}

function exec(command: readonly string[], args: readonly string[], signal?: AbortSignal): Promise<Ran> {
  return new Promise((done, fail) => {
    const [program, ...lead] = command as [string, ...string[]];
    if (signal?.aborted) return fail(new VoiceError("cancelled", "Stopped."));
    const child = spawn(program, [...lead, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      child.kill();
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 1_000_000) stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", stop);
      fail(
        error.code === "ENOENT" || error.code === "EACCES"
          ? new VoiceError("python-missing", MISSING_PYTHON(program))
          : error,
      );
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (cancelled) fail(new VoiceError("cancelled", "Stopped."));
      else done({ code, stderr });
    });
  });
}

const tail = (text: string) => text.trim().split(/\r?\n/).slice(-6).join("\n");

/** What decides whether the audio is current: the text and the voice, and the format of the files. */
export function voiceKey(text: string, voice: string): string {
  return createHash("sha256").update(`${KEY_FORMAT}\n${voice}\n${text}`).digest("hex");
}

/** Which of the modules Kokoro needs the given Python cannot import. Empty means it is ready. */
export async function voiceDoctor(
  python: readonly string[],
  signal?: AbortSignal,
): Promise<{ python: string; missing: string[] }> {
  const missing: string[] = [];
  for (const module of ["kokoro", "soundfile", "numpy"]) {
    const ran = await exec(python, ["-c", `import ${module}`], signal);
    if (ran.code !== 0) missing.push(module);
  }
  return { python: python.join(" "), missing };
}

function readWordsDuration(file: string): number {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { duration?: unknown };
    if (typeof parsed.duration === "number" && Number.isFinite(parsed.duration)) return parsed.duration;
  } catch {
    // Falls through to the same message as a file with no duration.
  }
  throw new VoiceError("kokoro-failed", "Kokoro finished but its word times could not be read.");
}

async function generate(
  folder: string,
  scene: Scene,
  voice: string,
  python: readonly string[],
  signal?: AbortSignal,
): Promise<VoiceSceneResult> {
  const started = Date.now();
  const text = scene.voiceover?.text ?? "";
  const audio = `assets/${scene.id}.voice.wav`;
  const words = `assets/${scene.id}.voice.words.json`;
  const key = voiceKey(text, voice);
  const on = (path: string) => join(folder, ...path.split("/"));

  const current = scene.voiceover;
  if (current?.key === key && current.audio === audio && current.words === words) {
    if (existsSync(on(audio)) && existsSync(on(words))) {
      return {
        scene: scene.id,
        voice,
        audio,
        words,
        built: false,
        duration: readWordsDuration(on(words)),
        seconds: (Date.now() - started) / 1000,
      };
    }
  }

  const assets = join(folder, "assets");
  mkdirSync(assets, { recursive: true });
  const work = mkdtempSync(join(assets, ".voicing-"));
  try {
    const script = join(work, "kokoro_say.py");
    const textFile = join(work, "text.txt");
    const wav = join(work, "voice.wav");
    const timings = join(work, "words.json");
    writeFileSync(script, HELPER);
    writeFileSync(textFile, text);
    const ran = await exec(
      python,
      ["-I", script, "--voice", voice, "--text-file", textFile, "--out", wav, "--words", timings],
      signal,
    );
    if (ran.code === 3) {
      const module = /missing module: (\S+)/.exec(ran.stderr)?.[1] ?? "kokoro";
      throw new VoiceError("kokoro-missing", MISSING_KOKORO(module));
    }
    if (ran.code !== 0) {
      throw new VoiceError(
        "kokoro-failed",
        `Kokoro failed (exit ${ran.code}).\n${tail(ran.stderr)}`.trimEnd(),
      );
    }
    if (!existsSync(wav) || !existsSync(timings)) {
      throw new VoiceError(
        "kokoro-failed",
        "Kokoro finished without writing the audio. Run it by hand to see why.",
      );
    }
    const duration = readWordsDuration(timings);

    // The audio moves in before the scene names it, and the scene is saved through the same checks as any edit,
    // so a stopped build leaves files nothing refers to rather than a scene that refers to missing files.
    renameSync(wav, on(audio));
    renameSync(timings, on(words));
    const opened = openDeck(folder);
    if (!opened.ok)
      throw new VoiceError("bad-deck", "The deck stopped being valid while the voice was made.");
    const outcome = applyToFolder(
      folder,
      [{ op: "scene.set", id: scene.id, set: { voiceover: { text, voice, audio, words, key } } }],
      revisionOf(opened.doc),
    );
    if (!outcome.ok)
      throw new VoiceError("not-saved", `The audio was made but the scene was not saved: ${outcome.hint}`);
    return {
      scene: scene.id,
      voice,
      audio,
      words,
      built: true,
      duration,
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function buildVoice(options: VoiceBuildOptions): Promise<VoiceSceneResult[]> {
  const folder = resolve(options.folder);
  const python = options.python ?? pythonCommand(undefined);
  if (options.voice !== undefined && !VOICE_PATTERN.test(options.voice)) {
    throw new VoiceError(
      "bad-voice",
      `"${options.voice}" is not a Kokoro voice name. A voice looks like af_heart.`,
    );
  }
  const opened = openDeck(folder);
  if (!opened.ok) {
    const first = opened.diagnostics.find((item) => item.severity === "error");
    throw new VoiceError(
      "bad-deck",
      `The deck has errors, so no voice was made. ${first?.message ?? ""}`.trimEnd(),
    );
  }
  const known = opened.doc.deck.scenes;
  if (options.scene !== undefined && !known.includes(options.scene)) {
    throw new VoiceError(
      "bad-scene",
      `There is no scene "${options.scene}". The scenes are ${known.join(", ")}.`,
    );
  }
  const wanted = (options.scene === undefined ? known : [options.scene])
    .map((id) => opened.doc.scenes[id])
    .filter((scene): scene is Scene => scene?.voiceover !== undefined);
  if (wanted.length === 0) {
    throw new VoiceError(
      "bad-scene",
      options.scene === undefined
        ? 'No scene has a voiceover. Add one with scene.set, such as {"voiceover": {"text": "..."}}.'
        : `Scene "${options.scene}" has no voiceover. Add one with scene.set, such as {"voiceover": {"text": "..."}}.`,
    );
  }
  const results: VoiceSceneResult[] = [];
  for (const planned of wanted) {
    // Each scene is read again, because saving the one before it changed the revision and the scene itself.
    const fresh = openDeck(folder);
    const scene = fresh.ok ? fresh.doc.scenes[planned.id] : undefined;
    if (!scene?.voiceover)
      throw new VoiceError("bad-deck", `Scene "${planned.id}" changed while the voice was made.`);
    const voice = options.voice ?? scene.voiceover.voice ?? DEFAULT_VOICE;
    results.push(await generate(folder, scene, voice, python, options.signal));
  }
  return results;
}
