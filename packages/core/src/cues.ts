/**
 * The cue map: a small file next to a built clip that says where its parts begin and end. `depthcue clip build`
 * writes it and the player reads it, so the format and its checks live here, once.
 */

/** The format name written into every cue map, so a reader can tell what it has. */
export const CUE_MAP_FORMAT = "depthcue-cues/1";
/** More chips than this stop being a way to move around a clip. */
export const MAX_CUES = 64;
/** The longest a cue's id may be. */
export const MAX_CUE_ID = 64;
/**
 * The type of a cue a person placed by hand. Every other cue comes from the scene the clip was built from and says
 * what that video holds, so only a marker is ever edited by hand, and `depthcue clip build` keeps markers.
 */
export const MARKER_TYPE = "marker";

export interface Cue {
  id: string;
  type: string;
  /** Seconds from the start of the clip. */
  in: number;
  out: number;
}

export interface CueBuild {
  /** Hash of everything the clip was built from, so an unchanged build is skipped. */
  key: string;
  kinescript: string;
  quality: string;
  scale: number;
  scene: string;
}

export interface CueMap {
  format: typeof CUE_MAP_FORMAT;
  /** The video's path in the deck, as a clip block's source writes it. */
  source: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  cues: Cue[];
  build?: CueBuild;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A cue, or nothing when the parts are not usable. The same rules apply to what a tool printed and to a file. */
export function makeCue(id: unknown, type: unknown, start: unknown, end: unknown): Cue | undefined {
  if (typeof id !== "string" || id === "" || id.length > MAX_CUE_ID) return undefined;
  if (!finite(start) || !finite(end) || start < 0 || end < start) return undefined;
  return { id, type: typeof type === "string" ? type.slice(0, 32) : "layer", in: start, out: end };
}

/** Time order, the first of two cues with the same id, and no more than MAX_CUES. */
export function tidyCues(found: readonly Cue[]): Cue[] {
  const seen = new Set<string>();
  return found
    .filter((cue) => !seen.has(cue.id) && seen.add(cue.id))
    .sort((a, b) => a.in - b.in)
    .slice(0, MAX_CUES);
}

export const isMarker = (cue: Cue): boolean => cue.type === MARKER_TYPE;

/** Whole milliseconds: a time typed or read from a playhead has no use for more. */
export const roundedSeconds = (seconds: number): number => Math.round(seconds * 1000) / 1000;

/** `marker-1`, `marker-2`: the first of these no cue has. */
export function nextMarkerId(cues: readonly Cue[]): string {
  const taken = new Set(cues.map((cue) => cue.id));
  let n = 1;
  while (taken.has(`marker-${n}`)) n++;
  return `marker-${n}`;
}

/**
 * A marker at `at` seconds, held inside the clip. It runs to the end of the clip, which is how the player picks the
 * current cue: the one that started last and has not ended.
 */
export function newMarker(cues: readonly Cue[], at: number, duration: number): Cue | undefined {
  const start = roundedSeconds(Math.min(Math.max(0, at), duration));
  return makeCue(nextMarkerId(cues), MARKER_TYPE, start, roundedSeconds(duration));
}

/**
 * What a person may send for a clip's cues: a list the player will take whole, with every marker inside the clip.
 * Answers the cues in time order, or says what is wrong with the list in words the person can read.
 */
export function checkCues(
  given: unknown,
  duration: number,
): { ok: true; cues: Cue[] } | { ok: false; message: string } {
  if (!Array.isArray(given)) return { ok: false, message: "The cues must be a list." };
  if (given.length > MAX_CUES) {
    return { ok: false, message: `A clip holds at most ${MAX_CUES} cues, and this has ${given.length}.` };
  }
  const found: Cue[] = [];
  const ids = new Set<string>();
  for (const [index, item] of given.entries()) {
    const raw = isRecord(item) ? item : {};
    const cue = makeCue(raw.id, raw.type, raw.in, raw.out);
    if (!cue) {
      return {
        ok: false,
        message: `Cue ${index + 1} is not usable. It needs an id of 1 to ${MAX_CUE_ID} characters and a start and end in seconds, the end not before the start.`,
      };
    }
    if (ids.has(cue.id)) return { ok: false, message: `Two cues are called "${cue.id}". Ids must differ.` };
    ids.add(cue.id);
    if (isMarker(cue) && cue.in > duration) {
      return {
        ok: false,
        message: `"${cue.id}" starts at ${cue.in} s, after the clip ends at ${duration} s.`,
      };
    }
    found.push(cue);
  }
  return { ok: true, cues: tidyCues(found) };
}

/**
 * The cues of a rebuilt clip: what the scene says now, with the markers of the build it replaces kept. A marker
 * past the end of the new video is dropped, and one whose id the scene now uses gives way to the scene's cue.
 */
export function keepMarkers(built: readonly Cue[], previous: CueMap | undefined, duration: number): Cue[] {
  const kept = (previous?.cues ?? []).filter((cue) => isMarker(cue) && cue.in <= duration);
  return tidyCues([...built, ...kept]);
}

/** Where a clip's cue map is kept: `assets/intro.mp4` has `assets/intro.cues.json`. */
export function cueMapPath(source: string): string {
  const slash = source.lastIndexOf("/");
  const dot = source.lastIndexOf(".");
  return `${dot > slash + 1 ? source.slice(0, dot) : source}.cues.json`;
}

/** Reads a cue map from parsed JSON. A file is data from outside, so every field is checked; unusable cues are skipped. */
export function readCueMap(value: unknown): CueMap | undefined {
  if (!isRecord(value) || value.format !== CUE_MAP_FORMAT) return undefined;
  const { source, duration, width, height, fps, cues, build } = value;
  if (typeof source !== "string" || !finite(duration) || duration <= 0) return undefined;
  if (!finite(width) || !finite(height) || !finite(fps) || width <= 0 || height <= 0 || fps <= 0)
    return undefined;
  const found: Cue[] = [];
  for (const cue of Array.isArray(cues) ? cues : []) {
    const made = isRecord(cue) ? makeCue(cue.id, cue.type, cue.in, cue.out) : undefined;
    if (made) found.push(made);
  }
  const map: CueMap = { format: CUE_MAP_FORMAT, source, duration, width, height, fps, cues: tidyCues(found) };
  if (isRecord(build) && typeof build.key === "string") {
    map.build = {
      key: build.key,
      kinescript: typeof build.kinescript === "string" ? build.kinescript : "",
      quality: typeof build.quality === "string" ? build.quality : "",
      scale: finite(build.scale) ? build.scale : 1,
      scene: typeof build.scene === "string" ? build.scene : "",
    };
  }
  return map;
}
