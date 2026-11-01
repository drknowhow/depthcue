import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Diagnostic,
  type Doc,
  foldEdit,
  REVIEW_FILE,
  type ReadReview,
  type Review,
  readReview,
  recordAgentEdit,
  reviewRevision,
  reviewToText,
  revisionOf,
  startReview,
} from "@depthcue/core";
import { ChangedOnDiskError, writeAtomic } from "./save.ts";

/**
 * Reads `review.json` from the deck folder. No file is a deck nobody has started to review. This is the only place the
 * CLI opens it: `loadDeckDir` does not list it, the servers do not serve it and `export` does not copy it.
 */
export function loadReviewDir(dir: string): ReadReview {
  const path = join(dir, REVIEW_FILE);
  return readReview(existsSync(path) ? readFileSync(path, "utf8") : undefined);
}

/**
 * Writes the review next to the deck. Just before writing it reads the file again and refuses if it is no longer the
 * one that was `before` (or if there is one now and there was none), so two writers cannot silently overwrite each
 * other.
 */
export function saveReviewDir(dir: string, before: Review | undefined, after: Review): void {
  const onDisk = loadReviewDir(dir);
  const same =
    onDisk.ok &&
    (onDisk.review === undefined
      ? before === undefined
      : before !== undefined && reviewRevision(onDisk.review) === reviewRevision(before));
  if (!same) {
    throw new ChangedOnDiskError(
      "The review changed on disk while the edit was being applied. Read it again and retry.",
    );
  }
  writeAtomic(dir, REVIEW_FILE, reviewToText(after));
}

const notRecorded = (reason: string): Diagnostic => ({
  severity: "warning",
  code: "review-not-recorded",
  file: REVIEW_FILE,
  path: "",
  message: `The deck was changed, but the change could not be recorded for review: ${reason}`,
  fix: "The person can still see the change in the deck. Fix or delete review.json to record the next ones.",
});

/**
 * The agent wrote the deck, `before` to `after`: the changes it made are recorded as its own, and the first such write
 * starts the review from the deck as it was just before. It never fails the write, which has already happened; if the
 * review cannot be updated it says so as a warning.
 */
export function recordAgentWrite(dir: string, before: Doc, after: Doc): Diagnostic[] {
  if (revisionOf(before) === revisionOf(after)) return [];
  try {
    const read = loadReviewDir(dir);
    if (!read.ok)
      return [notRecorded(`review.json is not valid (${read.diagnostics[0]?.message ?? "unreadable"}).`)];
    saveReviewDir(dir, read.review, recordAgentEdit(read.review ?? startReview(before), before, after));
    return [];
  } catch (error) {
    return [notRecorded((error as Error).message)];
  }
}

/**
 * A person wrote the deck, `before` to `after`: what they changed is theirs, so it is folded into the reviewed deck
 * and never shows up as a change to review. Without a review there is nothing to fold into. A review that cannot be
 * updated is left alone: the person's save happened, and what it changed shows as made outside the agent's tools
 * until someone accepts it.
 */
export function recordPersonWrite(dir: string, before: Doc, after: Doc): void {
  if (revisionOf(before) === revisionOf(after)) return;
  try {
    const read = loadReviewDir(dir);
    if (!read.ok || read.review === undefined) return;
    const next = foldEdit(read.review, before, after);
    if (reviewRevision(next) !== reviewRevision(read.review)) saveReviewDir(dir, read.review, next);
  } catch {
    // The deck is saved; see above for what a late review looks like.
  }
}
