import {
  acceptChanges,
  type Change,
  type Diagnostic,
  type Doc,
  type Review,
  type ReviewFailure,
  revertChanges,
  reviewChanges,
  reviewRevision,
  revisionOf,
  startReview,
} from "@depthcue/core";
import { openDeck } from "./deck-api.ts";
import { loadReviewDir, saveReviewDir } from "./review-file.ts";
import { ChangedOnDiskError, RefusedSaveError, saveDeckDir } from "./save.ts";

export interface ChangeList {
  /** The deck's revision now. */
  rev: string;
  /** The revision the deck had when it was last reviewed, or null when nobody has started a review. */
  reviewed: string | null;
  /** How many of the changes the agent made, and how many were made some other way, by hand. */
  agent: number;
  outside: number;
  changes: Change[];
}

/** The changes since the review. With no review there is no baseline, so no changes. */
export function listChanges(doc: Doc, review: Review | undefined): ChangeList {
  const changes = review === undefined ? [] : reviewChanges(review, doc);
  const agent = changes.filter((change) => change.by === "agent").length;
  return {
    rev: revisionOf(doc),
    reviewed: review?.rev ?? null,
    agent,
    outside: changes.length - agent,
    changes,
  };
}

export type ReviewCode =
  | "unreadable-deck"
  | "unreadable-review"
  | "no-review"
  | "unknown-change"
  | "bad-op"
  | "invalid-deck"
  | "changed-on-disk"
  | "refused-save";

export interface ReviewRefusal {
  ok: false;
  code: ReviewCode;
  diagnostics: Diagnostic[];
  /** What to do next, in words an agent can act on. */
  hint: string;
  /** For `unknown-change`: the ids that are not changes. */
  unknown?: string[];
}

const HINTS: Record<ReviewCode, string> = {
  "unreadable-deck":
    "The deck folder has errors that must be fixed by hand first. Run `depthcue check` on it.",
  "unreadable-review":
    "review.json is not valid, so it was not changed. Delete it to start a new review from the deck as it is.",
  "no-review":
    "Nobody has started a review of this deck: the first edit through the tools does, or `depthcue diff <deck-folder> accept --all` starts it now. There is nothing to compare with yet.",
  "unknown-change":
    "Nothing was changed. List the changes with `depthcue diff <deck-folder>` and name ids from that list.",
  "bad-op": "Nothing was changed. Fix what the diagnostics name.",
  "invalid-deck":
    "Nothing was changed: the result would not be a valid deck. The change may depend on another one, which has to be handled with it.",
  "changed-on-disk":
    "The deck folder changed while this was being done. Nothing was written. Read it again and retry.",
  "refused-save":
    "Nothing was written: something in the deck folder stops the save, as the diagnostics say. Change the folder, then retry.",
};

const refuse = (
  code: ReviewCode,
  diagnostics: Diagnostic[] = [],
  extra: { unknown?: string[] } = {},
): ReviewRefusal => ({
  ok: false,
  code,
  diagnostics,
  hint: HINTS[code],
  ...extra,
});

/**
 * The changes of the brand that were not chosen, when the refusal is for want of a template, a style, the brand or a
 * file it names: a scene that names a template which only an unchosen change holds fails for it, and so does a brand
 * that names a font only an unchosen file change adds, and the change to add is the one to name. The core's refusal
 * says what is missing; which change holds it is only known here. A revert is never pointed at a file change, which it
 * cannot undo.
 */
function brandChangesLeft(
  failure: ReviewFailure,
  review: Review,
  doc: Doc,
  chosen: readonly string[] | "all",
  files = true,
): string[] {
  if (
    chosen === "all" ||
    !failure.diagnostics.some((d) => /^(unknown-(template|style)|no-brand|missing-brand-file)$/.test(d.code))
  )
    return [];
  return reviewChanges(review, doc)
    .map((change) => change.id)
    .filter(
      (id) =>
        (files ? /^deck\/(brand|style:|template:|file:)/ : /^deck\/(brand|style:|template:)/).test(id) &&
        !chosen.includes(id),
    );
}

const refusal = (failure: ReviewFailure, left: readonly string[] = []): ReviewRefusal => {
  const refused = refuse(
    failure.code,
    failure.diagnostics,
    failure.unknown.length > 0 ? { unknown: failure.unknown } : {},
  );
  if (left.length === 0) return refused;
  const ids = left.map((id) => `"${id}"`).join(", ");
  return { ...refused, hint: `${refused.hint} It may be waiting for ${ids}: name them in the same call.` };
};

export type ReviewRead = { ok: true; doc: Doc; review: Review | undefined } | ReviewRefusal;

/** Reads a folder's deck and its review together. A review that is not valid is reported and never replaced. */
export function readFolderReview(folder: string): ReviewRead {
  const opened = openDeck(folder);
  if (!opened.ok) return refuse("unreadable-deck", opened.diagnostics);
  const read = loadReviewDir(folder);
  if (!read.ok) return refuse("unreadable-review", read.diagnostics);
  return { ok: true, doc: opened.doc, review: read.review };
}

export type AcceptOutcome =
  | {
      ok: true;
      accepted: string[];
      /** The revision of the deck as reviewed, now. */
      reviewed: string;
      /** Changes still to review. */
      remaining: number;
    }
  | ReviewRefusal;

/**
 * Marks changes as reviewed: the reviewed deck takes them over, and the deck itself is not touched. `all` makes the
 * reviewed deck the current one, and starts the review when there is none.
 */
export function acceptInFolder(folder: string, ids: readonly string[] | "all"): AcceptOutcome {
  const read = readFolderReview(folder);
  if (!read.ok) return read;
  try {
    if (read.review === undefined) {
      if (ids !== "all") return refuse("no-review");
      const started = startReview(read.doc);
      saveReviewDir(folder, undefined, started);
      return { ok: true, accepted: [], reviewed: started.rev, remaining: 0 };
    }
    const result = acceptChanges(read.review, read.doc, ids);
    if (!result.ok) return refusal(result, brandChangesLeft(result, read.review, read.doc, ids));
    if (reviewRevision(result.review) !== reviewRevision(read.review)) {
      saveReviewDir(folder, read.review, result.review);
    }
    return {
      ok: true,
      accepted: result.accepted,
      reviewed: result.review.rev,
      remaining: reviewChanges(result.review, read.doc).length,
    };
  } catch (error) {
    if (!(error instanceof ChangedOnDiskError)) throw error;
    return refuse("changed-on-disk");
  }
}

export type RevertOutcome =
  | {
      ok: true;
      reverted: string[];
      prevRev: string;
      rev: string;
      changed: string[];
      removed: string[];
      written: string[];
      remaining: number;
      /** Brand file changes among those named, left as they are, and why: a revert cannot bring back a file's bytes. */
      left: { id: string; why: string }[];
    }
  | ReviewRefusal;

/**
 * Puts changes back as they were when the deck was reviewed. It runs operations on the deck as it is now and writes
 * the result as a new revision, atomically, like any other edit; nothing in the history is rewritten. All of it or
 * none.
 */
export function revertInFolder(folder: string, ids: readonly string[] | "all"): RevertOutcome {
  const read = readFolderReview(folder);
  if (!read.ok) return read;
  if (read.review === undefined) return refuse("no-review");
  const result = revertChanges(read.review, read.doc, ids);
  if (!result.ok) return refusal(result, brandChangesLeft(result, read.review, read.doc, ids, false));
  let written: string[] = [];
  if (result.reverted.length > 0) {
    try {
      written = saveDeckDir(folder, read.doc, result.doc);
    } catch (error) {
      if (error instanceof RefusedSaveError) return refuse("refused-save", error.diagnostics);
      if (!(error instanceof ChangedOnDiskError)) throw error;
      return refuse("changed-on-disk");
    }
    try {
      saveReviewDir(folder, read.review, result.review);
    } catch {
      // The deck is back as it was. The review only forgets which changes were the agent's, and does so at the next edit.
    }
  }
  return {
    ok: true,
    reverted: result.reverted,
    prevRev: result.prevRev,
    rev: result.rev,
    changed: result.changed,
    removed: result.removed,
    written,
    remaining: reviewChanges(result.review, result.doc).length,
    left: result.left,
  };
}
