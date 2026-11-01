// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CommandSources, listCommands } from "../src/commands.ts";
import type { Problem } from "../src/ribbon.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

let store: EditorStore;
let on: {
  scene: string;
  block: string | undefined;
  video: boolean;
  problems: Problem[];
  at: number;
  commentsShown: boolean;
};
let calls: Record<string, ReturnType<typeof vi.fn>>;

const problem = (key: string, fix: Problem["fix"]): Problem => ({
  key,
  scene: "method",
  block: undefined,
  text: key,
  fix,
});
const BACK = { label: "Back to layout", ops: [] };

/** The sources the mounted editor supplies, each one recording that it was called. */
function sources(): CommandSources {
  const spy = (name: string) => {
    const fn = vi.fn();
    calls[name] = fn;
    return fn;
  };
  return {
    session: store.session,
    scene: () => on.scene,
    block: () => on.block,
    add: spy("add"),
    pickImage: spy("pickImage"),
    claim: spy("claim"),
    hasVideo: () => on.video,
    togglePin: spy("togglePin"),
    remove: spy("remove"),
    comment: spy("comment"),
    commentsShown: () => on.commentsShown,
    showComments: spy("showComments"),
    setLead: spy("setLead"),
    setLayout: spy("setLayout"),
    autoLayout: spy("autoLayout"),
    ribbon: {
      get problems() {
        return on.problems;
      },
      get current() {
        return on.problems[on.at];
      },
      step: spy("step"),
      fixNext: spy("fixNext"),
    },
    goTo: spy("goTo"),
    undo: spy("undo"),
    redo: spy("redo"),
    save: spy("save"),
    present: spy("present"),
    showKeys: spy("showKeys"),
    // Each id answers with a key named after it, so a command that asks for the wrong id is seen.
    keysOf: (id) => (id === "none" ? undefined : [[`key:${id}`]]),
  };
}
let supplied: CommandSources;
const list = () => listCommands(supplied);
const ids = () => list().map((command) => command.id);
const get = (id: string) => {
  const found = list().find((command) => command.id === id);
  if (!found) throw new Error(`no command ${id} in: ${ids().join(", ")}`);
  return found;
};

beforeEach(async () => {
  store = await openStore(new FakeServer(), () => memoryDraftStore());
  on = { scene: "method", block: undefined, video: false, problems: [], at: 0, commentsShown: true };
  calls = {};
  supplied = sources();
});

describe("what the palette lists", () => {
  it("lists nothing for a scene that is not in the deck", () => {
    on.scene = "nowhere";
    expect(list()).toEqual([]);
  });

  it("always lists the commands that need nothing in particular, each with a group", () => {
    expect(ids()).toEqual(
      expect.arrayContaining(["add-text", "add-chart", "add-image", "save", "present", "keys"]),
    );
    expect(list().every((command) => command.title !== "" && command.group !== "")).toBe(true);
    expect(new Set(ids()).size).toBe(ids().length);
  });

  it("lists the ways to add, and each does what the quick bar does", () => {
    get("add-text").run();
    expect(calls.add).toHaveBeenLastCalledWith("text");
    get("add-chart").run();
    expect(calls.add).toHaveBeenLastCalledWith("chart");
    get("add-image").run();
    expect(calls.pickImage).toHaveBeenCalledTimes(1);
    expect(calls.add).toHaveBeenCalledTimes(2);
  });

  it("offers a clip only when the deck has a video to put in one", () => {
    expect(ids()).not.toContain("add-clip");
    on.video = true;
    get("add-clip").run();
    expect(calls.add).toHaveBeenLastCalledWith("clip");
  });

  it("offers a claim only to a scene that has none", () => {
    get("add-claim").run();
    expect(calls.claim).toHaveBeenCalledTimes(1);
    on.scene = "demand";
    expect(ids()).not.toContain("add-claim");
  });
});

describe("the problems", () => {
  it("lists nothing about problems when there are none", () => {
    expect(ids()).not.toContain("fix");
    expect(ids()).not.toContain("next-problem");
    expect(ids()).not.toContain("previous-problem");
  });

  it("offers the fix only for a problem on show that has one, and says which", () => {
    on.problems = [problem("a", undefined)];
    expect(ids()).not.toContain("fix");
    on.problems = [problem("a", BACK)];
    expect(get("fix").title).toBe("Fix the problem shown: Back to layout");
    get("fix").run();
    expect(calls.fixNext).toHaveBeenCalledTimes(1);
  });

  it("follows the problem on show, not the first", () => {
    on.problems = [problem("a", undefined), problem("b", { label: "Other", ops: [] })];
    on.at = 1;
    expect(get("fix").title).toBe("Fix the problem shown: Other");
    on.at = 0;
    expect(ids()).not.toContain("fix");
  });

  it("offers next and previous only when there is more than one to go between", () => {
    on.problems = [problem("a", undefined)];
    expect(ids()).not.toContain("next-problem");
    on.problems = [problem("a", undefined), problem("b", undefined)];
    get("next-problem").run();
    expect(calls.step).toHaveBeenLastCalledWith(1);
    get("previous-problem").run();
    expect(calls.step).toHaveBeenLastCalledWith(-1);
  });

  it("puts the problems first, so they are what an empty search shows at the top", () => {
    on.problems = [problem("a", BACK), problem("b", undefined)];
    expect(ids().slice(0, 3)).toEqual(["fix", "next-problem", "previous-problem"]);
  });
});

describe("the chosen block", () => {
  const frameOf = (id: string) =>
    store.session.doc.scenes.method?.blocks.find((block) => block.id === id)?.frame;

  it("lists nothing about a block when none is chosen, or one that is not on the scene", () => {
    expect(ids()).not.toContain("pin");
    expect(ids()).not.toContain("remove");
    on.block = "no-such-block";
    expect(ids()).not.toContain("pin");
    expect(ids()).not.toContain("remove");
  });

  it("offers to pin a block that is in its layout, and to put one back that is pinned", () => {
    on.block = "method-diagram";
    expect(frameOf("method-diagram")).toBeUndefined();
    expect(get("pin").title).toBe("Pin the block where it is");
    get("pin").run();
    expect(calls.togglePin).toHaveBeenCalledWith("method-diagram");

    store.session.apply([
      { op: "block.frame", scene: "method", id: "method-diagram", frame: { x: 10, y: 10, w: 30, h: 30 } },
    ]);
    expect(get("pin").title).toBe("Put the block back in its layout");
  });

  it("offers to remove the block, which it names as a block", () => {
    on.block = "method-diagram";
    expect(get("remove").title).toBe("Remove the block");
    get("remove").run();
    expect(calls.remove).toHaveBeenCalledWith("method-diagram");
  });

  it("calls the chosen claim a claim, and cannot pin it", () => {
    on.scene = "demand";
    const claim = store.session.doc.scenes.demand?.summary?.id as string;
    on.block = claim;
    expect(get("remove").title).toBe("Remove the claim");
    expect(ids()).not.toContain("pin");
    get("remove").run();
    expect(calls.remove).toHaveBeenCalledWith(claim);
  });

  it("offers to comment on the block, or on the claim, and asks the editor to open the box", () => {
    expect(ids()).not.toContain("comment");
    on.block = "method-diagram";
    expect(get("comment").title).toBe("Comment on the block");
    get("comment").run();
    expect(calls.comment).toHaveBeenCalledWith("method-diagram");
    on.scene = "demand";
    on.block = store.session.doc.scenes.demand?.summary?.id as string;
    expect(get("comment").title).toBe("Comment on the claim");
  });

  it("does not offer a comment on a block that is not on the scene", () => {
    on.block = "no-such-block";
    expect(ids()).not.toContain("comment");
  });
});

describe("the comments", () => {
  it("offers to hide the comments while they are shown, and to show them while they are hidden", () => {
    expect(get("comments-toggle").title).toBe("Hide the comments");
    get("comments-toggle").run();
    expect(calls.showComments).toHaveBeenLastCalledWith(false);
    on.commentsShown = false;
    expect(get("comments-toggle").title).toBe("Show the comments");
    get("comments-toggle").run();
    expect(calls.showComments).toHaveBeenLastCalledWith(true);
  });
});

describe("the deck style", () => {
  it("is listed, for the menu on the empty slide, only when the editor can open it, and opens it", () => {
    expect(ids()).not.toContain("deck-style");
    const deckStyle = vi.fn();
    supplied = { ...sources(), deckStyle };
    const command = get("deck-style");
    expect(command.targets).toEqual(["slide"]);
    expect(command.label).toBe("Deck style");
    expect(command.group).toBe("Deck");
    command.run();
    expect(deckStyle).toHaveBeenCalledTimes(1);
  });
});

describe("this scene", () => {
  it("offers to put every pinned block back only when one is pinned", () => {
    expect(ids()).not.toContain("auto-layout");
    store.session.apply([
      { op: "block.frame", scene: "method", id: "method-diagram", frame: { x: 10, y: 10, w: 30, h: 30 } },
    ]);
    get("auto-layout").run();
    expect(calls.autoLayout).toHaveBeenCalledTimes(1);
  });

  it("offers the other leads and not the one it has", () => {
    const leads = () => ids().filter((id) => id.startsWith("lead-"));
    // The method scene is led by the human, the demand scene by the agent.
    expect(leads()).not.toContain("lead-human");
    expect(leads().length).toBeGreaterThan(0);
    get(leads()[0] as string).run();
    expect(calls.setLead).toHaveBeenCalledTimes(1);
    on.scene = "demand";
    expect(leads()).not.toContain("lead-agent");
    expect(leads()).toContain("lead-human");
  });

  it("reads a scene with no lead as led by the human", () => {
    store.session.apply([{ op: "scene.set", id: "method", set: { lead: null } }]);
    expect(store.session.doc.scenes.method?.lead).toBeUndefined();
    expect(ids()).not.toContain("lead-human");
    expect(ids()).toContain("lead-agent");
  });

  it("offers the other layouts and not the one it has, and sets the one chosen", () => {
    const layouts = () => ids().filter((id) => id.startsWith("layout-"));
    expect(layouts()).not.toContain("layout-text-media");
    expect(layouts()).toContain("layout-claim-evidence");
    get("layout-claim-evidence").run();
    expect(calls.setLayout).toHaveBeenCalledWith("claim-evidence");
    on.scene = "demand";
    expect(layouts()).not.toContain("layout-claim-evidence");
    expect(layouts()).toContain("layout-text-media");
  });

  it("goes to every other scene, numbered as the deck numbers them", () => {
    const order = store.session.doc.deck.scenes;
    const goTo = list().filter((command) => command.id.startsWith("scene-"));
    expect(goTo.map((command) => command.id)).toEqual(
      order.filter((id) => id !== "method").map((id) => `scene-${id}`),
    );
    for (const command of goTo) {
      const id = command.id.slice("scene-".length);
      const title = store.session.doc.scenes[id]?.title;
      expect(command.title).toBe(`Go to scene ${order.indexOf(id) + 1}: ${title}`);
    }
    goTo[0]?.run();
    expect(calls.goTo).toHaveBeenCalledWith(goTo[0]?.id.slice("scene-".length));
  });
});

describe("everywhere", () => {
  it("offers Undo and Redo only when there is something to undo or redo", () => {
    expect(ids()).not.toContain("undo");
    expect(ids()).not.toContain("redo");
    store.session.apply([{ op: "scene.set", id: "method", set: { notes: "x" } }]);
    expect(ids()).toContain("undo");
    expect(ids()).not.toContain("redo");
    store.session.undo();
    expect(ids()).not.toContain("undo");
    expect(ids()).toContain("redo");
  });

  it("gives a command the keys the table of shortcuts names for the same thing", () => {
    on.block = "method-diagram";
    store.session.apply([{ op: "scene.set", id: "method", set: { notes: "x" } }]);
    store.session.undo();
    const keysOf = (id: string) => get(id).keys;
    expect(keysOf("add-text")).toEqual([["key:add-text"]]);
    expect(keysOf("add-chart")).toEqual([["key:add-chart"]]);
    expect(keysOf("add-image")).toEqual([["key:add-image"]]);
    expect(keysOf("pin")).toEqual([["key:pin"]]);
    expect(keysOf("redo")).toEqual([["key:redo"]]);
    expect(keysOf("save")).toEqual([["key:save"]]);
    // The sheet is "help" in the table and the command that opens it is "keys".
    expect(keysOf("keys")).toEqual([["key:help"]]);
    store.session.redo();
    expect(keysOf("undo")).toEqual([["key:undo"]]);
  });

  it("gives no keys to a command the table has no key for", () => {
    expect(get("present").keys).toBeUndefined();
    expect(get("layout-claim-evidence").keys).toBeUndefined();
  });

  it("saves, presents and shows the shortcuts by calling what the editor supplies", () => {
    get("save").run();
    get("present").run();
    get("keys").run();
    expect(calls.save).toHaveBeenCalledTimes(1);
    expect(calls.present).toHaveBeenCalledTimes(1);
    expect(calls.showKeys).toHaveBeenCalledTimes(1);
  });

  it("runs Undo and Redo through the editor", () => {
    store.session.apply([{ op: "scene.set", id: "method", set: { notes: "x" } }]);
    get("undo").run();
    expect(calls.undo).toHaveBeenCalledTimes(1);
    store.session.undo();
    get("redo").run();
    expect(calls.redo).toHaveBeenCalledTimes(1);
  });

  it("asks the editor, and not the session, whether there is something to undo or redo when it can say", () => {
    // An accepted change is something to undo although the deck did not change.
    let steps = { undo: false, redo: false };
    supplied = { ...supplied, canUndo: () => steps.undo, canRedo: () => steps.redo };
    expect(ids()).not.toContain("undo");
    steps = { undo: true, redo: true };
    expect(ids()).toContain("undo");
    expect(ids()).toContain("redo");
    store.session.apply([{ op: "scene.set", id: "method", set: { notes: "x" } }]);
    steps = { undo: false, redo: false };
    expect(ids()).not.toContain("undo");
  });

  it("offers the drawer of changes when the editor has one, worded for whether it is open", () => {
    expect(ids()).not.toContain("review");
    const toggle = vi.fn();
    let open = false;
    supplied = { ...supplied, toggleReview: toggle, reviewOpen: () => open };
    expect(get("review").title).toBe("Review the changes since the last review");
    open = true;
    expect(get("review").title).toBe("Close the changes");
    get("review").run();
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("offers the storyboard when the editor has one, with the key that opens it", () => {
    expect(ids()).not.toContain("storyboard");
    const open = vi.fn();
    supplied = { ...supplied, storyboard: open };
    expect(get("storyboard").title).toBe("Open the storyboard");
    expect(get("storyboard").keys).toEqual([["key:storyboard"]]);
    get("storyboard").run();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
