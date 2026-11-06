import { describe, expect, it } from "vitest";
import {
  AUDIT_WRITE_MAX,
  type AuditEntry,
  auditLine,
  type CommentOp,
  type CommentsFile,
  commentDrafts,
  emptyComments,
  filterAudit,
  readAudit,
  reviewDrafts,
} from "../src/index.ts";

const entry = (id: string, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  time: "2026-11-05T10:00:00.000Z",
  by: "agent",
  kind: "edit",
  summary: `change ${id}`,
  ...over,
});

const file = (...ids: { id: string; resolved?: boolean }[]): CommentsFile => ({
  ...emptyComments(),
  comments: ids.map(({ id, resolved }) => ({
    id,
    scene: "method",
    block: "diagram",
    anchor: { x: 0.5, y: 0.5 },
    thread: [{ author: "you" as const, text: "hi", at: "2026-11-05T10:00:00.000Z" }],
    resolved: resolved === true,
  })),
});

const add = (over: Partial<Extract<CommentOp, { op: "comment.add" }>> = {}): CommentOp => ({
  op: "comment.add",
  scene: "method",
  block: "diagram",
  anchor: { x: 0.5, y: 0.5 },
  author: "you",
  text: "Check this label.",
  ...over,
});

describe("readAudit", () => {
  it("skips lines that are not entries and keeps the rest", () => {
    const text = `${auditLine(entry("a"))}not json\n{"id":"x"}\n\n${auditLine(entry("b"))}`;
    const read = readAudit(text);
    expect(read.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(read.skipped).toBe(2);
  });

  it("reads no file as an empty log", () => {
    expect(readAudit(undefined)).toEqual({ entries: [], skipped: 0 });
  });
});

describe("filterAudit", () => {
  const all = [
    entry("1", { scene: "a" }),
    entry("2", { scene: "b", by: "you" }),
    entry("3", { scene: "a", kind: "comment" }),
    entry("4", { scene: "a", by: "you" }),
  ];

  it("keeps one slide's entries", () => {
    expect(filterAudit(all, { scene: "a" }).map((e) => e.id)).toEqual(["1", "3", "4"]);
  });

  it("combines slide, author and kind", () => {
    expect(filterAudit(all, { scene: "a", by: "you" }).map((e) => e.id)).toEqual(["4"]);
    expect(filterAudit(all, { kind: "comment" }).map((e) => e.id)).toEqual(["3"]);
  });

  it("returns what came after an entry id, and everything for an id it does not have", () => {
    expect(filterAudit(all, { since: "2" }).map((e) => e.id)).toEqual(["3", "4"]);
    expect(filterAudit(all, { since: "gone" })).toHaveLength(4);
  });

  it("limits to the latest entries after filtering", () => {
    expect(filterAudit(all, { scene: "a", limit: 2 }).map((e) => e.id)).toEqual(["3", "4"]);
  });
});

describe("commentDrafts", () => {
  it("signs an added comment with its author and finds the id given to it", () => {
    const drafts = commentDrafts([add({ ask: true })], emptyComments(), file({ id: "c1" }), "agent");
    expect(drafts).toEqual([
      {
        by: "you",
        kind: "comment",
        summary: 'Asked the agent on block "diagram": Check this label.',
        scene: "method",
        block: "diagram",
        comment: "c1",
      },
    ]);
  });

  it("says when a comment marks an area of the block", () => {
    const area = add({ anchor: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 } });
    const [draft] = commentDrafts([area], emptyComments(), file({ id: "c1" }), "agent");
    expect(draft?.summary).toBe('Commented on an area of block "diagram": Check this label.');
  });

  it("signs resolve, reopen and delete with the one who sent them and finds the block", () => {
    const before = file({ id: "c1" }, { id: "c2", resolved: true }, { id: "c3" });
    const after = file({ id: "c1", resolved: true }, { id: "c2" });
    const drafts = commentDrafts(
      [
        { op: "comment.resolve", id: "c1" },
        { op: "comment.reopen", id: "c2" },
        { op: "comment.delete", id: "c3" },
      ],
      before,
      after,
      "you",
    );
    expect(drafts.map((d) => [d.kind, d.by, d.comment, d.block])).toEqual([
      ["resolve", "you", "c1", "diagram"],
      ["reopen", "you", "c2", "diagram"],
      ["delete", "you", "c3", "diagram"],
    ]);
  });

  it("leaves out an operation that changed nothing", () => {
    const state = file({ id: "c1", resolved: true });
    expect(commentDrafts([{ op: "comment.resolve", id: "c1" }], state, state, "agent")).toEqual([]);
  });

  it("records a reply under the author it names", () => {
    const state = file({ id: "c1" });
    const [reply] = commentDrafts(
      [{ op: "comment.reply", id: "c1", author: "agent", text: "Fixed the label." }],
      state,
      state,
      "you",
    );
    expect(reply).toMatchObject({ by: "agent", kind: "reply", comment: "c1", scene: "method" });
  });
});

describe("reviewDrafts", () => {
  it("keeps a large write to the limit and counts the rest", () => {
    const changes = Array.from({ length: AUDIT_WRITE_MAX + 20 }, (_, i) => ({
      id: `scene:s${i}/title`,
      scope: "scene" as const,
      kind: "changed" as const,
      scene: `s${i}`,
      field: "title",
    }));
    const drafts = reviewDrafts("accept", changes);
    expect(drafts).toHaveLength(AUDIT_WRITE_MAX);
    expect(drafts.at(-1)?.summary).toBe("and 21 more changes");
  });
});
