import {
  type Autosave,
  attachAutosave,
  createSession,
  type Diagnostic,
  type Doc,
  type DraftStore,
  docToFiles,
  loadDoc,
  recoverDraft,
  type Session,
} from "@depthcue/core";
import type { Api, DeckPayload } from "./api.ts";
import { loadBrandChecks, loadBuiltIns, waitedForBrandChecks, waitedForBuiltIns } from "./brandchecks.ts";
import { type CommentBook, createCommentBook } from "./commentbook.ts";
import { createHistory, type History } from "./history.ts";
import { createReviewBook, type ReviewBook } from "./reviewbook.ts";

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
  /** What a render of the saved deck finds wrong, for the problem ribbon. */
  readonly layoutApi: Pick<Api, "loadLayout">;
  /**
   * The comments beside the deck. Like the cues they are a file of their own, so the session never sees them and an
   * edit to the deck never saves them. Read it again with `comments.sync()` when the server says they changed.
   */
  readonly comments: CommentBook;
  /**
   * The changes since the deck was last reviewed, and the answers to them. Also a file of its own: it is read again
   * with `review.sync()` when the server says it changed, and a save of the deck sends it what the review needs to know.
   */
  readonly review: ReviewBook;
  /** Undo and redo: the session's, and the steps taken outside it, such as accepting a change, in their place among them. */
  readonly history: History;
  /** The deck as the files on disk have it, as far as this editor knows. The session's document is that and the unsaved edits. */
  readonly saved: Doc;
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

/**
 * What the store says when a chunk the editor fetches on demand (the brand checks, or Depthcue's own templates and
 * styles) does not arrive, as when the network fails or the build changed.
 */
export const CHECKS_FAILED = "Could not load part of the editor; reload the page.";

/** True when what a read of the deck said may change once a chunk the editor fetches on demand is in. */
const waitedForChunk = (diagnostics: readonly Diagnostic[]): boolean =>
  waitedForBrandChecks(diagnostics) || waitedForBuiltIns(diagnostics);

/** Fetches what a read of the deck waited for, rejecting with `CHECKS_FAILED` when a chunk does not arrive. */
async function chunksIn(diagnostics: readonly Diagnostic[]): Promise<void> {
  // `loadBuiltIns` never rejects: a fetch of it that failed is told by its records still being empty.
  const arrived = await Promise.all([
    waitedForBrandChecks(diagnostics) && loadBrandChecks(),
    waitedForBuiltIns(diagnostics) && loadBuiltIns(),
  ]).then(
    () => !waitedForBuiltIns(diagnostics),
    () => false,
  );
  if (!arrived) throw new Error(CHECKS_FAILED);
}

/**
 * Reads the deck from the server's files, fetching the brand checks or the built-in templates first when the read had to
 * wait for them. Rejects with `CHECKS_FAILED` when they cannot be fetched.
 */
async function docOf(payload: DeckPayload): Promise<Doc | undefined> {
  const files = { text: payload.text, assets: payload.assets, brandFiles: payload.brandFiles ?? [] };
  let loaded = loadDoc(files);
  if (waitedForChunk(loaded.diagnostics)) {
    await chunksIn(loaded.diagnostics);
    loaded = loadDoc(files);
  }
  return loaded.doc ?? undefined;
}

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
  const initial = await docOf(payload);
  if (!initial) throw new Error("The deck on disk does not pass validation. Run `depthcue check`.");
  const drafts = draftsFor(initial.deck.id);

  const session = createSession(initial);
  /** The document the files on disk hold, for telling the person's unsaved edits from the changes already reviewed. */
  let onDisk: Doc = initial;
  const history = createHistory(session);
  // Read in the background: the deck is what the visitor came for, and the pins appear when the answer is in.
  const comments = createCommentBook(api);
  void comments.sync();
  const review = createReviewBook(api, session, history, () => onDisk, {
    // Accepting copies the unsaved deck into the review, which is not what is on disk until the person picks a side.
    blocked: () =>
      conflict
        ? "The files changed on disk while you were editing. Reload them, or keep your version first."
        : undefined,
  });
  void review.sync();
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

  const recover = () =>
    recoverDraft(drafts, {
      assets: initial.assets,
      ...(initial.brandFiles === undefined ? {} : { brandFiles: initial.brandFiles }),
      savedRev: session.rev,
    });
  let recovery = recover();
  // A draft with a brand on a deck that has none on disk waits for the brand checks; it is not thrown away for that,
  // nor when they cannot be fetched: the deck does not open, and the draft is there for the next try.
  if (recovery.status === "unusable" && waitedForChunk(recovery.diagnostics)) {
    await chunksIn(recovery.diagnostics);
    recovery = recover();
  }
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
    let doc: Doc | undefined;
    try {
      fresh = await api.loadDeck();
      doc = await docOf(fresh);
    } catch (error) {
      message = (error as Error).message;
      failed = true;
      notify();
      return false;
    }
    if (!doc) {
      message = "The files on disk do not pass validation right now.";
      failed = true;
      notify();
      return false;
    }
    diskRev = fresh.rev;
    onDisk = doc;
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
    layoutApi: { loadLayout: (scene) => api.loadLayout(scene) },
    comments,
    review,
    history,
    get saved() {
      return onDisk;
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
      const sent = session.doc;
      const files = docToFiles(sent);
      // Changes the person reverted and then undid are the agent's again, which the files alone do not say.
      const keepAgent = review.keepAgent();
      saving = true;
      message = undefined;
      notify();
      const result = await api.save(files, diskRev, keepAgent.length > 0 ? { keepAgent } : undefined);
      saving = false;
      epoch += 1;
      if (result.ok) {
        diskRev = result.rev;
        onDisk = sent;
        // The server copied these edits into the reviewed deck, so the review is read again before anything redraws.
        void review.sync();
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
      // Read before the check below, since reading may wait for the brand checks to load.
      let doc: Doc | undefined;
      let broken: string | undefined;
      try {
        doc = await docOf(fresh);
      } catch (error) {
        broken = (error as Error).message;
      }
      if (saving || epoch !== seen) {
        // A save was running or finished while the files were being read, so what came back may predate it.
        if (saving) pendingSync = true;
        else await store.syncFromDisk();
        return;
      }
      if (broken !== undefined) {
        // The files on disk cannot be checked here, so they are not taken in.
        failed = true;
        message = broken;
        notify();
        return;
      }
      if (!doc) return;
      session.addAssets(fresh.assets.filter((path) => !isCueMap(path)));
      if (fresh.rev === diskRev) return;
      if (fresh.rev === session.rev) {
        diskRev = fresh.rev;
        onDisk = session.doc;
        conflict = undefined;
        failed = false;
        session.markSaved();
      } else if (!session.dirty) {
        diskRev = fresh.rev;
        onDisk = doc;
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
      comments.dispose();
      review.dispose();
      history.dispose();
      listeners.clear();
    },
  };
  return store;
}
