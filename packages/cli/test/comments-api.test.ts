import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMENTS_FILE,
  type Comment,
  type CommentOp,
  type CommentsFile,
  commentsRevision,
  commentsToText,
  emptyComments,
} from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCommentsToFolder,
  commentTasks,
  listComments,
  readFolderComments,
  summarize,
} from "../src/comments-api.ts";
import { openDeck } from "../src/deck-api.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));
const NOW = "2026-11-01T10:00:00.000Z";

let root: string;
let deck: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-comments-api-"));
  deck = join(root, "deck");
  cpSync(demo, deck, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const comment = (id: string, over: Partial<Comment> = {}, last: "you" | "agent" = "you"): Comment => ({
  id,
  scene: "method",
  block: "method-diagram",
  anchor: { x: 0.5, y: 0.5 },
  thread: [{ author: last, text: `Words of ${id}.`, at: NOW }],
  resolved: false,
  ...over,
});
const fileOf = (...comments: Comment[]): CommentsFile => ({ ...emptyComments(), comments });
const write = (file: CommentsFile) => writeFileSync(join(deck, COMMENTS_FILE), commentsToText(file));
const onDisk = () => readFileSync(join(deck, COMMENTS_FILE), "utf8");
const doc = () => {
  const opened = openDeck(deck);
  if (!opened.ok) throw new Error("the demo deck should open");
  return opened.doc;
};
const add = (text = "Check this label."): CommentOp => ({
  op: "comment.add",
  scene: "method",
  block: "method-diagram",
  anchor: { x: 0.5, y: 0.5 },
  author: "you",
  text,
});
const rev = () => {
  const read = readFolderComments(deck);
  if (!read.ok) throw new Error("the comments should read");
  return commentsRevision(read.file);
};

describe("tasks", () => {
  it("are the open Ask-the-agent comments whose last word is the person's", () => {
    const file = fileOf(
      comment("c1", { ask: true }),
      comment("c2"),
      comment("c3", { ask: true, resolved: true }),
      comment("c4", { ask: true }, "agent"),
      comment("c5", { ask: false }),
    );
    expect(commentTasks(file).map((task) => task.id)).toEqual(["c1"]);
  });

  it("come back when the person writes again after the agent answered", () => {
    const answered = comment("c1", { ask: true }, "agent");
    expect(commentTasks(fileOf(answered))).toEqual([]);
    const again = {
      ...answered,
      thread: [...answered.thread, { author: "you" as const, text: "Not quite.", at: NOW }],
    };
    expect(commentTasks(fileOf(again)).map((task) => [task.id, task.text])).toEqual([["c1", "Not quite."]]);
  });

  it("name the scene and block, and carry the last message cut to 160 characters", () => {
    const long = comment("c1", {
      ask: true,
      thread: [{ author: "you", text: "x".repeat(400), at: NOW }],
    });
    const [task] = commentTasks(fileOf(long));
    expect(task).toMatchObject({ id: "c1", scene: "method", block: "method-diagram" });
    expect(task?.text).toHaveLength(160);
    expect(task?.text.endsWith("…")).toBe(true);
    const exact = comment("c2", { ask: true, thread: [{ author: "you", text: "y".repeat(160), at: NOW }] });
    expect(commentTasks(fileOf(exact))[0]?.text).toBe("y".repeat(160));
  });
});

describe("summarize and listComments", () => {
  const file = fileOf(
    comment("c1", { ask: true }),
    comment("c2", { resolved: true }),
    comment("c3", { block: "gone" }),
  );

  it("summarizes with the comments' own revision, the open count and the tasks", () => {
    const summary = summarize(file);
    expect(summary.rev).toBe(commentsRevision(file));
    expect(summary.open).toBe(2);
    expect(summary.tasks.map((task) => task.id)).toEqual(["c1"]);
  });

  it("lists the open comments by default and counts the resolved ones", () => {
    const list = listComments(file, doc());
    expect(list.comments.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(list.resolved).toBe(1);
    expect(list.open).toBe(2);
  });

  it("adds the resolved comments on request, still in file order", () => {
    expect(listComments(file, doc(), true).comments.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("marks a comment whose block is gone, and only that one", () => {
    const list = listComments(file, doc(), true);
    expect(list.comments.map((c) => (c as { orphaned?: true }).orphaned)).toEqual([
      undefined,
      undefined,
      true,
    ]);
  });
});

describe("readFolderComments", () => {
  it("reads a deck with no comments file as no comments", () => {
    const read = readFolderComments(deck);
    expect(read.ok && read.file.comments).toEqual([]);
  });

  it("warns about an orphaned comment and still reads it", () => {
    write(fileOf(comment("c1", { scene: "nowhere" })));
    const read = readFolderComments(deck);
    expect(read.ok && read.warnings.map((w) => w.code)).toEqual(["orphaned-comment"]);
  });

  it("refuses a comments file that is not valid, with its diagnostics", () => {
    writeFileSync(join(deck, COMMENTS_FILE), '{ "format": "depthcue-comments/1", "comments": 5 }');
    const read = readFolderComments(deck);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.code).toBe("unreadable-comments");
    expect(!read.ok && read.diagnostics.length).toBeGreaterThan(0);
  });

  it("refuses a deck that does not open, before looking at the comments", () => {
    writeFileSync(join(deck, "deck.json"), "{ not json");
    const read = readFolderComments(deck);
    expect(!read.ok && read.code).toBe("unreadable-deck");
  });
});

describe("applyCommentsToFolder", () => {
  it("adds a comment, writes the file and returns the new revision and what changed", () => {
    const before = rev();
    const outcome = applyCommentsToFolder(deck, [add()], before, () => NOW);
    expect(outcome).toMatchObject({ ok: true, prevRev: before, changed: ["c1"], removed: [], warnings: [] });
    expect(outcome.ok && outcome.rev).toBe(rev());
    expect(onDisk()).toContain("Check this label.");
  });

  it("never writes the deck", () => {
    const deckBefore = readFileSync(join(deck, "deck.json"), "utf8");
    const sceneBefore = readFileSync(join(deck, "scenes", "method.json"), "utf8");
    applyCommentsToFolder(deck, [add()], rev(), () => NOW);
    expect(readFileSync(join(deck, "deck.json"), "utf8")).toBe(deckBefore);
    expect(readFileSync(join(deck, "scenes", "method.json"), "utf8")).toBe(sceneBefore);
  });

  it("rejects a stale revision, names the current one in the hint and writes nothing", () => {
    applyCommentsToFolder(deck, [add()], rev(), () => NOW);
    const text = onDisk();
    const now = rev();
    const outcome = applyCommentsToFolder(deck, [add("Late.")], "0000000000000000", () => NOW);
    expect(outcome).toMatchObject({ ok: false, code: "stale-revision", rev: now });
    expect(!outcome.ok && outcome.hint).toContain(`base_rev "${now}"`);
    expect(onDisk()).toBe(text);
  });

  it("rejects a bad operation with its diagnostics and writes nothing", () => {
    const before = rev();
    const outcome = applyCommentsToFolder(deck, [{ op: "comment.resolve", id: "c9" }], before);
    expect(outcome).toMatchObject({ ok: false, code: "bad-op", rev: before });
    expect(!outcome.ok && outcome.hint).toContain("Nothing was applied");
    expect(!outcome.ok && outcome.diagnostics.length).toBeGreaterThan(0);
  });

  it("points a new comment at a block the deck has, or rejects it", () => {
    const outcome = applyCommentsToFolder(deck, [{ ...add(), block: "no-such-block" }], rev());
    expect(outcome).toMatchObject({ ok: false, code: "bad-op" });
  });

  it("leaves a comments file that is not valid exactly as it was", () => {
    const hand = '{ "format": "depthcue-comments/1", "comments": [ 1 ] }\n';
    writeFileSync(join(deck, COMMENTS_FILE), hand);
    const outcome = applyCommentsToFolder(deck, [add()], "x");
    expect(outcome).toMatchObject({ ok: false, code: "unreadable-comments" });
    expect(!outcome.ok && outcome.hint).toContain("not changed");
    expect(onDisk()).toBe(hand);
  });

  it("refuses a deck that does not open, and creates no comments file", () => {
    writeFileSync(join(deck, "deck.json"), "{ not json");
    const outcome = applyCommentsToFolder(deck, [add()], "x");
    expect(outcome).toMatchObject({ ok: false, code: "unreadable-deck" });
    expect(() => onDisk()).toThrow();
  });

  it("reports a file that changed while the edit was being applied, and keeps what is there", () => {
    const before = rev();
    let other = "";
    const outcome = applyCommentsToFolder(deck, [add()], before, () => {
      // The clock is read in the middle of the edit: here a person saves a comment of their own.
      write(fileOf(comment("c7")));
      other = onDisk();
      return NOW;
    });
    expect(outcome).toMatchObject({ ok: false, code: "changed-on-disk", rev: before });
    expect(!outcome.ok && outcome.hint).toContain("Nothing was written");
    expect(onDisk()).toBe(other);
  });

  it("warns, as the editor would, when a comment's block has since gone", () => {
    write(fileOf(comment("c1", { block: "gone" })));
    const outcome = applyCommentsToFolder(deck, [{ op: "comment.resolve", id: "c1" }], rev());
    expect(outcome.ok && outcome.warnings.map((w) => w.code)).toEqual(["orphaned-comment"]);
  });
});
