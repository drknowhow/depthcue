import { describe, expect, it } from "vitest";
import {
  applyCommentOps,
  applyOps,
  COMMENT_AUTHORS,
  COMMENT_LIMITS,
  COMMENT_OP_NAMES,
  COMMENTS_FILE,
  COMMENTS_FORMAT,
  type CommentOp,
  type CommentsFile,
  commentOpsSchema,
  commentsRevision,
  commentsSchema,
  commentsToText,
  commentWarnings,
  deckSchema,
  docToFiles,
  emptyComments,
  isOrphan,
  isTask,
  loadDoc,
  OP_NAMES,
  openComments,
  orphansOf,
  readComments,
  revisionOf,
  sceneSchema,
} from "../src/index.ts";
import { demoDir, demoDoc, loadDir } from "./helpers.ts";

const doc = demoDoc();
const NOW = "2026-11-01T10:00:00.000Z";
const LATER = "2026-11-01T10:05:00.000Z";
const at = { x: 0.25, y: 0.5 };

const add = (extra: Partial<Extract<CommentOp, { op: "comment.add" }>> = {}): CommentOp => ({
  op: "comment.add",
  scene: "method",
  block: "method-diagram",
  anchor: at,
  author: "you",
  text: "Is this the right diagram?",
  ...extra,
});

/** Applies operations to a file and returns the new file, failing the test if they were refused. */
function applied(file: CommentsFile, ops: CommentOp[], now = NOW): CommentsFile {
  const result = applyCommentOps(file, ops, commentsRevision(file), { doc, now: () => now });
  if (!result.ok) throw new Error(`the operations should apply: ${JSON.stringify(result.diagnostics)}`);
  return result.file;
}
const refused = (file: CommentsFile, ops: unknown, baseRev = commentsRevision(file)) => {
  const result = applyCommentOps(file, ops, baseRev, { doc, now: () => NOW });
  if (result.ok) throw new Error("the operations should be refused");
  return result;
};

const withOne = () => applied(emptyComments(), [add()]);

describe("an empty comments file", () => {
  it("has the format name and no comments, and is what a missing file reads as", () => {
    expect(emptyComments()).toEqual({ format: COMMENTS_FORMAT, comments: [] });
    expect(COMMENTS_FORMAT).toBe("depthcue-comments/1");
    expect(COMMENTS_FILE).toBe("comments.json");
    expect(readComments(undefined)).toEqual({ file: emptyComments(), diagnostics: [] });
  });
});

describe("adding a comment", () => {
  it("makes the first free id, and a thread of one message with the time it was written", () => {
    const file = applied(emptyComments(), [add()]);
    expect(file.comments).toEqual([
      {
        id: "c1",
        scene: "method",
        block: "method-diagram",
        anchor: at,
        thread: [{ author: "you", text: "Is this the right diagram?", at: NOW }],
        resolved: false,
      },
    ]);
    expect(applied(file, [add({ text: "Second" })]).comments.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("fills the first gap in the ids, so a deleted comment's id is used again", () => {
    let file = applied(emptyComments(), [add(), add(), add()]);
    file = applied(file, [{ op: "comment.delete", id: "c2" }]);
    expect(applied(file, [add()]).comments.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
  });

  it("takes an id that is given, and refuses one that is taken or is not an id", () => {
    const file = applied(emptyComments(), [add({ id: "check-label" })]);
    expect(file.comments[0]?.id).toBe("check-label");
    expect(refused(file, [add({ id: "check-label" })]).diagnostics[0]).toMatchObject({
      code: "duplicate-id",
      path: "/0/id",
    });
    expect(refused(file, [add({ id: "Not An Id" })]).diagnostics[0]).toMatchObject({ path: "/0/id" });
  });

  it("writes ask only when it is true, so an instruction to the agent is the only comment that has it", () => {
    const file = applied(emptyComments(), [add({ ask: true }), add({ ask: false }), add()]);
    expect(file.comments.map((c) => c.ask)).toEqual([true, undefined, undefined]);
    expect("ask" in (file.comments[1] as object)).toBe(false);
  });

  it("points at a block, or at the claim of a scene", () => {
    const file = applied(emptyComments(), [
      add({ scene: "opening", block: "opening-title" }),
      add({ scene: "demand", block: "claim-shift" }),
    ]);
    expect(file.comments.map((c) => c.block)).toEqual(["opening-title", "claim-shift"]);
    expect(orphansOf(file, doc)).toEqual([]);
  });

  it("refuses a scene or a block the deck does not have, and says which one it may have meant", () => {
    const noScene = refused(emptyComments(), [add({ scene: "metod" })]).diagnostics[0];
    expect(noScene).toMatchObject({ code: "unknown-scene", file: "ops", path: "/0/scene" });
    expect(noScene?.fix).toContain('Did you mean "method"?');
    const noBlock = refused(emptyComments(), [add({ block: "method-diagrm" })]).diagnostics[0];
    expect(noBlock).toMatchObject({ code: "unknown-block", path: "/0/block" });
    expect(noBlock?.fix).toContain('Did you mean "method-diagram"?');
    // A block that exists on another scene is not on this one.
    expect(refused(emptyComments(), [add({ block: "chart-demand" })]).diagnostics[0]?.code).toBe(
      "unknown-block",
    );
  });

  it("rounds the anchor to thousandths and keeps it inside the block", () => {
    const file = applied(emptyComments(), [add({ anchor: { x: 0.12345, y: 0.98765 } })]);
    expect(file.comments[0]?.anchor).toEqual({ x: 0.123, y: 0.988 });
    expect(applied(emptyComments(), [add({ anchor: { x: 0, y: 1 } })]).comments[0]?.anchor).toEqual({
      x: 0,
      y: 1,
    });
    for (const anchor of [
      { x: -0.1, y: 0.5 },
      { x: 0.5, y: 1.1 },
      { x: 0.5 },
      { x: "0.5", y: 0.5 },
      { x: 0.5, y: 0.5, z: 1 },
    ]) {
      expect(refused(emptyComments(), [add({ anchor } as never)]).code).toBe("bad-op");
    }
  });

  it("trims the text, and refuses a message with nothing in it", () => {
    expect(applied(emptyComments(), [add({ text: "  Move it left.\n" })]).comments[0]?.thread[0]?.text).toBe(
      "Move it left.",
    );
    expect(refused(emptyComments(), [add({ text: "   " })]).diagnostics[0]).toMatchObject({
      code: "empty-text",
      path: "/0/text",
    });
    expect(refused(emptyComments(), [add({ text: "" })]).code).toBe("bad-op");
    expect(refused(emptyComments(), [add({ text: "x".repeat(COMMENT_LIMITS.text + 1) })]).code).toBe(
      "bad-op",
    );
    expect(
      applied(emptyComments(), [add({ text: "x".repeat(COMMENT_LIMITS.text) })]).comments[0]?.thread[0]?.text,
    ).toHaveLength(COMMENT_LIMITS.text);
  });

  it("takes either author, and refuses any other", () => {
    expect([...COMMENT_AUTHORS]).toEqual(["you", "agent"]);
    const file = applied(emptyComments(), [add({ author: "agent" })]);
    expect(file.comments[0]?.thread[0]?.author).toBe("agent");
    expect(refused(emptyComments(), [add({ author: "someone" } as never)]).code).toBe("bad-op");
  });

  it("writes the time in a form its own schema accepts when no clock is given", () => {
    const result = applyCommentOps(emptyComments(), [add()], commentsRevision(emptyComments()), { doc });
    if (!result.ok) throw new Error("should apply");
    const written = result.file.comments[0]?.thread[0]?.at as string;
    expect(Number.isNaN(Date.parse(written))).toBe(false);
    expect(readComments(commentsToText(result.file)).file).not.toBeNull();
  });

  it("refuses a file of more comments than the limit, with nothing kept", () => {
    let file = emptyComments();
    for (let n = 0; n < COMMENT_LIMITS.comments / 100; n++) {
      file = applied(
        file,
        Array.from({ length: 100 }, () => add()),
      );
    }
    expect(file.comments).toHaveLength(COMMENT_LIMITS.comments);
    expect(refused(file, [add()]).code).toBe("invalid-comments");
  });
});

describe("replying", () => {
  it("adds a message to the thread, in order, with its own time", () => {
    const file = applied(
      withOne(),
      [{ op: "comment.reply", id: "c1", author: "agent", text: " Yes. " }],
      LATER,
    );
    expect(file.comments[0]?.thread).toEqual([
      { author: "you", text: "Is this the right diagram?", at: NOW },
      { author: "agent", text: "Yes.", at: LATER },
    ]);
  });

  it("names a comment that is not there, and a reply with no text", () => {
    expect(
      refused(withOne(), [{ op: "comment.reply", id: "c9", author: "you", text: "Hi" }]).diagnostics[0],
    ).toMatchObject({
      code: "unknown-comment",
      path: "/0/id",
    });
    expect(
      refused(withOne(), [{ op: "comment.reply", id: "c1", author: "you", text: "  " }]).diagnostics[0],
    ).toMatchObject({ code: "empty-text" });
  });

  it("does not reopen a resolved comment, and keeps it resolved", () => {
    let file = applied(withOne(), [{ op: "comment.resolve", id: "c1" }]);
    file = applied(file, [{ op: "comment.reply", id: "c1", author: "you", text: "Thanks." }]);
    expect(file.comments[0]).toMatchObject({ resolved: true });
    expect(file.comments[0]?.thread).toHaveLength(2);
  });

  it("stops at the limit of a thread", () => {
    let file = withOne();
    const reply: CommentOp = { op: "comment.reply", id: "c1", author: "you", text: "More." };
    file = applied(
      file,
      Array.from({ length: COMMENT_LIMITS.thread - 1 }, () => reply),
    );
    expect(file.comments[0]?.thread).toHaveLength(COMMENT_LIMITS.thread);
    expect(refused(file, [reply]).code).toBe("invalid-comments");
  });
});

describe("resolving, reopening and deleting", () => {
  it("resolves and reopens, and a comment already in that state is left alone", () => {
    const file = withOne();
    const resolved = applied(file, [{ op: "comment.resolve", id: "c1" }]);
    expect(resolved.comments[0]?.resolved).toBe(true);
    expect(commentsRevision(resolved)).not.toBe(commentsRevision(file));
    const again = applyCommentOps(
      resolved,
      [{ op: "comment.resolve", id: "c1" }],
      commentsRevision(resolved),
      {
        doc,
      },
    );
    if (!again.ok) throw new Error("should apply");
    expect(again.rev).toBe(commentsRevision(resolved));
    expect(again.changed).toEqual([]);
    const reopened = applied(resolved, [{ op: "comment.reopen", id: "c1" }]);
    expect(reopened).toEqual(file);
    const reopenedAgain = applyCommentOps(
      reopened,
      [{ op: "comment.reopen", id: "c1" }],
      commentsRevision(reopened),
      {
        doc,
      },
    );
    expect(reopenedAgain.ok && reopenedAgain.changed).toEqual([]);
  });

  it("deletes a comment with its whole thread, and names one that is not there", () => {
    const file = applied(withOne(), [add({ text: "Another" })]);
    const result = applyCommentOps(file, [{ op: "comment.delete", id: "c1" }], commentsRevision(file), {
      doc,
    });
    if (!result.ok) throw new Error("should apply");
    expect(result.file.comments.map((c) => c.id)).toEqual(["c2"]);
    expect(result.removed).toEqual(["c1"]);
    expect(refused(file, [{ op: "comment.delete", id: "c7" }]).diagnostics[0]?.code).toBe("unknown-comment");
    expect(refused(file, [{ op: "comment.resolve", id: "c7" }]).diagnostics[0]?.code).toBe("unknown-comment");
    expect(refused(file, [{ op: "comment.reopen", id: "c7" }]).diagnostics[0]?.code).toBe("unknown-comment");
  });

  it("lists what changed in the file's order, and the open comments for an agent to read", () => {
    const file = applied(emptyComments(), [add(), add(), add()]);
    const result = applyCommentOps(
      file,
      [
        { op: "comment.resolve", id: "c2" },
        { op: "comment.reply", id: "c3", author: "agent", text: "Done." },
      ],
      commentsRevision(file),
      { doc, now: () => LATER },
    );
    if (!result.ok) throw new Error("should apply");
    expect(result.changed).toEqual(["c2", "c3"]);
    expect(result.prevRev).toBe(commentsRevision(file));
    expect(result.rev).toBe(commentsRevision(result.file));
    expect(openComments(result.file).map((c) => c.id)).toEqual(["c1", "c3"]);
  });
});

describe("a task for the agent", () => {
  const asked = () => applied(emptyComments(), [add({ ask: true })]);
  const only = (file: CommentsFile) => file.comments[0] as CommentsFile["comments"][number];

  it("is an open comment marked ask that the person spoke last on", () => {
    expect(isTask(only(asked()))).toBe(true);
  });

  it("is not a comment that was not asked about", () => {
    expect(isTask(only(withOne()))).toBe(false);
  });

  it("stops being one when the agent answers, and is one again when the person writes after it", () => {
    const answered = applied(asked(), [{ op: "comment.reply", id: "c1", author: "agent", text: "Done." }]);
    expect(isTask(only(answered))).toBe(false);
    const again = applied(answered, [{ op: "comment.reply", id: "c1", author: "you", text: "Not quite." }]);
    expect(isTask(only(again))).toBe(true);
  });

  it("is not one once it is resolved, and is one again when it is reopened", () => {
    const resolved = applied(asked(), [{ op: "comment.resolve", id: "c1" }]);
    expect(isTask(only(resolved))).toBe(false);
    expect(isTask(only(applied(resolved, [{ op: "comment.reopen", id: "c1" }])))).toBe(true);
  });
});

describe("what is refused, and what is kept", () => {
  it("refuses a stale revision and says what the current one is", () => {
    const file = withOne();
    const result = refused(file, [{ op: "comment.resolve", id: "c1" }], "0123456789abcdef");
    expect(result).toMatchObject({ code: "stale-revision", rev: commentsRevision(file) });
    expect(result.diagnostics[0]?.message).toContain(commentsRevision(file));
  });

  it("holds the limits to the numbers that are written down", () => {
    expect(COMMENT_LIMITS).toEqual({ text: 2000, thread: 50, comments: 500 });
  });

  it("refuses more than 100 operations at once, and an add that names no anchor", () => {
    const file = withOne();
    const resolve: CommentOp = { op: "comment.resolve", id: "c1" };
    expect(
      applied(
        file,
        Array.from({ length: 100 }, () => resolve),
      ).comments[0]?.resolved,
    ).toBe(true);
    expect(
      refused(
        file,
        Array.from({ length: 101 }, () => resolve),
      ).code,
    ).toBe("bad-op");
    const { anchor: _anchor, ...unanchored } = add() as Extract<CommentOp, { op: "comment.add" }>;
    expect(refused(file, [unanchored]).diagnostics[0]).toMatchObject({
      code: "missing-property",
      path: "/0",
    });
  });

  it("refuses operations it does not know, with extra properties, or in an empty list", () => {
    const file = withOne();
    expect(refused(file, []).code).toBe("bad-op");
    expect(refused(file, [{ op: "comment.edit", id: "c1" }]).code).toBe("bad-op");
    expect(refused(file, [{ op: "comment.resolve", id: "c1", resolved: true }]).code).toBe("bad-op");
    expect(refused(file, [{ op: "comment.resolve" }]).diagnostics[0]).toMatchObject({
      code: "missing-property",
    });
    expect(refused(file, "resolve").code).toBe("bad-op");
  });

  it("applies all or none: a bad operation late in the list keeps nothing of the early ones", () => {
    const file = withOne();
    const result = refused(file, [
      { op: "comment.resolve", id: "c1" },
      { op: "comment.delete", id: "nope" },
    ]);
    expect(result.diagnostics[0]?.path).toBe("/1/id");
    // The file the caller holds is untouched: it was copied, not edited.
    expect(file.comments[0]?.resolved).toBe(false);
  });

  it("keeps the properties it does not know of, such as $schema, when it writes", () => {
    const file = { ...emptyComments(), $schema: "https://example.com/comments.schema.json" };
    expect(applied(file, [add()]).$schema).toBe("https://example.com/comments.schema.json");
  });
});

describe("a comment whose block is gone", () => {
  it("is kept, flagged as orphaned, and the rest are not", () => {
    const file = applied(emptyComments(), [add(), add({ scene: "opening", block: "opening-title" })]);
    const removed = applyOps(
      doc,
      [{ op: "block.remove", scene: "method", id: "method-diagram" }],
      revisionOf(doc),
    );
    if (!removed.ok) throw new Error("should apply");
    expect(orphansOf(file, removed.doc).map((c) => c.id)).toEqual(["c1"]);
    expect(isOrphan(file.comments[0] as never, removed.doc)).toBe(true);
    expect(isOrphan(file.comments[1] as never, removed.doc)).toBe(false);
    const warnings = commentWarnings(file, removed.doc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      severity: "warning",
      code: "orphaned-comment",
      file: COMMENTS_FILE,
      path: "/comments/0",
    });
    expect(warnings[0]?.message).toContain("method-diagram");
    // Nothing was dropped, and a comment on a scene that went is an orphan too.
    expect(file.comments).toHaveLength(2);
    const noScene = applyOps(doc, [{ op: "scene.remove", id: "opening" }], revisionOf(doc));
    if (!noScene.ok) throw new Error("should apply");
    expect(orphansOf(file, noScene.doc).map((c) => c.id)).toEqual(["c2"]);
    expect(commentWarnings(file, doc)).toEqual([]);
  });

  it("can still be replied to, resolved and deleted, so it can be tidied away", () => {
    const file = applied(emptyComments(), [add()]);
    const removed = applyOps(
      doc,
      [{ op: "block.remove", scene: "method", id: "method-diagram" }],
      revisionOf(doc),
    );
    if (!removed.ok) throw new Error("should apply");
    const result = applyCommentOps(
      file,
      [
        { op: "comment.reply", id: "c1", author: "you", text: "Gone now." },
        { op: "comment.resolve", id: "c1" },
      ],
      commentsRevision(file),
      { doc: removed.doc },
    );
    expect(result.ok).toBe(true);
    // A new comment on that block is refused, because it is not there to point at.
    expect(applyCommentOps(file, [add()], commentsRevision(file), { doc: removed.doc }).ok).toBe(false);
  });
});

describe("reading the file", () => {
  it("refuses text that is not JSON, in words", () => {
    const { file, diagnostics } = readComments("{ not json");
    expect(file).toBeNull();
    expect(diagnostics[0]).toMatchObject({ code: "json-parse", file: COMMENTS_FILE, severity: "error" });
  });

  it("refuses a file of another format, or with a comment the schema does not allow", () => {
    expect(readComments(JSON.stringify({ format: "other", comments: [] })).file).toBeNull();
    expect(readComments(JSON.stringify({ comments: [] })).diagnostics[0]).toMatchObject({
      code: "missing-property",
      file: COMMENTS_FILE,
    });
    const bad = { ...withOne(), comments: [{ ...withOne().comments[0], anchor: { x: 2, y: 0 } }] };
    const read = readComments(JSON.stringify(bad));
    expect(read.file).toBeNull();
    expect(read.diagnostics[0]?.path).toBe("/comments/0/anchor/x");
    const extra = { ...withOne(), comments: [{ ...withOne().comments[0], mood: "cross" }] };
    expect(readComments(JSON.stringify(extra)).file).toBeNull();
  });

  it("refuses a comment with no resolved flag, a time that is not a time, or too long a thread", () => {
    const [one] = withOne().comments;
    const refusedFile = (comment: object) =>
      readComments(JSON.stringify({ format: COMMENTS_FORMAT, comments: [comment] }));
    const { resolved: _resolved, ...unresolved } = one as NonNullable<typeof one>;
    expect(refusedFile(unresolved).file).toBeNull();
    expect(refusedFile(unresolved).diagnostics[0]).toMatchObject({ code: "missing-property" });
    const message = { author: "you", text: "Hi", at: "yesterday" };
    expect(refusedFile({ ...one, thread: [message] }).diagnostics[0]?.path).toBe("/comments/0/thread/0/at");
    const long = Array.from({ length: COMMENT_LIMITS.thread + 1 }, () => ({ ...message, at: NOW }));
    expect(refusedFile({ ...one, thread: long }).file).toBeNull();
    expect(refusedFile({ ...one, thread: [] }).file).toBeNull();
    expect(refusedFile({ ...one, thread: [{ ...message, at: NOW, text: "" }] }).file).toBeNull();
    expect(refusedFile({ ...one, anchor: { x: 0.5, y: 0.5, z: 1 } }).file).toBeNull();
    const crowd = Array.from({ length: COMMENT_LIMITS.comments + 1 }, (_, n) => ({
      ...one,
      id: `c${n + 1}`,
    }));
    expect(readComments(JSON.stringify({ format: COMMENTS_FORMAT, comments: crowd })).file).toBeNull();
  });

  it("refuses two comments with one id, and names both places", () => {
    const one = withOne().comments[0];
    const read = readComments(JSON.stringify({ format: COMMENTS_FORMAT, comments: [one, one] }));
    expect(read.file).toBeNull();
    expect(read.diagnostics[0]).toMatchObject({ code: "duplicate-id", path: "/comments/1/id" });
  });

  it("reads back what it wrote, and keeps a comment that points at nothing", () => {
    const file = applied(emptyComments(), [add({ ask: true })]);
    const read = readComments(commentsToText(file));
    expect(read).toEqual({ file, diagnostics: [] });
    const lost = { ...file, comments: file.comments.map((c) => ({ ...c, block: "vanished-block" })) };
    const kept = readComments(JSON.stringify(lost));
    expect(kept.file).toEqual(lost);
  });

  it("writes two-space JSON with a trailing newline", () => {
    const text = commentsToText(emptyComments());
    expect(text).toBe(`{\n  "format": "depthcue-comments/1",\n  "comments": []\n}\n`);
  });
});

describe("the revision of the comments", () => {
  it("is 16 hex characters of the content, the same however the file was written", () => {
    const file = withOne();
    expect(commentsRevision(file)).toMatch(/^[0-9a-f]{16}$/);
    const compact = readComments(JSON.stringify(file)).file as CommentsFile;
    const pretty = readComments(commentsToText(file)).file as CommentsFile;
    const reversed = (value: object) => Object.fromEntries(Object.entries(value).reverse());
    const shuffled = readComments(
      JSON.stringify(reversed({ ...file, comments: file.comments.map((c) => reversed(c)) })),
    ).file as CommentsFile;
    expect(commentsRevision(compact)).toBe(commentsRevision(file));
    expect(commentsRevision(pretty)).toBe(commentsRevision(file));
    expect(commentsRevision(shuffled)).toBe(commentsRevision(file));
    expect(commentsRevision(emptyComments())).not.toBe(commentsRevision(file));
  });

  it("changes with a reply, and with nothing else about the deck", () => {
    const file = withOne();
    const replied = applied(file, [{ op: "comment.reply", id: "c1", author: "you", text: "Hm." }]);
    expect(commentsRevision(replied)).not.toBe(commentsRevision(file));
  });
});

describe("comments and the deck stay apart", () => {
  it("leaves the deck's revision and its files as they were, whatever is done to the comments", () => {
    const before = revisionOf(doc);
    const files = docToFiles(doc);
    let file = applied(emptyComments(), [add(), add({ scene: "demand", block: "chart-demand", ask: true })]);
    file = applied(file, [
      { op: "comment.reply", id: "c1", author: "agent", text: "Looks right." },
      { op: "comment.resolve", id: "c2" },
      { op: "comment.delete", id: "c1" },
    ]);
    expect(revisionOf(doc)).toBe(before);
    expect(docToFiles(doc)).toEqual(files);
    expect(Object.keys(files)).not.toContain(COMMENTS_FILE);
  });

  it("is not read by loading the deck, even when the file is there and is not valid", () => {
    const folder = loadDir(demoDir);
    const clean = loadDoc(folder);
    const garbage = loadDoc({ ...folder, text: { ...folder.text, [COMMENTS_FILE]: "{ not json" } });
    const full = loadDoc({
      ...folder,
      text: { ...folder.text, [COMMENTS_FILE]: commentsToText(withOne()) },
    });
    if (!clean.doc || !garbage.doc || !full.doc) throw new Error("the deck should load");
    expect(garbage.diagnostics).toEqual(clean.diagnostics);
    expect(full.diagnostics).toEqual(clean.diagnostics);
    expect(revisionOf(garbage.doc)).toBe(revisionOf(clean.doc));
    expect(revisionOf(full.doc)).toBe(revisionOf(clean.doc));
  });

  it("has no comment property in the schema of the deck or of a scene", () => {
    const names: string[] = [];
    const walk = (node: unknown) => {
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "properties" && typeof value === "object" && value !== null) {
          names.push(...Object.keys(value));
        }
        walk(value);
      }
    };
    walk(deckSchema);
    walk(sceneSchema);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => /comment|thread|anchor|resolved/i.test(name))).toEqual([]);
    expect([...OP_NAMES].filter((name) => name.startsWith("comment"))).toEqual([]);
  });

  it("names every comment operation of the schema in one list, and every schema property it uses", () => {
    const names = commentOpsSchema.items.oneOf.map((entry) => entry.properties.op.const);
    expect(names).toEqual([...COMMENT_OP_NAMES]);
    expect(Object.keys(commentsSchema.properties).sort()).toEqual(["$schema", "comments", "format"]);
  });
});
