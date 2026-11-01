import { createSession, loadDoc, type Session } from "@depthcue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHistory, type History, type Step } from "../src/history.ts";
import { FakeServer, retitle } from "./helpers.ts";

let session: Session;
let history: History;
let log: string[];

beforeEach(() => {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo deck should load");
  session = createSession(doc);
  history = createHistory(session);
  log = [];
});

/** A step that leaves the deck alone, as accepting a change does. */
const answer = (name: string, problem?: string): Step => {
  const rev = session.rev;
  return {
    before: rev,
    after: rev,
    undo: () => {
      log.push(`undo ${name}`);
      return problem;
    },
    redo: () => {
      log.push(`redo ${name}`);
      return undefined;
    },
  };
};

const edit = (text: string) => session.apply([retitle(text)]);

describe("undo", () => {
  it("is the session's own while no step was taken", async () => {
    expect(history.canUndo).toBe(false);
    edit("One");
    expect(history.canUndo).toBe(true);
    await history.undo();
    expect(session.canUndo).toBe(false);
  });

  it("takes a step back when the deck is at the revision the step was taken at", async () => {
    history.push(answer("a"));
    expect(history.canUndo).toBe(true);
    expect(session.canUndo).toBe(false);
    expect(await history.undo()).toBeUndefined();
    expect(log).toEqual(["undo a"]);
    expect(history.canUndo).toBe(false);
  });

  it("takes back the edits made after a step first, then the step, then the edits before it", async () => {
    edit("Before");
    history.push(answer("a"));
    edit("After");
    await history.undo();
    expect(log).toEqual([]);
    await history.undo();
    expect(log).toEqual(["undo a"]);
    await history.undo();
    expect(session.canUndo).toBe(false);
  });

  it("says why a step could not be taken back, and forgets it, so the edits under it can be undone", async () => {
    edit("Before");
    history.push(answer("a", "The review changed."));
    expect(await history.undo()).toBe("The review changed.");
    expect(history.canRedo).toBe(false);
    expect(history.canUndo).toBe(true);
    await history.undo();
    expect(session.canUndo).toBe(false);
  });

  it("does nothing while a step is being taken back, so one press is not two", async () => {
    let finish = () => {};
    edit("Before"); // under the step, so a second press has something to take back by mistake
    const slow: Step = {
      before: session.rev,
      after: session.rev,
      undo: () =>
        new Promise<string | undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
      redo: () => undefined,
    };
    history.push(slow);
    edit("x"); // moves the deck on from the step; undo that first
    await history.undo();
    const running = history.undo();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(await history.undo()).toBeUndefined();
    expect(await history.redo()).toBeUndefined();
    expect(session.canUndo).toBe(true);
    expect(session.canRedo).toBe(true);
    finish();
    await running;
    expect(history.canUndo).toBe(true);
  });
});

describe("redo", () => {
  it("does a step again when the deck is back at the revision before it", async () => {
    history.push(answer("a"));
    await history.undo();
    expect(history.canRedo).toBe(true);
    await history.redo();
    expect(log).toEqual(["undo a", "redo a"]);
    expect(history.canUndo).toBe(true);
  });

  it("goes in the order things were done: the step, then the edit that followed it", async () => {
    history.push(answer("a"));
    edit("After");
    await history.undo();
    await history.undo();
    await history.redo();
    expect(log).toEqual(["undo a", "redo a"]);
    expect(history.canRedo).toBe(true);
    await history.redo();
    expect(session.canRedo).toBe(false);
  });

  it("leaves the edit that came before a step to be done first, and the step after it", async () => {
    edit("Before");
    history.push(answer("a"));
    await history.undo();
    await history.undo();
    await history.redo();
    expect(log).toEqual(["undo a"]);
    expect(session.canUndo).toBe(true);
    await history.redo();
    expect(log).toEqual(["undo a", "redo a"]);
  });

  it("is cleared by an edit, as it is for the session", async () => {
    history.push(answer("a"));
    await history.undo();
    edit("New");
    expect(history.canRedo).toBe(false);
  });

  it("is cleared by an edit even when Undo brings the deck back to the revision the step was undone at", async () => {
    history.push(answer("a"));
    await history.undo();
    edit("New");
    await history.undo();
    await history.redo();
    expect(log).toEqual(["undo a"]);
    expect(session.canRedo).toBe(false);
  });

  it("forgets a step it could not do again, so it is not offered a second time", async () => {
    const stuck: Step = { ...answer("a"), redo: () => "The review changed." };
    history.push(stuck);
    await history.undo();
    expect(await history.redo()).toBe("The review changed.");
    expect(history.canRedo).toBe(false);
    expect(history.canUndo).toBe(false);
  });

  it("is cleared by a step, which is a new thing done", async () => {
    history.push(answer("a"));
    await history.undo();
    history.push(answer("b"));
    expect(history.canRedo).toBe(false);
  });
});

describe("starting over", () => {
  it("forgets every step when the session loads other files", () => {
    history.push(answer("a"));
    session.reset(session.doc);
    expect(history.canUndo).toBe(false);
  });

  it("tells its listeners when a step is added or taken back, and stops when they let go", async () => {
    const heard = vi.fn();
    const stop = history.subscribe(heard);
    history.push(answer("a"));
    expect(heard).toHaveBeenCalledTimes(1);
    await history.undo();
    expect(heard.mock.calls.length).toBeGreaterThan(1);
    stop();
    const calls = heard.mock.calls.length;
    history.push(answer("b"));
    expect(heard).toHaveBeenCalledTimes(calls);
  });

  it("stops listening to the session when it is disposed", () => {
    history.push(answer("a"));
    history.dispose();
    session.reset(session.doc);
    expect(history.canUndo).toBe(true);
  });
});
