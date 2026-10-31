/**
 * The cue map: a small file next to a built clip that says where its parts begin and end. `depthcue clip build`
 * writes it and the player reads it, so the format and its checks live here, once.
 */

/** The format name written into every cue map, so a reader can tell what it has. */
export const CUE_MAP_FORMAT = "depthcue-cues/1";
/** More chips than this stop being a way to move around a clip. */
export const MAX_CUES = 64;

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
  if (typeof id !== "string" || id === "" || id.length > 64) return undefined;
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
