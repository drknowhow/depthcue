import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  CUE_MAP_FORMAT,
  type Cue,
  type CueMap,
  cueMapPath,
  makeCue,
  readCueMap,
  tidyCues,
} from "@depthcue/core";

/**
 * Builds a clip for a deck from a Kinescript scene. Depthcue does not depend on Kinescript: it runs the `kine`
 * program the person already has, and keeps what it needs from the result next to the video in a cue map the
 * player reads. See docs/clips.md.
 */

export const QUALITIES = ["draft", "standard", "high"] as const;
export type Quality = (typeof QUALITIES)[number];

export type ClipErrorCode = "kine-missing" | "kine-failed" | "bad-scene" | "bad-name" | "cancelled";

/** A failure with a message that says what to do next. The CLI prints it and exits 2. */
export class ClipError extends Error {
  constructor(
    readonly code: ClipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClipError";
  }
}

export interface ClipBuildOptions {
  /** The deck folder. Files are written to its assets/ folder. */
  folder: string;
  /** The Kinescript scene file. */
  scene: string;
  /** Names the files: assets/<name>.mp4, .png and .cues.json. Defaults to the scene file's name. */
  name?: string;
  quality?: Quality;
  /** Shrinks the render, from 0.1 to 1. A draft at 0.5 is the fast way to try a scene. */
  scale?: number;
  /** The command that runs Kinescript, then any arguments that go before the ones Depthcue adds. */
  kine?: readonly string[];
  /** Stops the build and kills the running `kine`. */
  signal?: AbortSignal;
}

export interface ClipBuildResult {
  name: string;
  source: string;
  poster: string;
  cues: string;
  /** False when the files were already up to date and nothing was rendered. */
  built: boolean;
  cueCount: number;
  duration: number;
  width: number;
  height: number;
  kinescript: string;
  /** Seconds spent, which is near zero when nothing was rebuilt. */
  seconds: number;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** `kine` from the `--kine` flag, then DEPTHCUE_KINE, then the PATH. */
export function kineCommand(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  return [flag ?? env.DEPTHCUE_KINE ?? "kine"];
}

const MISSING = (command: string) =>
  `Could not run "${command}". Depthcue builds clips with Kinescript, which is not installed here. ` +
  "Install it with `pip install kinescript`, or point to it with --kine <path> or the DEPTHCUE_KINE variable.";

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

const OUTPUT_LIMIT = 8 * 1024 * 1024;

/** Runs the command without a shell, so a scene or deck name is never read as part of a command line. */
function exec(command: readonly string[], args: readonly string[], signal?: AbortSignal): Promise<Ran> {
  return new Promise((done, fail) => {
    const [program, ...lead] = command as [string, ...string[]];
    if (signal?.aborted) return fail(new ClipError("cancelled", "Stopped."));
    const child = spawn(program, [...lead, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      child.kill();
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", stop);
      fail(
        error.code === "ENOENT" || error.code === "EACCES"
          ? new ClipError("kine-missing", MISSING(program))
          : error,
      );
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (cancelled) fail(new ClipError("cancelled", "Stopped."));
      else done({ code, stdout, stderr });
    });
  });
}

const tail = (text: string) => text.trim().split(/\r?\n/).slice(-6).join("\n");

async function kine(
  command: readonly string[],
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const ran = await exec(command, args, signal);
  if (ran.code !== 0) {
    throw new ClipError(
      "kine-failed",
      `kine ${args[0] ?? ""} failed (exit ${ran.code}).\n${tail(ran.stderr || ran.stdout)}`.trimEnd(),
    );
  }
  return ran.stdout;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseJson(text: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch {
    // Reported below with the same words.
  }
  throw new ClipError(
    "kine-failed",
    `kine ${what} did not print a JSON object. Is this the Kinescript program?`,
  );
}

/** Reads what `kine probe` printed. It is another program's output, so every field is checked. */
export function readProbe(text: string): {
  width: number;
  height: number;
  fps: number;
  duration: number;
  cues: Cue[];
} {
  const probe = parseJson(text, "probe");
  const canvas = probe.canvas;
  if (
    !isRecord(canvas) ||
    !finite(canvas.w) ||
    !finite(canvas.h) ||
    !finite(canvas.fps) ||
    !finite(canvas.duration)
  ) {
    throw new ClipError("kine-failed", "kine probe did not report the scene's size and duration.");
  }
  const found: Cue[] = [];
  const add = (id: unknown, type: unknown, start: unknown, end: unknown) => {
    const cue = makeCue(id, type, start, end);
    if (cue) found.push(cue);
  };
  const layers = Array.isArray(probe.layers) ? probe.layers : [];
  for (const layer of layers) {
    // A child layer moves with its parent, so only the parents are places to jump to.
    if (isRecord(layer) && (layer.parent === null || layer.parent === undefined)) {
      add(layer.id, layer.type, layer.in, layer.out);
    }
  }
  const sounds = Array.isArray(probe.audio) ? probe.audio : [];
  for (const sound of sounds) if (isRecord(sound)) add(sound.id, "audio", sound.in, sound.out);

  return {
    width: canvas.w,
    height: canvas.h,
    fps: canvas.fps,
    duration: canvas.duration,
    cues: tidyCues(found),
  };
}

/**
 * Every file the scene points at that exists next to it. Their bytes are part of the build key, so changing a
 * picture or a sound rebuilds the clip even though the scene file did not change.
 */
function referencedFiles(sceneFile: string, value: unknown, found = new Set<string>()): Set<string> {
  const base = dirname(sceneFile);
  if (typeof value === "string") {
    if (value.length < 260 && /\.[A-Za-z0-9]{2,5}$/.test(value)) {
      const path = resolve(base, value);
      if (existsSync(path) && statSync(path).isFile()) found.add(path);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) referencedFiles(sceneFile, item, found);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) referencedFiles(sceneFile, item, found);
  }
  return found;
}

export function buildKey(
  sceneFile: string,
  sceneBytes: Buffer,
  kinescript: string,
  quality: Quality,
  scale: number,
): string {
  const hash = createHash("sha256");
  hash.update(`${CUE_MAP_FORMAT}\n${kinescript}\n${quality}\n${scale}\n`);
  hash.update(sceneBytes);
  let tree: unknown;
  try {
    tree = JSON.parse(sceneBytes.toString("utf8"));
  } catch {
    tree = undefined;
  }
  const files = [...referencedFiles(sceneFile, tree)].sort();
  // Each file goes in as its own digest, so where one ends and the next begins cannot change the key.
  for (const file of files) hash.update(createHash("sha256").update(readFileSync(file)).digest());
  return hash.digest("hex");
}

/** The name a clip gets from a scene file called `Intro Title.json`: `intro-title`. */
export function nameFromScene(sceneFile: string): string {
  const stem = basename(sceneFile, extname(sceneFile));
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function previousBuild(file: string): CueMap | undefined {
  try {
    return readCueMap(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

export async function buildClip(options: ClipBuildOptions): Promise<ClipBuildResult> {
  const started = Date.now();
  const command = options.kine ?? kineCommand(undefined);
  const quality = options.quality ?? "standard";
  const scale = options.scale ?? 1;
  const sceneFile = resolve(options.scene);

  let sceneBytes: Buffer;
  try {
    sceneBytes = readFileSync(sceneFile);
  } catch (error) {
    throw new ClipError(
      "bad-scene",
      `Could not read the scene file ${options.scene}: ${(error as Error).message}`,
    );
  }
  const name = options.name ?? nameFromScene(sceneFile);
  if (!NAME_PATTERN.test(name)) {
    throw new ClipError(
      "bad-name",
      `"${name}" cannot name a clip. Use lowercase letters, digits and hyphens, starting with a letter or digit.`,
    );
  }

  const assets = join(resolve(options.folder), "assets");
  const source = `assets/${name}.mp4`;
  const files = { source, poster: `assets/${name}.png`, cues: cueMapPath(source) };
  const on = (path: string) => join(resolve(options.folder), ...path.split("/"));

  const version = (await kine(command, ["--version"], options.signal)).trim();
  const key = buildKey(sceneFile, sceneBytes, version, quality, scale);

  const previous = existsSync(on(files.cues)) ? previousBuild(on(files.cues)) : undefined;
  if (previous?.build?.key === key && existsSync(on(files.source)) && existsSync(on(files.poster))) {
    return {
      name,
      ...files,
      built: false,
      cueCount: previous.cues.length,
      duration: previous.duration,
      width: previous.width,
      height: previous.height,
      kinescript: version,
      seconds: (Date.now() - started) / 1000,
    };
  }

  // Probe first: a scene Kinescript cannot read fails here, in a second, rather than after a render.
  const probe = readProbe(await kine(command, ["probe", sceneFile], options.signal));

  mkdirSync(assets, { recursive: true });
  const work = mkdtempSync(join(assets, ".building-"));
  try {
    const video = join(work, "clip.mp4");
    const poster = join(work, "poster.png");
    const scaleArgs = scale === 1 ? [] : ["--scale", String(scale)];
    const rendered = parseJson(
      await kine(command, ["render", sceneFile, "-o", video, "-q", quality, ...scaleArgs], options.signal),
      "render",
    );
    // Halfway in, so the poster shows the scene rather than its first empty frame; never past the last frame.
    const posterAt = Math.max(0, Math.min(probe.duration / 2, probe.duration - 1 / probe.fps));
    await kine(
      command,
      ["still", sceneFile, "--at", String(Number(posterAt.toFixed(3))), "-o", poster, ...scaleArgs],
      options.signal,
    );
    for (const file of [video, poster]) {
      if (!existsSync(file)) {
        throw new ClipError(
          "kine-failed",
          `kine finished without writing ${basename(file)}. Run it by hand to see why.`,
        );
      }
    }

    const width = finite(rendered.w) ? rendered.w : Math.round(probe.width * scale);
    const height = finite(rendered.h) ? rendered.h : Math.round(probe.height * scale);
    const map: CueMap = {
      format: CUE_MAP_FORMAT,
      source: files.source,
      duration: probe.duration,
      width,
      height,
      fps: probe.fps,
      cues: probe.cues,
      build: { key, kinescript: version, quality, scale, scene: basename(sceneFile) },
    };
    const sidecar = join(work, "cues.json");
    writeFileSync(sidecar, `${JSON.stringify(map, null, 2)}\n`);

    // The cue map moves last, and it carries the key, so a build stopped half way never looks finished.
    renameSync(video, on(files.source));
    renameSync(poster, on(files.poster));
    renameSync(sidecar, on(files.cues));
    return {
      name,
      ...files,
      built: true,
      cueCount: probe.cues.length,
      duration: probe.duration,
      width,
      height,
      kinescript: version,
      seconds: (Date.now() - started) / 1000,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
