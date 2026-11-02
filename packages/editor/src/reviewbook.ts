import {
  acceptChanges,
  type Change,
  type Diagnostic,
  type Doc,
  diffDocs,
  type Review,
  type ReviewFailure,
  revertOps,
  reviewChanges,
  reviewRevision,
  type Session,
} from "@depthcue/core";
import type { Api } from "./api.ts";
import { loadBuiltIns } from "./brandchecks.ts";
import type { History } from "./history.ts";

export interface ReviewState {
  /** The deck as it was last reviewed, and which changes are the agent's. Undefined until one is started, and while unreadable. */
  readonly review: Review | undefined;
  /** Why there is no review to show, when the file or the server could not be read. */
  readonly problem: string | undefined;
  /** False until the first read has finished, so "nothing to review" is not said before the answer is in. */
  readonly ready: boolean;
}

export type Outcome = { ok: true } | { ok: false; message: string };

export interface ReviewOptions {
  /** Why changes cannot be accepted or reverted right now, if they cannot. */
  blocked?: () => string | undefined;
}

export interface ReviewBook {
  readonly state: ReviewState;
  subscribe(listener: () => void): () => void;
  /** Reads the review again. Call it when the server says it changed, and when the connection comes back. */
  sync(): Promise<void>;
  /**
   * What differs between the reviewed deck and the one in the editor, each change marked with who made it. The edits
   * not saved yet are left out: they are the person's own, and saving copies them into the reviewed deck.
   */
  changes(): readonly Change[];
  /**
   * Marks changes as reviewed, or all of those on the list. The review file is replaced against the revision last
   * read; when it moved on, it is read again and the choice is made again on top of what is there. Undo takes it back
   * while the review is still as the accept left it.
   */
  accept(ids: readonly string[] | "all"): Promise<Outcome>;
  /** Puts changes back as they were when the deck was reviewed. One edit, so Undo and Redo treat it as any other. */
  revert(ids: readonly string[] | "all"): Outcome;
  /**
   * Changes that were reverted and then undone, which are the agent's again and must not be taken for the person's
   * own when the deck is saved. The save sends them to the server.
   */
  keepAgent(): string[];
  dispose(): void;
}

// Not `problemOf` from fields.ts: that file draws with the player, and the store, which holds this book, is also
// imported by tests in packages that cannot resolve the player before it is built.
const messageOf = (diagnostics: readonly Diagnostic[], fallback: string): string => {
  const first = diagnostics[0];
  if (!first) return fallback;
  return first.fix ? `${first.message} ${first.fix}` : first.message;
};

const failure = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** What a change says, to tell one that is still the same change from one the person has since changed again. */
const signature = (change: Change): string =>
  JSON.stringify([change.kind, change.before ?? null, change.after ?? null]);

type Replaced = { ok: true; from: Review | undefined; to: Review } | { ok: false; message: string };

/**
 * The review beside the deck: a file of its own with a revision of its own, kept apart from the session. What is
 * listed is worked out here from the reviewed deck and the deck in the editor, so an edit, an Undo or a Redo shows at
 * once, and nothing about a change is stored. Writing goes through the server, which checks the file as it would one
 * an agent wrote.
 */
export function createReviewBook(
  api: Pick<Api, "loadReview" | "saveReview">,
  session: Session,
  history: History,
  saved: () => Doc,
  options: ReviewOptions = {},
): ReviewBook {
  let review: Review | undefined;
  let problem: string | undefined;
  let ready = false;
  /** The revision the review shown was read at, or undefined while nothing usable has been read. */
  let rev: string | undefined;
  /** Counts finished writes, so a read that a write overtook can be told apart and thrown away. */
  let epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  /** Changes reverted and undone, by what they said when they came back. */
  const kept = new Map<string, string>();
  let keptVersion = 0;
  let memo: { review: Review | undefined; doc: Doc; saved: Doc; version: number; list: Change[] } | undefined;

  async function read(): Promise<void> {
    const seen = epoch;
    const answer = await api.loadReview();
    // A review holds the deck as it was, which may name a template of Depthcue's that the deck now does not, and an
    // accept or a revert that brings it back needs them in. They are fetched with the review, before it can be used.
    if (answer.ok && answer.review) await loadBuiltIns().catch(() => undefined);
    if (disposed || epoch !== seen) return; // a write finished while the file was being read, so this may predate it
    ready = true;
    if (answer.ok) {
      rev = answer.rev;
      problem = undefined;
      review = answer.review;
    } else {
      // Nothing is guessed from a review that cannot be read, and nothing is written over it.
      rev = undefined;
      problem = answer.message;
      review = undefined;
    }
    notify();
  }

  async function replace(compute: (current: Review | undefined) => Review | string): Promise<Replaced> {
    if (rev === undefined) {
      return failure(problem ?? "The review has not been read yet. Try again in a moment.");
    }
    for (let attempt = 0; ; attempt++) {
      const from = review;
      const made = compute(from);
      if (typeof made === "string") return failure(made);
      const result = await api.saveReview(made, rev as string);
      epoch += 1;
      if (result.ok) {
        rev = result.rev;
        review = result.review;
        problem = undefined;
        notify();
        return { ok: true, from, to: result.review };
      }
      if (result.kind === "stale" && attempt === 0) {
        // Somebody else wrote since this was read, such as the agent. The choice is made again on top of what they wrote.
        await read();
        if (rev === undefined) return failure(problem ?? result.message);
        continue;
      }
      void read(); // refused: what is shown may be what the refusal is about
      return failure(result.message);
    }
  }

  function changes(): readonly Change[] {
    const doc = session.doc;
    const disk = saved();
    if (
      memo &&
      memo.review === review &&
      memo.doc === doc &&
      memo.saved === disk &&
      memo.version === keptVersion
    ) {
      return memo.list;
    }
    let list: Change[] = [];
    if (review) {
      const mine = new Set(diffDocs(disk, doc).map((change) => change.id));
      list = reviewChanges(review, doc).flatMap((change): Change[] => {
        const again = kept.get(change.id) === signature(change);
        if (mine.has(change.id) && !again) return [];
        return [again ? { ...change, by: "agent" } : change];
      });
    }
    memo = { review, doc, saved: disk, version: keptVersion, list };
    return list;
  }

  const refused = (failed: ReviewFailure) =>
    failure(messageOf(failed.diagnostics, "That change was refused."));

  /** Writes `to` over `from`, if the file is still `from`: the file a step left, or the one it started from. */
  const restore = async (from: Review, to: Review, said: string): Promise<string | undefined> => {
    const result = await replace((current) =>
      current && reviewRevision(current) === reviewRevision(from) ? to : said,
    );
    return result.ok ? undefined : result.message;
  };

  async function acceptNow(ids: readonly string[] | "all"): Promise<Outcome> {
    const stopped = options.blocked?.();
    if (stopped) return failure(stopped);
    let accepted: string[] = [];
    const result = await replace((current) => {
      if (!current) return "There is no review to accept changes in.";
      const wanted = ids === "all" ? changes().map((change) => change.id) : ids;
      const made = acceptChanges(current, session.doc, wanted);
      if (!made.ok) return refused(made).message;
      accepted = made.accepted;
      return made.review;
    });
    if (!result.ok) return result;
    const { from, to } = result;
    if (accepted.length > 0 && from) {
      const now = session.rev;
      history.push({
        before: now,
        after: now,
        undo: () =>
          restore(to, from, "The review changed since this was accepted, so Undo leaves it as it is."),
        redo: () =>
          restore(from, to, "The review changed since this was undone, so Redo leaves it as it is."),
      });
    }
    return { ok: true };
  }

  return {
    get state() {
      return { review, problem, ready };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync: read,
    changes,

    accept(ids) {
      const run = queue.then(() => acceptNow(ids));
      queue = run.catch(() => undefined);
      return run;
    },

    revert(ids) {
      const stopped = options.blocked?.();
      if (stopped) return failure(stopped);
      if (!review) return failure("There is no review to revert changes in.");
      const wanted = ids === "all" ? changes().map((change) => change.id) : ids;
      const plan = revertOps(review, session.doc, wanted);
      if (!plan.ok) return refused(plan);
      if (plan.ops.length === 0) return { ok: true };
      const before = session.rev;
      const result = session.apply(plan.ops);
      if (!result.ok) return failure(messageOf(result.diagnostics, "That change was refused."));
      const { reverted } = plan;
      history.push({
        before,
        after: session.rev,
        undo() {
          session.undo();
          // The changes are back, and they are still the agent's: say so before a save takes them for the person's own.
          if (review) {
            for (const change of reviewChanges(review, session.doc)) {
              if (reverted.includes(change.id)) kept.set(change.id, signature(change));
            }
          }
          keptVersion += 1;
          notify();
          return undefined;
        },
        redo() {
          session.redo();
          for (const id of reverted) kept.delete(id);
          keptVersion += 1;
          notify();
          return undefined;
        },
      });
      return { ok: true };
    },

    keepAgent() {
      if (!review || kept.size === 0) return [];
      const live = new Map(
        reviewChanges(review, session.doc).map((change) => [change.id, signature(change)]),
      );
      return [...kept]
        .filter(([id, said]) => live.get(id) === said)
        .map(([id]) => id)
        .sort();
    },

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
