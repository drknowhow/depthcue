/**
 * The deck as an MP4 with its voice-over: each scene is pictures of the player, one for each step the voice shows,
 * held for as long as the recording takes to reach the next mark. A scene with no recording is held for a fixed time.
 * Needs a browser for the pictures and `ffmpeg` for the file. Nothing is written outside a temporary folder.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Diagnostic, type Doc, type Scene, splitMarks } from "@depthcue/core";
import type { Browser } from "playwright-core";
import { openDeck } from "./deck-api.ts";
import { PageExportError, type PageOptions } from "./export-pages.ts";
import { launchBrowser } from "./render.ts";
import { builtPlayerDir, startServer } from "./serve.ts";

export interface VideoOptions extends PageOptions {
  /** Seconds a scene with no recording stays up. Default 5. */
  hold?: number;
  /** The ffmpeg program. Default: `DEPTHCUE_FFMPEG`, then `ffmpeg` on the PATH. */
  ffmpeg?: string;
  /** Draw the captions the player shows, at the times they are said. Default false. */
  captions?: boolean;
}

export type VideoResult =
  | { ok: true; bytes: Buffer; summary: { scenes: number; seconds: number; voiced: number } }
  | { ok: false; diagnostics: Diagnostic[] };

const STAGE = { width: 1280, height: 720 } as const;
const SCALE = 1.5;
const TAIL = 0.6;
const FPS = 30;
const CLEAN_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.dc-controls { display: none !important; }
`;

/** One picture of a scene and how long it stays up. */
export interface Shot {
  step: number;
  seconds: number;
  /** The caption drawn over the picture, if any. */
  caption?: string;
}

/** When captions change and what they say at a time. */
export interface CaptionTrack {
  edges: readonly number[];
  at(time: number): string | undefined;
}

/** The seconds in a PCM WAV file, or undefined for anything else. */
export function wavSeconds(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645)
    return undefined;
  let rate = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = view.getUint32(at);
    const size = view.getUint32(at + 4, true);
    if (id === 0x666d7420 && at + 20 <= bytes.length) rate = view.getUint32(at + 16, true);
    if (id === 0x64617461) {
      const length = Math.min(size, bytes.length - at - 8);
      return rate > 0 ? length / rate : undefined;
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/**
 * What a scene shows and for how long. With marks, mark N brings in step N at its time, as the player does; the last
 * picture shows every step, since a step without a mark would otherwise never appear in a file nobody can press Next
 * in. Without marks the scene is one picture of everything. A caption track adds a cut wherever a caption comes or goes.
 */
export function shotsOf(
  steps: number,
  marks: readonly number[],
  seconds: number,
  captions?: CaptionTrack,
): Shot[] {
  const usable = marks.filter((at) => at > 0 && at < seconds).slice(0, steps);
  const extra = (captions?.edges ?? []).filter((at) => at > 0 && at < seconds);
  const cuts = [...new Set([0, ...usable, ...extra, seconds])].sort((a, b) => a - b);
  const shots: Shot[] = [];
  for (let at = 0; at < cuts.length - 1; at += 1) {
    const start = cuts[at] as number;
    const end = cuts[at + 1] as number;
    const passed = usable.filter((mark) => mark <= start).length;
    const step = marks.length === 0 || passed === usable.length ? steps : passed;
    const caption = captions?.at((start + end) / 2);
    const previous = shots.at(-1);
    if (previous && previous.step === step && previous.caption === caption) previous.seconds += end - start;
    else shots.push({ step, seconds: end - start, ...(caption === undefined ? {} : { caption }) });
  }
  return shots;
}

function run(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { maxBuffer: 1 << 24 }, (error, _out, err) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(
          missing
            ? new PageExportError(
                "no-ffmpeg",
                "A video needs ffmpeg, and none was found. Install it, or set DEPTHCUE_FFMPEG to its path.",
              )
            : new PageExportError(
                "render-failed",
                `ffmpeg failed: ${err.trim().split("\n").slice(-3).join(" ")}`,
              ),
        );
      } else resolve();
    });
  });
}

interface Recording {
  file: string;
  seconds: number;
  marks: number[];
  /** The word times file as read, for the captions. */
  words?: unknown;
}

function recordingOf(folder: string, scene: Scene): Recording | undefined {
  const audio = scene.voiceover?.audio;
  if (!audio) return undefined;
  const file = join(folder, audio);
  if (!existsSync(file)) return undefined;
  const seconds = wavSeconds(new Uint8Array(readFileSync(file)));
  if (seconds === undefined || seconds <= 0) return undefined;
  let marks: number[] = [];
  let data: unknown;
  const words = scene.voiceover?.words;
  if (words && existsSync(join(folder, words))) {
    try {
      data = JSON.parse(readFileSync(join(folder, words), "utf8"));
      const found = (data as { marks?: unknown } | null)?.marks;
      if (Array.isArray(found)) marks = found.filter((at): at is number => typeof at === "number");
    } catch {
      // Word times that cannot be read leave the scene as one picture.
    }
  }
  return { file, seconds, marks, words: data };
}

type Captions = typeof import("@depthcue/player");

/** The captions of a scene as the player cuts them: from the word times, or spread over the recording by the text. */
function trackOf(player: Captions, scene: Scene, recording: Recording): CaptionTrack | undefined {
  const script = splitMarks(scene.voiceover?.text ?? "").spoken;
  const words = player.readWords(recording.words);
  const lines =
    words && words.length > 0
      ? player.linesFromWords(words, script)
      : player.linesFromText(script, recording.seconds);
  if (lines.length === 0) return undefined;
  return {
    edges: player.captionEdges(lines),
    at: (time) => player.lineAt(lines, time)?.text,
  };
}

async function stills(
  folder: string,
  doc: Doc,
  playerDir: string,
  wanted: ReadonlyMap<string, readonly Shot[]>,
  work: string,
): Promise<Map<string, string>> {
  const server = await startServer({ folder, playerDir, port: 0 });
  let browser: Browser;
  try {
    browser = await launchBrowser(["--disable-gpu-rasterization"]);
  } catch (error) {
    await server.close();
    throw new PageExportError("no-browser", (error as Error).message);
  }
  const made = new Map<string, string>();
  try {
    for (const id of doc.deck.scenes) {
      for (const { step, caption } of wanted.get(id) ?? []) {
        const context = await browser.newContext({
          viewport: STAGE,
          deviceScaleFactor: SCALE,
          reducedMotion: "reduce",
          colorScheme: "light",
          bypassCSP: true,
          serviceWorkers: "block",
        });
        try {
          // The player would start the recording and move on by itself while the picture is taken.
          await context.addInitScript(() => {
            try {
              localStorage.setItem("depthcue.voice.auto", "0");
              localStorage.setItem("depthcue.voice.captions", "0");
            } catch {
              // Closed storage: nothing was remembered either.
            }
          });
          const page = await context.newPage();
          await page.goto(`${server.url}#/${id}${step > 0 ? `/${step}` : ""}`, { waitUntil: "load" });
          await page.addStyleTag({ content: CLEAN_CSS });
          try {
            await page.waitForSelector(`.dc-scene[data-scene="${id}"]`, { timeout: 10_000 });
          } catch {
            throw new PageExportError("render-failed", `The player did not show scene "${id}".`);
          }
          await Promise.race([
            page.evaluate(() => (window as { depthcue?: { settled(): Promise<void> } }).depthcue?.settled()),
            new Promise((resolve) => setTimeout(resolve, 15_000)),
          ]);
          if (caption !== undefined) {
            // The player's own caption box, in the place and style it has when the recording plays.
            await page.evaluate((text) => {
              const box = document.querySelector(".dc-captions");
              if (box instanceof HTMLElement) {
                box.textContent = text;
                box.hidden = false;
              }
            }, caption);
          }
          const png = join(work, `${made.size}.png`);
          writeFileSync(png, await page.screenshot({ type: "png", animations: "disabled", caret: "hide" }));
          made.set(shotKey(id, step, caption), png);
        } finally {
          await context.close();
        }
      }
    }
    return made;
  } finally {
    await browser.close();
    await server.close();
  }
}

const shotKey = (id: string, step: number, caption: string | undefined) =>
  JSON.stringify([id, step, caption ?? null]);

/** The ffmpeg concat list for pictures held for given seconds. The last file is named again, as the format needs. */
export function concatList(entries: ReadonlyArray<{ file: string; seconds: number }>): string {
  const quote = (file: string) => `'${file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  const lines = entries.flatMap((entry) => [
    `file ${quote(entry.file)}`,
    `duration ${entry.seconds.toFixed(3)}`,
  ]);
  const last = entries.at(-1);
  if (last) lines.push(`file ${quote(last.file)}`);
  return `${lines.join("\n")}\n`;
}

/** An MP4 of the deck: each scene's pictures with its voice-over under them. */
export async function renderVideo(request: { folder: string } & VideoOptions): Promise<VideoResult> {
  const opened = openDeck(request.folder);
  if (!opened.ok) return { ok: false, diagnostics: opened.diagnostics };
  const { doc } = opened;
  const hold = request.hold ?? 5;
  const ffmpeg = request.ffmpeg ?? process.env.DEPTHCUE_FFMPEG ?? "ffmpeg";
  const playerDir = request.playerDir ?? builtPlayerDir();
  const work = mkdtempSync(join(tmpdir(), "depthcue-video-"));
  try {
    const player = request.captions ? await import("@depthcue/player") : undefined;
    const plan = doc.deck.scenes.map((id) => {
      const scene = doc.scenes[id] as Scene;
      const steps = scene.steps?.length ?? 0;
      const recording = recordingOf(request.folder, scene);
      const seconds = recording ? recording.seconds + TAIL : hold;
      const track = player && recording ? trackOf(player, scene, recording) : undefined;
      const shots = shotsOf(steps, recording?.marks ?? [], seconds, track);
      return { id, recording, seconds, shots };
    });
    const wanted = new Map(
      plan.map((entry) => [
        entry.id,
        entry.shots.filter(
          (shot, at, all) =>
            all.findIndex((other) => other.step === shot.step && other.caption === shot.caption) === at,
        ),
      ]),
    );
    const pictures = await stills(request.folder, doc, playerDir, wanted, work);

    const clips: string[] = [];
    for (const [at, entry] of plan.entries()) {
      const list = join(work, `${at}.txt`);
      writeFileSync(
        list,
        concatList(
          entry.shots.map((shot) => ({
            file: pictures.get(shotKey(entry.id, shot.step, shot.caption)) as string,
            seconds: shot.seconds,
          })),
        ),
      );
      const clip = join(work, `${at}.mp4`);
      const sound = entry.recording
        ? ["-i", entry.recording.file]
        : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"];
      await run(ffmpeg, [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        ...sound,
        "-vf",
        `fps=${FPS},scale=1920:1080,format=yuv420p`,
        "-af",
        "aresample=44100,apad",
        "-ac",
        "2",
        "-t",
        entry.seconds.toFixed(3),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        clip,
      ]);
      clips.push(clip);
    }

    const all = join(work, "all.txt");
    writeFileSync(
      all,
      clips.map((clip) => `file '${clip.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n"),
    );
    const out = join(work, "deck.mp4");
    await run(ffmpeg, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      all,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      out,
    ]);
    return {
      ok: true,
      bytes: readFileSync(out),
      summary: {
        scenes: plan.length,
        seconds: plan.reduce((total, entry) => total + entry.seconds, 0),
        voiced: plan.filter((entry) => entry.recording).length,
      },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
