import { describe, expect, it } from "vitest";
import { createSession, type Op, type SessionEvent } from "../src/index.ts";
import { demoDoc } from "./helpers.ts";

const title = (text: string): Op => ({
  op: "block.set",
  scene: "opening",
  id: "opening-title",
  set: { text },
});
const headline = (session: ReturnType<typeof createSession>): string => {
  const block = session.doc.scenes.opening?.blocks[0];
  return block && "text" in block ? block.text : "";
};

describe("session history", () => {
  it("undoes and redoes, and a new edit clears the redo stack", () => {
    const session = createSession(demoDoc());
    const original = headline(session);
    session.apply([title("One")]);
    session.apply([title("Two")]);
    expect(session.undo()).toBe(true);
    expect(headline(session)).toBe("One");
    expect(session.undo()).toBe(true);
    expect(headline(session)).toBe(original);
    expect(session.undo()).toBe(false);
    expect(session.redo()).toBe(true);
    expect(headline(session)).toBe("One");
    session.apply([title("Three")]);
    expect(session.canRedo).toBe(false);
    expect(session.redo()).toBe(false);
  });

  it("tracks unsaved changes by content, so undoing back to the saved state is clean", () => {
    const session = createSession(demoDoc());
    expect(session.dirty).toBe(false);
    session.apply([title("One")]);
    expect(session.dirty).toBe(true);
    session.undo();
    expect(session.dirty).toBe(false);
    session.apply([title("One")]);
    session.markSaved();
    expect(session.dirty).toBe(false);
    expect(session.savedRev).toBe(session.rev);
    session.apply([title("Two")]);
    expect(session.dirty).toBe(true);
  });

  it("keeps a rejected or unchanged edit out of the history", () => {
    const session = createSession(demoDoc());
    const bad = session.apply([{ op: "scene.remove", id: "nope" }]);
    const same = session.apply([title(headline(session))]);
    expect(bad.ok).toBe(false);
    expect(same.ok).toBe(true);
    expect(session.canUndo).toBe(false);
  });

  it("checks an explicit baseRev and defaults to the current one", () => {
    const session = createSession(demoDoc());
    const read = session.rev;
    session.apply([title("Human edit")]);
    const stale = session.apply([title("Agent edit")], { baseRev: read });
    expect(stale.ok).toBe(false);
    expect(headline(session)).toBe("Human edit");
    expect(session.apply([title("Agent edit")], { baseRev: session.rev }).ok).toBe(true);
  });

  it("joins back-to-back edits that share a coalesce key into one undo step", () => {
    const session = createSession(demoDoc());
    const original = headline(session);
    session.apply([title("H")], { coalesce: "title" });
    session.apply([title("He")], { coalesce: "title" });
    session.apply([title("Hel")], { coalesce: "title" });
    session.undo();
    expect(headline(session)).toBe(original);

    session.apply([title("A")], { coalesce: "title" });
    session.apply([{ op: "scene.set", id: "opening", set: { notes: "n" } }]);
    session.apply([title("B")], { coalesce: "title" });
    session.undo();
    expect(headline(session)).toBe("A");
  });

  it("caps the history", () => {
    const session = createSession(demoDoc(), { historyLimit: 2 });
    for (const text of ["1", "2", "3", "4"]) session.apply([title(text)]);
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(false);
    expect(headline(session)).toBe("2");
  });

  it("resets to another document and can keep the saved baseline", () => {
    const session = createSession(demoDoc());
    session.apply([title("One")]);
    const edited = session.doc;
    const savedRev = session.savedRev;
    session.reset(demoDoc());
    expect(session.canUndo).toBe(false);
    expect(session.dirty).toBe(false);
    session.reset(edited, { dirty: true });
    expect(session.dirty).toBe(true);
    expect(session.savedRev).toBe(savedRev);
  });

  it("tells subscribers what happened until they unsubscribe", () => {
    const session = createSession(demoDoc());
    const seen: SessionEvent["type"][] = [];
    const stop = session.subscribe((event) => seen.push(event.type));
    session.apply([title("One")]);
    session.undo();
    session.redo();
    session.markSaved();
    session.reset(demoDoc());
    stop();
    session.apply([title("Two")]);
    expect(seen).toEqual(["apply", "undo", "redo", "saved", "reset"]);
  });
});
