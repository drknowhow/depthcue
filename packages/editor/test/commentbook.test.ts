import type { CommentOp } from "@depthcue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CommentBook, createCommentBook } from "../src/commentbook.ts";
import { FakeServer } from "./helpers.ts";

let server: FakeServer;
let book: CommentBook;

const add = (text: string, block = "method-body"): CommentOp => ({
  op: "comment.add",
  scene: "method",
  block,
  anchor: { x: 0.5, y: 0.5 },
  author: "you",
  text,
});

beforeEach(() => {
  server = new FakeServer();
  book = createCommentBook(server);
});

describe("reading", () => {
  it("is not ready until the first read has finished, and has no comments before it", () => {
    expect(book.state).toEqual({ comments: [], problem: undefined, ready: false });
  });

  it("shows what the file has, the resolved comments too, and tells the listeners", async () => {
    server.externalComment([add("one"), add("two")]);
    server.externalComment([{ op: "comment.resolve", id: "c1" }]);
    const heard = vi.fn();
    book.subscribe(heard);
    await book.sync();
    expect(book.state.ready).toBe(true);
    expect(book.state.comments.map((comment) => [comment.id, comment.resolved])).toEqual([
      ["c1", true],
      ["c2", false],
    ]);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("says why when the file cannot be read, shows nothing and writes nothing over it", async () => {
    server.commentsBroken = "comments.json is not valid JSON.";
    await book.sync();
    expect(book.state).toMatchObject({
      comments: [],
      problem: "comments.json is not valid JSON.",
      ready: true,
    });
    const result = await book.apply([add("hello")]);
    expect(result).toEqual({ ok: false, message: "comments.json is not valid JSON." });
    expect(server.commentSaves).toEqual([]);
  });

  it("recovers when the file is fixed and read again", async () => {
    server.commentsBroken = "comments.json is not valid JSON.";
    await book.sync();
    server.commentsBroken = undefined;
    server.externalComment([add("one")]);
    await book.sync();
    expect(book.state.problem).toBeUndefined();
    expect(book.state.comments).toHaveLength(1);
  });

  it("drops what it showed when the file stops being readable, rather than show comments that may be gone", async () => {
    server.externalComment([add("one")]);
    await book.sync();
    expect(book.state.comments).toHaveLength(1);
    server.commentsBroken = "comments.json is not valid JSON.";
    await book.sync();
    expect(book.state).toMatchObject({
      comments: [],
      problem: "comments.json is not valid JSON.",
      ready: true,
    });
    expect(await book.apply([add("two")])).toEqual({
      ok: false,
      message: "comments.json is not valid JSON.",
    });
    expect(server.commentSaves).toEqual([]);
  });

  it("does not stop listening to a listener that was removed", async () => {
    const heard = vi.fn();
    const stop = book.subscribe(heard);
    stop();
    await book.sync();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe("writing", () => {
  it("is refused before the first read, because there is no revision to write against", async () => {
    const result = await book.apply([add("too soon")]);
    expect(result.ok).toBe(false);
    expect(server.commentSaves).toEqual([]);
  });

  it("sends the operations against the revision it read, and answers with the ids the file did not have", async () => {
    await book.sync();
    const read = server.commentsRev;
    const result = await book.apply([add("first")]);
    expect(result).toEqual({ ok: true, added: ["c1"] });
    expect(server.commentSaves).toHaveLength(1);
    expect(server.commentSaves[0]?.baseRev).toBe(read);
    expect(book.state.comments.map((comment) => comment.id)).toEqual(["c1"]);
  });

  it("answers with no new ids for a reply, a resolve and a delete", async () => {
    server.externalComment([add("first")]);
    await book.sync();
    const reply = await book.apply([{ op: "comment.reply", id: "c1", author: "you", text: "more" }]);
    const resolve = await book.apply([{ op: "comment.resolve", id: "c1" }]);
    const gone = await book.apply([{ op: "comment.delete", id: "c1" }]);
    expect([reply, resolve, gone]).toEqual([
      { ok: true, added: [] },
      { ok: true, added: [] },
      { ok: true, added: [] },
    ]);
    expect(book.state.comments).toEqual([]);
  });

  it("tells the listeners once for a write", async () => {
    await book.sync();
    const heard = vi.fn();
    book.subscribe(heard);
    await book.apply([add("first")]);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("sends what is written one call after another, each on the revision the one before left", async () => {
    await book.sync();
    const [one, two] = await Promise.all([book.apply([add("one")]), book.apply([add("two")])]);
    expect(one).toEqual({ ok: true, added: ["c1"] });
    expect(two).toEqual({ ok: true, added: ["c2"] });
    expect(server.commentSaves).toHaveLength(2);
    expect(server.commentSaves[1]?.baseRev).not.toBe(server.commentSaves[0]?.baseRev);
    expect(server.commentLoads).toBe(1);
  });

  it("goes on with the next write after one is refused", async () => {
    await book.sync();
    const refused = await book.apply([{ op: "comment.resolve", id: "nothing" }]);
    expect(refused.ok).toBe(false);
    const next = await book.apply([add("still works")]);
    expect(next.ok).toBe(true);
  });
});

describe("a file that moved on", () => {
  it("is read again and the write is sent once more on top of it", async () => {
    await book.sync();
    server.externalComment([add("the agent was here first")]);
    const result = await book.apply([add("mine")]);
    expect(server.commentSaves).toHaveLength(2);
    expect(server.commentLoads).toBe(2);
    // Only the comment that was written now counts as new, so the thread that opens is the person's.
    expect(result).toEqual({ ok: true, added: ["c2"] });
    expect(server.comments.comments.map((comment) => comment.thread[0]?.text)).toEqual([
      "the agent was here first",
      "mine",
    ]);
    expect(book.state.comments).toHaveLength(2);
  });

  it("gives up with the reason when the second try is refused too", async () => {
    await book.sync();
    server.externalComment([add("first")]);
    // The second try asks to resolve a comment that is not there.
    const result = await book.apply([{ op: "comment.resolve", id: "c9" }]);
    expect(result.ok).toBe(false);
    expect(server.commentSaves).toHaveLength(2);
  });

  it("comes through a read of the file that fails in between by saying why", async () => {
    await book.sync();
    server.externalComment([add("first")]);
    server.commentsBroken = "comments.json is not valid JSON.";
    const result = await book.apply([add("mine")]);
    expect(result).toEqual({ ok: false, message: "comments.json is not valid JSON." });
    expect(server.commentSaves).toHaveLength(1);
  });
});

describe("a write refused", () => {
  it("answers with the message and reads the file again, so what is shown is what is there", async () => {
    await book.sync();
    server.nextCommentSave = { ok: false, kind: "rejected", message: "There is no comment c9." };
    const result = await book.apply([{ op: "comment.resolve", id: "c9" }]);
    expect(result).toEqual({ ok: false, message: "There is no comment c9." });
    await vi.waitFor(() => expect(server.commentLoads).toBe(2));
  });

  it("answers the same way for a server that could not be reached", async () => {
    await book.sync();
    server.nextCommentSave = { ok: false, kind: "failed", message: "The server could not be reached." };
    const result = await book.apply([add("lost")]);
    expect(result).toEqual({ ok: false, message: "The server could not be reached." });
  });
});

describe("a read that a write overtook", () => {
  it("is thrown away, so an old answer does not take back a comment just written", async () => {
    await book.sync();
    let release = () => {};
    server.commentGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // This read has the file as it is now, with no comment, and its answer is held.
    const slow = book.sync();
    server.commentGate = undefined;
    const written = await book.apply([add("while the read was out")]);
    expect(written.ok).toBe(true);
    release();
    await slow;
    expect(book.state.comments.map((comment) => comment.id)).toEqual(["c1"]);
  });
});

describe("putting the book away", () => {
  it("stops telling the listeners, and ignores a read that was still out", async () => {
    let release = () => {};
    server.commentGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heard = vi.fn();
    book.subscribe(heard);
    const pending = book.sync();
    book.dispose();
    release();
    await pending;
    expect(heard).not.toHaveBeenCalled();
    expect(book.state.ready).toBe(false);
  });
});
