import {
  type Autosave,
  attachAutosave,
  createSession,
  type Doc,
  type DraftStore,
  docToFiles,
  loadDoc,
  recoverDraft,
  type Session,
} from "@depthcue/core";
import type { Api, DeckPayload } from "./api.ts";

export type SaveState = "saved" | "dirty" | "saving" | "error";

export interface DraftNotice {
  /** `restored`: unsaved work from an earlier visit is back. `stale`: held until the visitor chooses. */
  kind: "restored" | "stale" | "unusable";
  savedAt: string;
  message: string;
}

export interface EditorStatus {
  save: SaveState;
  /** Why the last save failed, or a short note about something the editor just did on its own. */
  message: string | undefined;
  /** The files changed on disk while there were unsaved edits. Nothing is lost until the visitor picks a side. */
  conflict: { diskRev: string } | undefined;
  draft: DraftNotice | undefined;
}

/** The visitor's unsaved version of the deck, as one file they can keep. */
export interface DeckCopy {
  name: string;
  /** JSON text: the deck's files keyed by path, with the revision they were based on. */
  text: string;
}

export interface StoreOptions {
  /**
   * Milliseconds of quiet after an edit before it is saved to disk by itself. Without it only `save()` writes,
   * which is what the tests of the store itself use.
   */
  autosaveMs?: number;
  /** The longest an edit may wait while typing goes on. Defaults to five times `autosaveMs`. */
  autosaveMaxWaitMs?: number;
  /** Hands the visitor their version as a file. Needed for `keepMineAsCopy`. */
  saveCopy?: (copy: DeckCopy) => void;
}

export interface EditorStore {
  readonly session: Session;
  /** The cue files beside the videos. They are not part of the deck, so the session never sees them. */
  readonly cueApi: Pick<Api, "loadCues" | "saveCues">;
  readonly status: EditorStatus;
  subscribe(listener: () => void): () => void;
  /** Saves now, without waiting out the autosave delay. Ctrl+S and the retry button call it. */
  save(): Promise<void>;
  /** Looks at the files on disk and takes them in, or flags a conflict. Call it when the folder changes. */
  syncFromDisk(): Promise<void>;
  /** Conflict: drop the unsaved edits and load what is on disk. */
  takeDisk(): Promise<void>;
  /** Conflict: hand over the unsaved edits as a file, then load what is on disk. Nothing is overwritten. */
  keepMineAsCopy(): Promise<void>;
  /** A held draft: use it although the files changed since it was made. */
  useDraft(): void;
  /** A restored or held draft: throw it away and go back to the files on disk. */
  discardDraft(): Promise<void>;
  dismissNotice(): void;
  upload(file: File): Promise<string>;
  /** Writes the draft now. Call it when the page is about to hide. */
  flush(): void;
  dispose(): void;
}

/**
 * A cue map is kept beside its video, but no block names it, so a new one is not a new asset. The first marker of a
 * clip creates its file, and counting that would redraw the slide a moment later and send the video back to its start.
 */
const isCueMap = (path: string) => path.endsWith(".cues.json");

const docOf = (payload: DeckPayload): Doc | undefined =>
  loadDoc({ text: payload.text, assets: payload.assets }).doc ?? undefined;

/**
 * Opens the deck from the server into a core session and restores a draft left by an earlier visit. It keeps
 * three things apart: the document being edited, the revision known to be on disk, and the draft in the
 * browser. A save always names the revision it started from, so the server refuses it when someone else (an
 * agent, the CLI, a text editor) changed the files since. Autosave never overwrites those changes: it stops,
 * and the visitor either reloads the files or keeps their own version as a copy.
 */
export async function openStore(
  api: Api,
  draftsFor: (deckId: string) => DraftStore,
  options: StoreOptions = {},
): Promise<EditorStore> {
  const payload = await api.loadDeck();
  const initial = docOf(payload);
  if (!initial) throw new Error("The deck on disk does not pass validation. Run `depthcue check`.");
  const drafts = draftsFor(initial.deck.id);

  const session = createSession(initial);
  let diskRev = payload.rev;
  let saving = false;
  let failed = false;
  let pendingSync = false;
  /** An edit came in while a save was running, so the save that follows it is still owed. */
  let resave = false;
  /** Counts finished saves, so a read that a save overtook can be told apart and thrown away. */
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waitingSince = 0;
  let message: string | undefined;
  let conflict: EditorStatus["conflict"];
  let draft: DraftNotice | undefined;
  let held: Doc | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const clearDraft = () => {
    try {
      drafts.clear();
    } catch {
      // A blocked store has nothing to clear; the autosave already reported it.
    }
  };

  const autosave: Autosave = attachAutosave(session, drafts, {
    onError: (error) => {
      message = `The draft could not be kept in this browser: ${error.message}`;
      notify();
    },
  });

  const recovery = recoverDraft(drafts, { assets: initial.assets, savedRev: session.rev });
  if (recovery.status === "found") {
    if (recovery.diskChanged) {
      held = recovery.doc;
      draft = {
        kind: "stale",
        savedAt: recovery.savedAt,
        message:
          "A draft from an earlier visit was made before the files on disk changed. Editing now replaces it.",
      };
    } else {
      session.reset(recovery.doc, { dirty: true });
      draft = {
        kind: "restored",
        savedAt: recovery.savedAt,
        message: "Unsaved changes from your last visit are back.",
      };
    }
  } else if (recovery.status === "unusable") {
    clearDraft();
    draft = {
      kind: "unusable",
      savedAt: "",
      message:
        `A draft from an earlier visit could not be used and was removed. ${recovery.diagnostics[0]?.message ?? ""}`.trim(),
    };
  }

  const autosaveOn = options.autosaveMs !== undefined;
  const cancelAutosave = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  /** Starts, or restarts, the countdown to a save. Typing keeps restarting it, up to the longest wait. */
  const armAutosave = () => {
    if (!autosaveOn || conflict) return;
    const quiet = options.autosaveMs as number;
    const longest = options.autosaveMaxWaitMs ?? quiet * 5;
    const now = Date.now();
    if (timer === undefined) waitingSince = now;
    cancelAutosave();
    const wait = Math.max(0, Math.min(quiet, waitingSince + longest - now));
    timer = setTimeout(() => {
      timer = undefined;
      void store.save();
    }, wait);
  };

  session.subscribe((event) => {
    // Editing on top of a held draft replaces it, so the notice must stop offering it.
    if (held && session.dirty) {
      held = undefined;
      draft = undefined;
    }
    // Only the visitor's own edits start a save. A recovered draft waits until they act on it, because saving
    // it would make "Discard the draft" a lie.
    if (!session.dirty)
      cancelAutosave(); // undone back to what is on disk
    else if (event.type === "apply" || event.type === "undo" || event.type === "redo") {
      if (saving) resave = true;
      else armAutosave();
    }
    notify();
  });

  /** Takes the files on disk in as the clean document. False when they cannot be read or do not validate. */
  async function reload(note: string): Promise<boolean> {
    let fresh: DeckPayload;
    try {
      fresh = await api.loadDeck();
    } catch (error) {
      message = (error as Error).message;
      failed = true;
      notify();
      return false;
    }
    const doc = docOf(fresh);
    if (!doc) {
      message = "The files on disk do not pass validation right now.";
      failed = true;
      notify();
      return false;
    }
    diskRev = fresh.rev;
    conflict = undefined;
    failed = false;
    session.reset(doc);
    message = note;
    notify();
    return true;
  }

  const store: EditorStore = {
    session,
    cueApi: {
      loadCues: (source) => api.loadCues(source),
      saveCues: (source, cues, clip) => api.saveCues(source, cues, clip),
    },
    get status() {
      // "dirty" means edits that nothing is about to save; with autosave a countdown or a save is under way.
      const pending = timer !== undefined || resave;
      const save: SaveState = saving
        ? "saving"
        : failed
          ? "error"
          : session.dirty
            ? pending
              ? "saving"
              : "dirty"
            : "saved";
      return { save, message, conflict, draft };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async save() {
      cancelAutosave();
      if (conflict) return;
      if (saving) {
        resave = true; // the running save started before the latest edit, so another one follows it
        return;
      }
      const files = docToFiles(session.doc);
      saving = true;
      message = undefined;
      notify();
      const result = await api.save(files, diskRev);
      saving = false;
      epoch += 1;
      if (result.ok) {
        diskRev = result.rev;
        failed = false;
        if (draft?.kind === "restored") draft = undefined; // it is on disk now, so there is nothing to discard
        session.markSaved(result.rev);
      } else if (result.kind === "stale") {
        conflict = { diskRev: result.rev };
        failed = true;
        message = "The files changed on disk while you were editing.";
      } else {
        const first = result.diagnostics[0];
        failed = true;
        message = first ? `${result.message} ${first.at}: ${first.message}` : result.message;
      }
      notify();
      if (pendingSync) {
        pendingSync = false;
        await store.syncFromDisk();
      }
      // Edits made while this save was running are not in it. A failed save waits for the next edit instead.
      if (resave) {
        resave = false;
        if (result.ok && session.dirty) armAutosave();
        else notify();
      }
    },

    async syncFromDisk() {
      if (saving) {
        pendingSync = true;
        return;
      }
      const seen = epoch;
      let fresh: DeckPayload;
      try {
        fresh = await api.loadDeck();
      } catch {
        return; // half-written or briefly invalid while someone saves; the next change event tries again
      }
      if (saving || epoch !== seen) {
        // A save was running or finished while the files were being read, so what came back may predate it.
        if (saving) pendingSync = true;
        else await store.syncFromDisk();
        return;
      }
      const doc = docOf(fresh);
      if (!doc) return;
      session.addAssets(fresh.assets.filter((path) => !isCueMap(path)));
      if (fresh.rev === diskRev) return;
      if (fresh.rev === session.rev) {
        diskRev = fresh.rev;
        conflict = undefined;
        failed = false;
        session.markSaved();
      } else if (!session.dirty) {
        diskRev = fresh.rev;
        conflict = undefined;
        failed = false;
        session.reset(doc);
        message = "Updated from the files on disk.";
      } else {
        conflict = { diskRev: fresh.rev };
        failed = true;
        message = "The files changed on disk while you were editing.";
      }
      notify();
    },

    async takeDisk() {
      await reload("Loaded the files from disk. Your unsaved edits were dropped.");
    },

    async keepMineAsCopy() {
      if (!conflict) return;
      if (!options.saveCopy) {
        message = "This editor cannot hand over a copy. Reload the files, or copy your text out first.";
        notify();
        return;
      }
      const { doc } = session;
      const name = `${doc.deck.id}-my-edits.json`;
      const text = `${JSON.stringify({ deck: doc.deck.id, baseRev: diskRev, files: docToFiles(doc) }, null, 2)}\n`;
      options.saveCopy({ name, text });
      await reload(`Your version was downloaded as ${name}. These are the files from disk.`);
    },

    useDraft() {
      if (!held) return;
      const doc = held;
      held = undefined;
      draft = undefined;
      session.reset(doc, { dirty: true });
      notify();
    },

    async discardDraft() {
      held = undefined;
      draft = undefined;
      if (!(await reload("Draft discarded."))) return;
      clearDraft();
    },

    dismissNotice() {
      if (draft?.kind === "stale") return; // it is a question; it stays until answered
      const keeping = draft?.kind === "restored" && session.dirty; // "Keep editing": now it may be saved
      draft = undefined;
      message = undefined;
      if (keeping) armAutosave();
      notify();
    },

    async upload(file) {
      const asset = await api.uploadAsset(file, file.name);
      session.addAssets([asset]);
      return asset;
    },

    flush: () => autosave.flush(),

    dispose() {
      cancelAutosave();
      autosave.stop();
      listeners.clear();
    },
  };
  return store;
}
