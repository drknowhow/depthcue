import type { Session } from "@depthcue/core";

/**
 * Something the person did that is not an edit of the deck, such as accepting a change, so that Undo takes it back
 * in its place among the edits the session keeps. The session knows nothing of it, so the step is tied to the
 * revisions the deck had around it.
 */
export interface Step {
  /** The deck's revision before the step was done, and after. They are the same for a step that leaves the deck alone. */
  before: string;
  after: string;
  /** Takes the step back. Resolves with why when it cannot be, and the step is then forgotten. */
  undo(): Promise<string | undefined> | string | undefined;
  redo(): Promise<string | undefined> | string | undefined;
}

export interface History {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Undoes the latest thing done, an edit or a step. Resolves with why when a step could not be taken back. */
  undo(): Promise<string | undefined>;
  redo(): Promise<string | undefined>;
  /** Records a step that has just been done. It clears what could have been redone, as an edit does. */
  push(step: Step): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/**
 * The session's undo and redo with the steps the person took outside it in between. A step comes up when the deck is
 * back at the revision it was done at, which is when everything done after it has been undone. Loading other files
 * starts over, because the steps were about the ones that are gone.
 */
export function createHistory(session: Session): History {
  const done: Step[] = [];
  const undone: Step[] = [];
  let busy = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const stop = session.subscribe((event) => {
    // A brand file taken in moves every revision, which the steps are tied to.
    if (event.type === "reset" || event.type === "files") {
      done.length = 0;
      undone.length = 0;
    } else if (event.type === "apply") undone.length = 0;
  });

  const undoable = () => done.at(-1)?.after === session.rev;
  const redoable = () => undone.at(-1)?.before === session.rev;

  return {
    get canUndo() {
      return !busy && (session.canUndo || undoable());
    },
    get canRedo() {
      return !busy && (session.canRedo || redoable());
    },

    async undo() {
      if (busy) return undefined;
      const step = done.at(-1);
      if (!step || !undoable()) {
        session.undo();
        return undefined;
      }
      done.pop();
      busy = true;
      notify();
      try {
        const problem = await step.undo();
        if (problem === undefined) undone.push(step);
        return problem;
      } finally {
        busy = false;
        notify();
      }
    },

    async redo() {
      if (busy) return undefined;
      const step = undone.at(-1);
      if (!step || !redoable()) {
        session.redo();
        return undefined;
      }
      undone.pop();
      busy = true;
      notify();
      try {
        const problem = await step.redo();
        if (problem === undefined) done.push(step);
        return problem;
      } finally {
        busy = false;
        notify();
      }
    },

    push(step) {
      done.push(step);
      undone.length = 0;
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      stop();
      listeners.clear();
    },
  };
}
