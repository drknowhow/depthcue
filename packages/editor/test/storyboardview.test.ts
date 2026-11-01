import { createSession, type Doc, loadDoc, type Op } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import type { Problem } from "../src/ribbon.ts";
import {
  type Card,
  cardsOf,
  checksByScene,
  pillsOf,
  type Step,
  sayCard,
  stepOfKey,
  stepTo,
} from "../src/storyboardview.ts";
import { FakeServer } from "./helpers.ts";

/** The demo deck: opening, demand, method, in that order. */
const demo = (...ops: Op[]): Doc => {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo deck should load");
  if (ops.length === 0) return doc;
  const session = createSession(doc);
  const result = session.apply(ops);
  if (!result.ok) throw new Error("the change should apply");
  return session.doc;
};

const card = (over: Partial<Card> = {}): Card => ({
  id: "method",
  number: 2,
  title: "Method",
  lead: "human",
  changed: 0,
  toCheck: 0,
  comments: 0,
  tasks: 0,
  pinned: 0,
  ...over,
});

describe("cardsOf", () => {
  it("is one card for each scene, in the deck's order, numbered from 1", () => {
    const cards = cardsOf(demo());
    expect(cards.map((c) => [c.number, c.id])).toEqual([
      [1, "opening"],
      [2, "demand"],
      [3, "method"],
    ]);
    expect(cards.map((c) => c.title)).toEqual(
      ["opening", "demand", "method"].map((id) => demo().scenes[id]?.title),
    );
  });

  it("follows the order the deck gives, not the order scenes were added", () => {
    const doc = demo({ op: "scene.move", id: "method", after: null });
    expect(cardsOf(doc).map((c) => c.id)).toEqual(["method", "opening", "demand"]);
    expect(cardsOf(doc).map((c) => c.number)).toEqual([1, 2, 3]);
  });

  it("leaves out an id the deck lists that has no scene", () => {
    const doc = demo();
    const broken: Doc = { ...doc, deck: { ...doc.deck, scenes: ["opening", "ghost", "method"] } };
    expect(cardsOf(broken).map((c) => c.id)).toEqual(["opening", "method"]);
  });

  it("gives a scene with no lead to the person, and keeps the lead it has", () => {
    const doc = demo(
      { op: "scene.set", id: "method", set: { lead: "agent" } },
      { op: "scene.set", id: "demand", set: { lead: null } },
    );
    const leads = Object.fromEntries(cardsOf(doc).map((c) => [c.id, c.lead]));
    expect(doc.scenes.demand?.lead).toBeUndefined();
    expect(leads.method).toBe("agent");
    expect(leads.demand).toBe("human");
  });

  it("counts the pinned blocks of each scene, and not the ones left to the layout", () => {
    const doc = demo(
      { op: "block.frame", scene: "method", id: "method-body", frame: { x: 10, y: 10, w: 30, h: 20 } },
      { op: "block.frame", scene: "method", id: "method-diagram", frame: { x: 50, y: 10, w: 30, h: 20 } },
    );
    const pinned = Object.fromEntries(cardsOf(doc).map((c) => [c.id, c.pinned]));
    expect(pinned).toEqual({ opening: 0, method: 2, demand: 0 });
  });

  it("reads each mark from its own map, and leaves a scene a map does not name at none", () => {
    const cards = cardsOf(demo(), {
      comments: new Map([["method", { open: 3, tasks: 1, resolved: 4 }]]),
      changed: new Map([["opening", 2]]),
      checks: new Map([["demand", 5]]),
    });
    const by = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(by.method).toMatchObject({ comments: 3, tasks: 1, changed: 0, toCheck: 0 });
    expect(by.opening).toMatchObject({ changed: 2, comments: 0, tasks: 0, toCheck: 0 });
    expect(by.demand).toMatchObject({ toCheck: 5, changed: 0, comments: 0 });
  });

  it("does not count resolved comments, which are done with", () => {
    const [first] = cardsOf(demo(), { comments: new Map([["opening", { open: 0, tasks: 0, resolved: 6 }]]) });
    expect(first?.comments).toBe(0);
  });
});

describe("checksByScene", () => {
  const problem = (scene: string, key: string): Problem => ({
    key,
    scene,
    block: undefined,
    text: key,
    fix: undefined,
  });

  it("counts the problems of each scene", () => {
    const counts = checksByScene([problem("a", "1"), problem("b", "2"), problem("a", "3")]);
    expect([...counts]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });

  it("is empty when there is nothing to check", () => {
    expect(checksByScene([]).size).toBe(0);
  });
});

describe("pillsOf", () => {
  it("is only the lead for a scene with nothing waiting on it", () => {
    expect(pillsOf(card())).toEqual([{ kind: "lead", text: "Human", lead: "human" }]);
  });

  it("names each lead as the strip does", () => {
    expect(pillsOf(card({ lead: "agent" }))[0]).toEqual({ kind: "lead", text: "Agent", lead: "agent" });
    expect(pillsOf(card({ lead: "shared" }))[0]).toEqual({ kind: "lead", text: "Shared", lead: "shared" });
  });

  it("shows what is waiting in a fixed order: changes, things to check, comments, pins", () => {
    const pills = pillsOf(card({ changed: 2, toCheck: 3, comments: 4, pinned: 5 }));
    expect(pills.map((pill) => [pill.kind, pill.text])).toEqual([
      ["lead", "Human"],
      ["changed", "2 changed"],
      ["check", "3 to check"],
      ["comments", "4 comments"],
      ["pinned", "5 pinned"],
    ]);
  });

  it("leaves a pill out when its count is zero", () => {
    const kinds = (over: Partial<Card>) => pillsOf(card(over)).map((pill) => pill.kind);
    expect(kinds({ changed: 1 })).toEqual(["lead", "changed"]);
    expect(kinds({ toCheck: 1 })).toEqual(["lead", "check"]);
    expect(kinds({ comments: 1 })).toEqual(["lead", "comments"]);
    expect(kinds({ pinned: 1 })).toEqual(["lead", "pinned"]);
  });

  it("says one comment and many comments", () => {
    expect(pillsOf(card({ comments: 1 }))[1]?.text).toBe("1 comment");
    expect(pillsOf(card({ comments: 2 }))[1]?.text).toBe("2 comments");
  });

  it("marks the comments pill when the agent is being waited on, and only then", () => {
    expect(pillsOf(card({ comments: 2, tasks: 1 }))[1]?.tasks).toBe(true);
    expect(pillsOf(card({ comments: 2 }))[1]).not.toHaveProperty("tasks");
  });
});

describe("sayCard", () => {
  it("names the scene and its lead", () => {
    expect(sayCard(card())).toBe("Scene 2, Method. Lead: Human.");
  });

  it("says each count in words, singular or plural", () => {
    expect(sayCard(card({ lead: "agent", changed: 1, toCheck: 1, comments: 1, pinned: 1 }))).toBe(
      "Scene 2, Method. Lead: Agent. 1 change to review. 1 thing to check. 1 open comment. 1 pinned block.",
    );
    expect(sayCard(card({ changed: 2, toCheck: 2, comments: 2, pinned: 2 }))).toBe(
      "Scene 2, Method. Lead: Human. 2 changes to review. 2 things to check. 2 open comments. 2 pinned blocks.",
    );
  });

  it("says how many comments wait for the agent", () => {
    expect(sayCard(card({ comments: 3, tasks: 2 }))).toBe(
      "Scene 2, Method. Lead: Human. 3 open comments, 2 waiting for the agent.",
    );
  });
});

describe("stepOfKey", () => {
  it("is a step for the arrows, Home and End, and none for any other key", () => {
    expect(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].map(stepOfKey)).toEqual([
      "left",
      "right",
      "up",
      "down",
      "first",
      "last",
    ]);
    for (const key of ["Enter", " ", "Tab", "a", "PageDown", "Escape"])
      expect(stepOfKey(key)).toBeUndefined();
  });

  it("does not take a name from Object.prototype for a key", () => {
    expect(stepOfKey("constructor")).toBeUndefined();
    expect(stepOfKey("toString")).toBeUndefined();
  });
});

describe("stepTo", () => {
  // Seven cards in rows of three:  0 1 2 / 3 4 5 / 6
  const go = (step: Step, at: number, columns = 3, count = 7) => stepTo(step, at, count, columns);

  it("goes card to card for left and right, over the end of a row onto the next", () => {
    expect(go("right", 1)).toBe(2);
    expect(go("right", 2)).toBe(3);
    expect(go("left", 3)).toBe(2);
    expect(go("left", 1)).toBe(0);
  });

  it("stops at the first and the last card instead of wrapping round", () => {
    expect(go("left", 0)).toBe(0);
    expect(go("right", 6)).toBe(6);
  });

  it("keeps the column for up and down", () => {
    expect(go("down", 1)).toBe(4);
    expect(go("down", 3)).toBe(6);
    expect(go("up", 4)).toBe(1);
    expect(go("up", 6)).toBe(3);
  });

  it("stops going up from the first row, and going down from the last", () => {
    expect(go("up", 0)).toBe(0);
    expect(go("up", 2)).toBe(2);
    expect(go("down", 6)).toBe(6);
  });

  it("goes down onto the last card when the row below is short and has none in this column", () => {
    expect(go("down", 5)).toBe(6);
    expect(go("down", 4)).toBe(6);
  });

  it("does not go down from the last row when it is full either", () => {
    expect(go("down", 5, 3, 6)).toBe(5);
    expect(go("down", 4, 3, 6)).toBe(4);
  });

  it("goes to the ends for Home and End", () => {
    expect(go("first", 5)).toBe(0);
    expect(go("last", 1)).toBe(6);
  });

  it("is a column when the window is narrow enough for one, and a single row when it is wide enough for all", () => {
    expect(go("down", 2, 1)).toBe(3);
    expect(go("up", 2, 1)).toBe(1);
    expect(go("down", 2, 7)).toBe(2);
    expect(go("up", 2, 7)).toBe(2);
  });

  it("treats a grid with no measured columns as one column", () => {
    expect(go("down", 0, 0)).toBe(1);
  });

  it("stays on the one card of a deck of one", () => {
    for (const step of ["left", "right", "up", "down", "first", "last"] as const)
      expect(stepTo(step, 0, 1, 1)).toBe(0);
  });
});
