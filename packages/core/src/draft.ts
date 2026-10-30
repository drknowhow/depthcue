import { checkDoc, type Doc, revisionOf } from "./doc.ts";
import type { Session } from "./session.ts";
import type { Deck, Diagnostic, Scene } from "./types.ts";

export const DRAFT_FORMAT = "depthcue-draft/1";

/**
 * Where a draft lives. The host supplies it: localStorage or IndexedDB in a browser, a file in Node. `write`
 * should replace the previous draft atomically, for a file by writing a temporary one and renaming it.
 */
export interface DraftStore {
  read(): string | null;
  write(text: string): void;
  clear(): void;
}

export function memoryDraftStore(initial: string | null = null): DraftStore & { text(): string | null } {
  let text = initial;
  return {
    read: () => text,
    write: (next) => {
      text = next;
    },
    clear: () => {
      text = null;
    },
    text: () => text,
  };
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const systemTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface AutosaveOptions {
  /** Longest an edit waits before it reaches the store. Default 500 ms. */
  delayMs?: number;
  timers?: Timers;
  now?: () => Date;
  onError?: (error: Error) => void;
}

export interface Autosave {
  /** Writes now if there are unsaved changes. Call it before the page hides or the process exits. */
  flush(): void;
  stop(): void;
  readonly lastError: Error | undefined;
}

export function serializeDraft(session: Pick<Session, "doc" | "rev" | "savedRev">, savedAt: Date): string {
  const { doc } = session;
  return JSON.stringify({
    format: DRAFT_FORMAT,
    savedAt: savedAt.toISOString(),
    savedRev: session.savedRev,
    rev: session.rev,
    deck: doc.deck,
    scenes: doc.deck.scenes.map((id) => doc.scenes[id]),
  });
}

/**
 * Keeps a draft of unsaved work in `store`. The first change after a save starts a timer and the draft is
 * written when it fires, so a crash loses at most `delayMs` of edits even while someone types without pause.
 * Saving the deck clears the draft. A failing store never interrupts editing: the error is kept and reported,
 * and the next change tries again.
 */
export function attachAutosave(session: Session, store: DraftStore, options: AutosaveOptions = {}): Autosave {
  const timers = options.timers ?? systemTimers;
  const delayMs = options.delayMs ?? 500;
  const now = options.now ?? (() => new Date());
  let pending: unknown;
  let lastError: Error | undefined;

  const attempt = (action: () => void) => {
    try {
      action();
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      options.onError?.(lastError);
    }
  };
  const cancel = () => {
    if (pending !== undefined) timers.clear(pending);
    pending = undefined;
  };
  const write = () => {
    cancel();
    if (session.dirty) attempt(() => store.write(serializeDraft(session, now())));
  };
  const schedule = () => {
    if (pending === undefined) {
      pending = timers.set(() => {
        pending = undefined;
        write();
      }, delayMs);
    }
  };

  const unsubscribe = session.subscribe(() => {
    if (session.dirty) {
      schedule();
    } else {
      cancel();
      attempt(() => store.clear());
    }
  });
  if (session.dirty) schedule();

  return {
    flush: write,
    stop() {
      unsubscribe();
      cancel();
    },
    get lastError() {
      return lastError;
    },
  };
}

export type Recovery =
  | { status: "none" }
  | {
      status: "found";
      doc: Doc;
      rev: string;
      savedAt: string;
      /** The saved files changed after the draft was written, for example by a hand edit. Warn before using it. */
      diskChanged: boolean;
    }
  | { status: "unusable"; diagnostics: Diagnostic[] };

const unusable = (message: string, diagnostics: Diagnostic[] = []): Recovery => ({
  status: "unusable",
  diagnostics: [
    {
      severity: "error",
      code: "bad-draft",
      file: "draft",
      path: "",
      message,
      fix: "Discard the draft and open the saved deck.",
    },
    ...diagnostics,
  ],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a draft left by a crashed or closed session. It never throws and never changes the store: a draft that
 * does not parse, fails validation or does not match its own revision comes back as `unusable`, and the caller
 * decides whether to discard it. `context` describes the deck as saved now.
 */
export function recoverDraft(
  store: DraftStore,
  context: { assets: ReadonlySet<string>; savedRev: string },
): Recovery {
  let text: string | null;
  try {
    text = store.read();
  } catch (error) {
    return unusable(`The draft could not be read: ${(error as Error).message}`);
  }
  if (text === null) return { status: "none" };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return unusable("The draft is not valid JSON; it was probably cut short.");
  }
  if (!isRecord(data) || data.format !== DRAFT_FORMAT) return unusable("This is not a Depthcue draft.");
  if (!isRecord(data.deck) || !Array.isArray(data.scenes) || typeof data.rev !== "string") {
    return unusable("The draft is missing its deck, scenes or revision.");
  }

  const scenes = Object.create(null) as Record<string, Scene>;
  for (const scene of data.scenes) {
    if (!isRecord(scene) || typeof scene.id !== "string") return unusable("A scene in the draft has no id.");
    scenes[scene.id] = scene as unknown as Scene;
  }
  const doc: Doc = { deck: data.deck as unknown as Deck, scenes, assets: context.assets };
  const errors = checkDoc(doc).filter((d) => d.severity === "error");
  if (errors.length > 0) return unusable("The draft no longer passes validation.", errors);
  if (revisionOf(doc) !== data.rev)
    return unusable("The draft does not match its own revision; it was edited or damaged.");

  return {
    status: "found",
    doc,
    rev: data.rev,
    savedAt: typeof data.savedAt === "string" ? data.savedAt : "",
    diskChanged: data.savedRev !== context.savedRev,
  };
}
