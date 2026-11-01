import {
  type Comment,
  type CommentsFile,
  commentsRevision,
  commentWarnings,
  type Diagnostic,
  type Doc,
  isOrphan,
  isTask,
  openComments,
} from "@depthcue/core";
import { applyCommentsDir, loadCommentsDir } from "./comments-file.ts";
import { openDeck } from "./deck-api.ts";
import { ChangedOnDiskError } from "./save.ts";

/** The first words of a message, so a list of tasks stays short. The whole thread is one call away. */
const EXCERPT = 160;
const excerpt = (text: string): string => (text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text);

/** What a person asked of the agent: an open "Ask the agent" comment whose last word is the person's. */
export interface CommentTask {
  id: string;
  scene: string;
  block: string;
  text: string;
}

export interface CommentSummary {
  /** The comments' own revision, to name as the base of the next change. It is not the deck's. */
  rev: string;
  open: number;
  tasks: CommentTask[];
}

/**
 * A comment the agent has not yet answered. Once the agent replies, the ball is with the person, so the comment stops
 * being a task until they write again.
 */
export function commentTasks(file: CommentsFile): CommentTask[] {
  return file.comments.filter(isTask).map((comment) => ({
    id: comment.id,
    scene: comment.scene,
    block: comment.block,
    text: excerpt(comment.thread.at(-1)?.text ?? ""),
  }));
}

export const summarize = (file: CommentsFile): CommentSummary => ({
  rev: commentsRevision(file),
  open: openComments(file).length,
  tasks: commentTasks(file),
});

export type CommentList = CommentSummary & {
  resolved: number;
  comments: Array<Comment & { orphaned?: true }>;
};

/** The comments to show: the open ones, or every one. A comment whose block is gone says so. */
export function listComments(file: CommentsFile, doc: Doc, includeResolved = false): CommentList {
  const shown = includeResolved ? file.comments : openComments(file);
  const summary = summarize(file);
  return {
    ...summary,
    resolved: file.comments.length - summary.open,
    comments: shown.map((comment) =>
      isOrphan(comment, doc) ? { ...comment, orphaned: true as const } : comment,
    ),
  };
}

export type CommentsRead =
  | { ok: true; doc: Doc; file: CommentsFile; warnings: Diagnostic[] }
  | { ok: false; code: "unreadable-deck" | "unreadable-comments"; diagnostics: Diagnostic[] };

/**
 * Reads the comments beside a deck that is already open. The deck is needed to tell which comments are orphaned. A
 * comments file that is not valid is reported and never replaced, because it may hold a hand edit.
 */
export function readCommentsFor(folder: string, doc: Doc): CommentsRead {
  const read = loadCommentsDir(folder);
  if (read.file === null) return { ok: false, code: "unreadable-comments", diagnostics: read.diagnostics };
  return { ok: true, doc, file: read.file, warnings: commentWarnings(read.file, doc) };
}

/** Reads a folder's deck and comments together. */
export function readFolderComments(folder: string): CommentsRead {
  const opened = openDeck(folder);
  if (!opened.ok) return { ok: false, code: "unreadable-deck", diagnostics: opened.diagnostics };
  return readCommentsFor(folder, opened.doc);
}

export type CommentsOutcome =
  | {
      ok: true;
      prevRev: string;
      rev: string;
      changed: string[];
      removed: string[];
      warnings: Diagnostic[];
    }
  | {
      ok: false;
      code:
        | "unreadable-deck"
        | "unreadable-comments"
        | "stale-revision"
        | "bad-op"
        | "invalid-comments"
        | "changed-on-disk";
      /** The comments' current revision, when they could be read. */
      rev?: string;
      diagnostics: Diagnostic[];
      /** What to do next, in words an agent can act on. */
      hint: string;
    };

const HINTS = {
  "unreadable-deck":
    "The deck folder has errors that must be fixed by hand first. Run `depthcue check` on it.",
  "unreadable-comments":
    "comments.json is not valid, so it was not changed. Fix the file by hand, or ask the person to.",
  "bad-op":
    "Nothing was applied. Fix the operations named in the diagnostics and send them again with the same base_rev.",
  "invalid-comments":
    "Every operation applied, but the result is not a valid comments file, so nothing was kept. Fix what the diagnostics name and send the operations again with the same base_rev.",
  "changed-on-disk":
    "The comments changed while the edit was being applied. Nothing was written. Read them again, then redo the edit with the new revision.",
} as const;

/**
 * Applies comment operations to the comments beside a deck folder, all or none, against the revision they were read
 * at. The deck is read to check that a new comment points at a block it has, and is never written.
 */
export function applyCommentsToFolder(
  folder: string,
  ops: unknown,
  baseRev: string,
  now?: () => string,
): CommentsOutcome {
  const read = readFolderComments(folder);
  if (!read.ok) return { ...read, hint: HINTS[read.code] };
  try {
    const result = applyCommentsDir(folder, ops, baseRev, read.doc, now);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        rev: result.rev,
        diagnostics: result.diagnostics,
        hint:
          result.code === "stale-revision"
            ? `The comments are now at revision ${result.rev}, not ${baseRev}. Nothing was applied. Read them, then redo the edit with base_rev "${result.rev}".`
            : HINTS[result.code],
      };
    }
    return {
      ok: true,
      prevRev: result.prevRev,
      rev: result.rev,
      changed: result.changed,
      removed: result.removed,
      warnings: commentWarnings(result.file, read.doc),
    };
  } catch (error) {
    if (!(error instanceof ChangedOnDiskError)) throw error;
    return {
      ok: false,
      code: "changed-on-disk",
      rev: commentsRevision(read.file),
      diagnostics: [],
      hint: HINTS["changed-on-disk"],
    };
  }
}
