import { type Cue, checkCues, isMarker, newMarker, roundedSeconds } from "@depthcue/core";
import type { Api, ClipSize, CueList } from "./api.ts";

/**
 * What the editor knows of one video's cues. A cue map is a file beside the video, not part of the deck, so its
 * changes are written straight to the server and are not in the deck's undo history. `undoable` counts the
 * marker changes made here that Undo in the Cues popover can take back.
 */
export interface CueEntry {
  /** `loading` until the server answers, `failed` when it could not be asked. */
  phase: "loading" | "ready" | "failed";
  state: CueList["state"];
  cues: readonly Cue[];
  /** Seconds. Known once the clip has a cue map. */
  duration: number | undefined;
  undoable: number;
}

export interface CueBook {
  /** What is known of a video's cues. The first ask for a video starts loading it. */
  entry(source: string): CueEntry;
  /** Asks the server again, for a video whose cues could not be read. */
  reload(source: string): void;
  /** Adds a marker at `at` seconds. `size` is what the browser measured, and is only used when there is no cue map yet. */
  addMarker(source: string, at: number, size?: ClipSize): Promise<boolean>;
  renameMarker(source: string, id: string, name: string): Promise<boolean>;
  /** Moves a marker to `at` seconds. */
  moveMarker(source: string, id: string, at: number): Promise<boolean>;
  removeMarker(source: string, id: string): Promise<boolean>;
  /** Takes back the last change to the markers made here. */
  undo(source: string): Promise<boolean>;
}

export interface CueBookHooks {
  /** Says why a change was refused, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Something about a video's cues changed: a load finished, or a marker was saved. */
  changed(): void;
}

const MAX_UNDO = 20;

interface Held {
  entry: Omit<CueEntry, "undoable">;
  /** The markers as they were before each change, newest last. */
  undo: Array<readonly Cue[]>;
  /** Changes to one clip run one after another, each starting from what the server has then. */
  queue: Promise<unknown>;
}

const reason = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export function createCueBook(api: Pick<Api, "loadCues" | "saveCues">, hooks: CueBookHooks): CueBook {
  const held = new Map<string, Held>();

  function view(source: string): Held {
    const found = held.get(source);
    if (found) return found;
    const fresh: Held = {
      entry: { phase: "loading", state: "none", cues: [], duration: undefined },
      undo: [],
      queue: Promise.resolve(),
    };
    held.set(source, fresh);
    load(source, fresh);
    return fresh;
  }

  function take(into: Held, list: CueList) {
    into.entry = { phase: "ready", state: list.state, cues: list.cues, duration: list.duration };
  }

  function load(source: string, into: Held) {
    api.loadCues(source).then(
      (list) => {
        take(into, list);
        hooks.changed();
      },
      () => {
        into.entry = { phase: "failed", state: "none", cues: [], duration: undefined };
        hooks.changed();
      },
    );
  }

  /**
   * Runs one change to a clip's markers. The file is read again first, so a rebuild or an edit made since the
   * last look is not written over. `edit` gets the cues and the clip's length and answers the new list, or the
   * reason there cannot be one.
   */
  function change(
    source: string,
    edit: (cues: readonly Cue[], duration: number) => readonly Cue[] | string,
    size?: ClipSize,
    record = true,
  ): Promise<boolean> {
    const clip = view(source);
    const run = async (): Promise<boolean> => {
      try {
        take(clip, await api.loadCues(source));
      } catch (error) {
        hooks.problem(reason(error, "The cues could not be read."));
        return false;
      }
      const { state, cues } = clip.entry;
      if (state === "broken") {
        hooks.problem(
          "The cue file next to this video is not one the editor can read, so it was left alone.",
        );
        return false;
      }
      const duration = clip.entry.duration ?? size?.duration;
      if (duration === undefined || !(duration > 0)) {
        hooks.problem(
          "The length of the video is not known yet. Press play on it for a moment, then try again.",
        );
        return false;
      }
      const next = edit(cues, duration);
      if (typeof next === "string") {
        hooks.problem(next);
        return false;
      }
      const checked = checkCues(next, duration);
      if (!checked.ok) {
        hooks.problem(checked.message);
        return false;
      }
      try {
        const saved = await api.saveCues(source, checked.cues, state === "none" ? size : undefined);
        if (record) {
          clip.undo.push(cues.filter(isMarker));
          if (clip.undo.length > MAX_UNDO) clip.undo.shift();
        }
        take(clip, { state: "ok", cues: saved.cues, duration: saved.duration });
        hooks.problem(undefined);
        hooks.changed();
        return true;
      } catch (error) {
        hooks.problem(reason(error, "The cues could not be saved."));
        return false;
      }
    };
    const result = clip.queue.then(run, run);
    clip.queue = result;
    return result;
  }

  /** Swaps one marker for what `make` says, and leaves every other cue as it is. */
  const edited = (id: string, make: (marker: Cue, cues: readonly Cue[], duration: number) => Cue) => {
    return (cues: readonly Cue[], duration: number): readonly Cue[] | string => {
      const marker = cues.find((cue) => cue.id === id && isMarker(cue));
      if (!marker) return `There is no marker called "${id}".`;
      return cues.map((cue) => (cue === marker ? make(marker, cues, duration) : cue));
    };
  };

  return {
    entry(source) {
      const clip = view(source);
      return { ...clip.entry, undoable: clip.undo.length };
    },

    reload(source) {
      const clip = view(source);
      clip.entry = { phase: "loading", state: "none", cues: [], duration: undefined };
      hooks.changed();
      load(source, clip);
    },

    addMarker(source, at, size) {
      return change(
        source,
        (cues, duration) => {
          const marker = newMarker(cues, at, duration);
          return marker ? [...cues, marker] : "That time cannot hold a marker.";
        },
        size,
      );
    },

    renameMarker(source, id, name) {
      const trimmed = name.trim();
      if (trimmed === id) return Promise.resolve(true);
      if (trimmed === "") {
        hooks.problem("A marker needs a name.");
        return Promise.resolve(false);
      }
      return change(
        source,
        edited(id, (marker) => ({ ...marker, id: trimmed })),
      );
    },

    moveMarker(source, id, at) {
      return change(
        source,
        edited(id, (marker, _cues, duration) => ({
          ...marker,
          in: roundedSeconds(Math.min(Math.max(0, at), duration)),
          out: roundedSeconds(duration),
        })),
      );
    },

    removeMarker(source, id) {
      return change(source, (cues) => {
        if (!cues.some((cue) => cue.id === id && isMarker(cue))) return `There is no marker called "${id}".`;
        return cues.filter((cue) => cue.id !== id);
      });
    },

    undo(source) {
      const clip = view(source);
      const before = clip.undo.pop();
      if (!before) return Promise.resolve(false);
      // Only the markers go back. A rebuild may have changed the cues that come from the scene since.
      const done = change(
        source,
        (cues) => [...cues.filter((cue) => !isMarker(cue)), ...before],
        undefined,
        false,
      );
      return done.then((ok) => {
        if (!ok) clip.undo.push(before);
        return ok;
      });
    },
  };
}

/** 0:07, 12:30: the form the player's chips use. */
export const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** The video of a clip block on the slide, if it has one. */
export const videoOf = (node: Element | undefined): HTMLVideoElement | null =>
  node?.querySelector("video") ?? null;

/** How long to wait for a video's first bytes before saying its length cannot be read. */
const MEASURE_WAIT_MS = 8000;

/**
 * What a clip measures. The video on the slide is used when it has loaded enough to say. Otherwise the file is
 * asked about in a video of its own that is never shown, so the one on the slide is not reset to its start.
 */
export function measureClip(video: HTMLVideoElement, wait = MEASURE_WAIT_MS): Promise<ClipSize | undefined> {
  const read = (from: HTMLVideoElement): ClipSize | undefined => {
    const { duration, videoWidth: width, videoHeight: height } = from;
    return Number.isFinite(duration) && duration > 0 && width > 0 && height > 0
      ? { duration, width, height }
      : undefined;
  };
  const known = read(video);
  if (known) return Promise.resolve(known);
  const source = video.currentSrc || video.src;
  if (!source) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    const finish = (size: ClipSize | undefined) => {
      clearTimeout(timer);
      probe.removeAttribute("src");
      probe.load();
      resolve(size);
    };
    const timer = setTimeout(() => finish(undefined), wait);
    probe.addEventListener("loadedmetadata", () => finish(read(probe)), { once: true });
    probe.addEventListener("error", () => finish(undefined), { once: true });
    probe.src = source;
  });
}
