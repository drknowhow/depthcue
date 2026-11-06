/**
 * Comments: notes that a person and an agent leave on a block of the deck. They live in `comments.json`, a file of
 * their own beside the deck, with a revision of their own. Nothing in this file is part of the deck: a comment does
 * not change the deck's revision, `loadDoc` never reads it, an export does not copy it and the player and the
 * presenter never ask for it. The format, the checks and the commands live here, once, for the editor, the CLI and an
 * agent alike.
 */
import type { FromSchema } from "json-schema-to-ts";
import { closest, explain } from "./diagnostics.ts";
import type { Doc } from "./doc.ts";
import { canonicalJson, sha256Hex } from "./revision.ts";
import { COMMENTS_FORMAT, commentOpsSchema, commentsSchema } from "./schema.ts";
import { schemaValidator } from "./schemacheck.ts";
import type { Diagnostic } from "./types.ts";

/** Where the comments of a deck are kept: next to `deck.json`, and not under `scenes/` or `assets/`. */
export const COMMENTS_FILE = "comments.json";
const validateComments = /* @__PURE__ */ schemaValidator(commentsSchema);
const validateCommentOps = /* @__PURE__ */ schemaValidator(commentOpsSchema);

export type CommentsFile = FromSchema<typeof commentsSchema>;
export type Comment = CommentsFile["comments"][number];
export type Message = Comment["thread"][number];
export type CommentAuthor = Message["author"];
export type Anchor = Comment["anchor"];

/**
 * `id` may be left out of an add, and the next free `c1`, `c2` is used. `ask` marks a comment as an instruction to
 * the agent; it is written only when true.
 */
export type CommentOp =
  | {
      op: "comment.add";
      id?: string;
      scene: string;
      block: string;
      anchor: Anchor;
      author: CommentAuthor;
      text: string;
      ask?: boolean;
    }
  | { op: "comment.reply"; id: string; author: CommentAuthor; text: string }
  | { op: "comment.resolve"; id: string }
  | { op: "comment.reopen"; id: string }
  | { op: "comment.delete"; id: string };

export type CommentFailureCode =
  /** `baseRev` is not the file's current revision. Read it again and redo the edit. */
  | "stale-revision"
  /** An operation is malformed or names something that does not exist. Nothing was applied. */
  | "bad-op"
  /** Every operation applied, but the result is not a valid comments file. Nothing was kept. */
  | "invalid-comments";

export interface CommentFailure {
  ok: false;
  code: CommentFailureCode;
  /** The file's current revision. */
  rev: string;
  diagnostics: Diagnostic[];
}

export interface CommentSuccess {
  ok: true;
  file: CommentsFile;
  rev: string;
  prevRev: string;
  /** Comments that are new or whose content differs from before, in file order. */
  changed: string[];
  removed: string[];
}

export type CommentResult = CommentSuccess | CommentFailure;

export interface CommentContext {
  /** The deck a comment points into: an added comment must name a scene and block that exist in it. */
  doc: Doc;
  /** The time written into a new message, as an ISO string. Defaults to the clock. */
  now?: () => string;
}

export type ReadComments =
  | { file: CommentsFile; diagnostics: Diagnostic[] }
  | { file: null; diagnostics: Diagnostic[] };

export const emptyComments = (): CommentsFile => ({ format: COMMENTS_FORMAT, comments: [] });

/** 16 hex characters of the file's content. Stored nowhere; equal content gives an equal revision, as for the deck. */
export const commentsRevision = (file: CommentsFile): string => sha256Hex(canonicalJson(file)).slice(0, 16);

/** The file as written to disk: two-space indent and a trailing newline. */
export const commentsToText = (file: CommentsFile): string => `${JSON.stringify(file, null, 2)}\n`;

/** The comments nobody has resolved, which is what an agent reads to see what is asked of it. */
export const openComments = (file: CommentsFile): Comment[] => file.comments.filter((c) => !c.resolved);

/**
 * A comment the agent has been asked to act on and has not answered: open, marked `ask`, and last spoken to by the
 * person. Once the agent replies, the ball is with the person and it stops being a task until they write again. The
 * editor, `deck_get` and `depthcue comments` all use this one rule.
 */
export const isTask = (comment: Comment): boolean =>
  !comment.resolved && comment.ask === true && comment.thread.at(-1)?.author === "you";

const problem = (index: number, path: string, code: string, message: string, fix?: string): Diagnostic => ({
  severity: "error",
  code,
  file: "ops",
  path: `/${index}${path}`,
  message,
  ...(fix === undefined ? {} : { fix }),
});

/**
 * Reads `comments.json` as text. A missing file is a deck with no comments. A file that is not valid, or that
 * gives two comments one id, is refused whole: nothing is guessed from a file that cannot be trusted. A comment
 * that points at a block the deck no longer has is valid and kept; `commentWarnings` flags it.
 */
export function readComments(text: string | undefined): ReadComments {
  if (text === undefined) return { file: emptyComments(), diagnostics: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      file: null,
      diagnostics: [
        {
          severity: "error",
          code: "json-parse",
          file: COMMENTS_FILE,
          path: "",
          message: `Not valid JSON: ${(error as Error).message}`,
          fix: "Fix the syntax; every key and string needs double quotes and no trailing commas.",
        },
      ],
    };
  }
  if (!validateComments(data)) {
    return { file: null, diagnostics: explain(validateComments.errors, data, commentsSchema, COMMENTS_FILE) };
  }
  const file = data as CommentsFile;
  const seen = new Set<string>();
  const duplicates: Diagnostic[] = [];
  for (const [index, comment] of file.comments.entries()) {
    if (seen.has(comment.id)) {
      duplicates.push({
        severity: "error",
        code: "duplicate-id",
        file: COMMENTS_FILE,
        path: `/comments/${index}/id`,
        message: `Two comments are called "${comment.id}".`,
        fix: "Give one of them another id.",
      });
    }
    seen.add(comment.id);
  }
  return duplicates.length > 0 ? { file: null, diagnostics: duplicates } : { file, diagnostics: [] };
}

/** The ids a comment may point at on a scene: its blocks and its claim. */
const targetsOf = (doc: Doc, sceneId: string): string[] | undefined => {
  const scene = doc.scenes[sceneId];
  if (scene === undefined) return undefined;
  return [...scene.blocks.map((block) => block.id), ...(scene.summary ? [scene.summary.id] : [])];
};

/** True when the deck no longer has the scene, or the block on it, that the comment points at. */
export function isOrphan(comment: Comment, doc: Doc): boolean {
  return !targetsOf(doc, comment.scene)?.includes(comment.block);
}

export const orphansOf = (file: CommentsFile, doc: Doc): Comment[] =>
  file.comments.filter((comment) => isOrphan(comment, doc));

/** One warning for each comment that points at something the deck no longer has. Such a comment is kept, not dropped. */
export function commentWarnings(file: CommentsFile, doc: Doc): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [index, comment] of file.comments.entries()) {
    if (!isOrphan(comment, doc)) continue;
    out.push({
      severity: "warning",
      code: "orphaned-comment",
      file: COMMENTS_FILE,
      path: `/comments/${index}`,
      message: `Comment "${comment.id}" points at block "${comment.block}" of scene "${comment.scene}", which is not in the deck.`,
      fix: "Resolve or delete it, or leave it as a record of what was there.",
    });
  }
  return out;
}

/** `c1`, `c2`: the first of these that no comment has. */
function nextCommentId(comments: readonly Comment[]): string {
  const taken = new Set(comments.map((comment) => comment.id));
  let n = 1;
  while (taken.has(`c${n}`)) n++;
  return `c${n}`;
}

/** Thousandths of the block are as fine as a person can point. */
const rounded = (value: number): number => Math.round(value * 1000) / 1000;

function roundedAnchor(anchor: Anchor): Anchor {
  const { x, y, w, h } = anchor;
  return {
    x: rounded(x),
    y: rounded(y),
    ...(w === undefined || h === undefined ? {} : { w: rounded(w), h: rounded(h) }),
  };
}

function unknown(index: number, path: string, what: string, id: string, ids: readonly string[]): Diagnostic {
  const guess = closest(id, ids);
  const list = ids.length > 0 ? `Existing ${what}s: ${ids.join(", ")}.` : `There are no ${what}s.`;
  return problem(
    index,
    path,
    `unknown-${what}`,
    `There is no ${what} "${id}".`,
    guess ? `Did you mean "${guess}"? ${list}` : list,
  );
}

/** The text of a message without the space around it, or a problem when nothing is left. */
function tidyText(index: number, text: string): string | Diagnostic {
  const tidy = text.trim();
  return tidy === ""
    ? problem(index, "/text", "empty-text", "A message needs some text.", "Write what you want to say.")
    : tidy;
}

function step(
  comments: Comment[],
  op: CommentOp,
  index: number,
  context: Required<CommentContext>,
): Diagnostic | undefined {
  const at = op.op === "comment.add" ? -1 : comments.findIndex((comment) => comment.id === op.id);
  if (op.op !== "comment.add" && at < 0) {
    return unknown(
      index,
      "/id",
      "comment",
      op.id,
      comments.map((comment) => comment.id),
    );
  }
  const found = comments[at] as Comment;
  switch (op.op) {
    case "comment.add": {
      const blocks = targetsOf(context.doc, op.scene);
      if (blocks === undefined) return unknown(index, "/scene", "scene", op.scene, context.doc.deck.scenes);
      if (!blocks.includes(op.block)) return unknown(index, "/block", "block", op.block, blocks);
      // The schema has already held `id` to the id pattern, so only a clash with another comment is left to check.
      if (op.id !== undefined && comments.some((comment) => comment.id === op.id)) {
        return problem(
          index,
          "/id",
          "duplicate-id",
          `Comment "${op.id}" already exists.`,
          "Pick another id.",
        );
      }
      const { x, y, w, h } = op.anchor;
      if ((w !== undefined && x + w > 1.0005) || (h !== undefined && y + h > 1.0005)) {
        return problem(
          index,
          "/anchor",
          "area-outside-block",
          "The area runs past the edge of the block.",
          "Keep x + w and y + h at 1 or less, since they are fractions of the block.",
        );
      }
      const text = tidyText(index, op.text);
      if (typeof text !== "string") return text;
      comments.push({
        id: op.id ?? nextCommentId(comments),
        scene: op.scene,
        block: op.block,
        anchor: roundedAnchor(op.anchor),
        thread: [{ author: op.author, text, at: context.now() }],
        resolved: false,
        ...(op.ask === true ? { ask: true } : {}),
      });
      return undefined;
    }
    case "comment.reply": {
      const text = tidyText(index, op.text);
      if (typeof text !== "string") return text;
      comments[at] = { ...found, thread: [...found.thread, { author: op.author, text, at: context.now() }] };
      return undefined;
    }
    case "comment.resolve":
    case "comment.reopen": {
      // A comment already in that state is left as it is, so asking twice does nothing the second time.
      const resolved = op.op === "comment.resolve";
      if (found.resolved !== resolved) comments[at] = { ...found, resolved };
      return undefined;
    }
    case "comment.delete":
      comments.splice(at, 1);
      return undefined;
  }
}

/**
 * Applies operations to the comments file, all or none, against the revision it was read at. An added comment must
 * point at a scene and block that the deck has now; a comment already in the file keeps its place if its block is
 * later removed. Replying to a resolved comment does not reopen it: say so with `comment.reopen`.
 */
export function applyCommentOps(
  file: CommentsFile,
  ops: unknown,
  baseRev: string,
  context: CommentContext,
): CommentResult {
  const prevRev = commentsRevision(file);
  const fail = (code: CommentFailureCode, diagnostics: Diagnostic[]): CommentFailure => ({
    ok: false,
    code,
    rev: prevRev,
    diagnostics,
  });
  if (baseRev !== prevRev) {
    return fail("stale-revision", [
      {
        severity: "error",
        code: "stale-revision",
        file: "ops",
        path: "",
        message: `The comments are at revision ${prevRev}, not ${baseRev}. They changed after you read them.`,
        fix: "Read the comments again, then redo the edit against the new revision.",
      },
    ]);
  }
  if (!validateCommentOps(ops)) {
    return fail("bad-op", explain(validateCommentOps.errors, ops, commentOpsSchema, "ops"));
  }

  const comments = [...file.comments];
  const run = { doc: context.doc, now: context.now ?? (() => new Date().toISOString()) };
  for (const [index, op] of (ops as CommentOp[]).entries()) {
    const bad = step(comments, op, index, run);
    if (bad) return fail("bad-op", [bad]);
  }

  const next: CommentsFile = { ...file, comments };
  if (!validateComments(next)) {
    return fail("invalid-comments", explain(validateComments.errors, next, commentsSchema, COMMENTS_FILE));
  }
  const before = new Map(file.comments.map((comment) => [comment.id, canonicalJson(comment)]));
  const kept = new Set(comments.map((comment) => comment.id));
  return {
    ok: true,
    file: next,
    rev: commentsRevision(next),
    prevRev,
    changed: comments.filter((comment) => before.get(comment.id) !== canonicalJson(comment)).map((c) => c.id),
    removed: file.comments.filter((comment) => !kept.has(comment.id)).map((comment) => comment.id),
  };
}
