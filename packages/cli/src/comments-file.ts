import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyCommentOps,
  COMMENTS_FILE,
  type CommentResult,
  type CommentsFile,
  commentsRevision,
  commentsToText,
  type Doc,
  type ReadComments,
  readComments,
} from "@depthcue/core";
import { ChangedOnDiskError, writeAtomic } from "./save.ts";

/**
 * Reads `comments.json` from the deck folder. No file is a deck without comments. This is the only place the CLI
 * opens it: `loadDeckDir` does not list it, the servers do not serve it and `export` does not copy it.
 */
export function loadCommentsDir(dir: string): ReadComments {
  const path = join(dir, COMMENTS_FILE);
  return readComments(existsSync(path) ? readFileSync(path, "utf8") : undefined);
}

/**
 * Applies comment operations and, when they change the file, writes it. The file on disk is read fresh and its
 * revision must be `baseRev`; a file that is not valid is refused rather than overwritten, so a hand edit is never
 * lost to a repair nobody asked for. Operations that change nothing, such as resolving a resolved comment, leave
 * the file untouched.
 */
export function applyCommentsDir(
  dir: string,
  ops: unknown,
  baseRev: string,
  doc: Doc,
  now?: () => string,
): CommentResult {
  const read = loadCommentsDir(dir);
  if (read.file === null) {
    return {
      ok: false,
      code: "invalid-comments",
      rev: "",
      diagnostics: read.diagnostics,
    };
  }
  const result = applyCommentOps(read.file, ops, baseRev, { doc, ...(now ? { now } : {}) });
  if (result.ok && result.rev !== result.prevRev) saveCommentsDir(dir, read.file, result.file);
  return result;
}

/**
 * Writes the comments next to the deck. Just before writing it reads the file again and refuses if it is no longer
 * the one that was `before`, so two writers cannot silently overwrite each other.
 */
export function saveCommentsDir(dir: string, before: CommentsFile, after: CommentsFile): void {
  const onDisk = loadCommentsDir(dir).file;
  if (onDisk === null || commentsRevision(onDisk) !== commentsRevision(before)) {
    throw new ChangedOnDiskError(
      "The comments changed on disk while the edit was being applied. Read them again and retry.",
    );
  }
  writeAtomic(dir, COMMENTS_FILE, commentsToText(after));
}
