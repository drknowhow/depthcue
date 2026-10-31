// @vitest-environment happy-dom
import {
  type Block,
  createSession,
  loadDoc,
  type NewScene,
  type Session,
  type SlotName,
} from "@depthcue/core";
import { renderScene } from "@depthcue/player";
import { beforeEach, describe, expect, it } from "vitest";
import { type Canvas, createCanvas } from "../src/canvas.ts";
import type { GhostHooks } from "../src/ghosts.ts";
import type { NewBlockKind } from "../src/templates.ts";
import { FakeServer } from "./helpers.ts";

const text = (id: string, role: "heading" | "body" = "body"): Block => ({ id, type: "text", role, text: id });
const chart = (id: string): Block => ({ id, type: "bar-chart", data: [{ label: "A", value: 1 }] });

const scenes: NewScene[] = [
  {
    id: "hollow",
    title: "Hollow",
    layout: "claim-evidence",
    summary: { id: "hollow-claim", text: "A claim", evidenceIds: [] },
    blocks: [text("one")],
  },
  {
    id: "whole",
    title: "Whole",
    layout: "claim-evidence",
    summary: { id: "whole-claim", text: "A claim", evidenceIds: ["only"] },
    blocks: [text("only")],
  },
  {
    id: "claimless",
    title: "Claimless",
    layout: "claim-evidence",
    blocks: [text("head", "heading"), text("body")],
  },
  { id: "words", title: "Words", layout: "text-media", blocks: [text("said")] },
  {
    id: "cited",
    title: "Cited",
    layout: "text-media",
    blocks: [text("said-so")],
    sources: [{ id: "cited-source", title: "A report", asset: "assets/report.csv" }],
  },
  { id: "pictures", title: "Pictures", layout: "text-media", blocks: [chart("graph")] },
  { id: "both", title: "Both", layout: "text-media", blocks: [text("said-too"), chart("graph-too")] },
  { id: "plain", title: "Plain", layout: "title", blocks: [text("head-too", "heading")] },
];

let session: Session;
let canvas: Canvas;
let asked: Array<{ slot: SlotName; kind: NewBlockKind; file?: File }>;
let claims: number;
let video: boolean;
let hints: Array<{ text: string; problem: boolean }>;

function start(withGhosts = true) {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo should load");
  session = createSession(doc);
  const result = session.apply(scenes.map((scene) => ({ op: "scene.add" as const, scene })));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  asked = [];
  claims = 0;
  video = false;
  const ghosts: GhostHooks = {
    add: (slot, kind, file) => asked.push({ slot, kind, ...(file ? { file } : {}) }),
    claim: () => {
      claims += 1;
    },
    hasVideo: () => video,
  };
  hints = [];
  canvas = createCanvas(session, {
    hint: (message, problem) => hints.push({ text: message, problem }),
    select: () => {},
    ...(withGhosts ? { ghosts } : {}),
  });
  document.body.replaceChildren(canvas.element);
}

beforeEach(() => start());

const ghosts = () => [...canvas.element.querySelectorAll<HTMLElement>("[data-ghost]")];
const slots = (scene: string) => {
  canvas.render(scene);
  return ghosts().map((node) => node.dataset.ghost);
};
const ghost = (name: SlotName) => {
  const found = ghosts().find((node) => node.dataset.ghost === name);
  if (!found) throw new Error(`no ghost for ${name}`);
  return found;
};
const open = (name: SlotName) =>
  ghost(name).querySelector<HTMLButtonElement>(".ed-ghost-open") as HTMLElement;
const menu = (name: SlotName) => ghost(name).querySelector<HTMLElement>(".ed-ghost-menu") as HTMLElement;

describe("the places drawn for empty areas", () => {
  it("is one for each area that holds nothing", () => {
    expect(slots("hollow")).toEqual(["evidence"]);
    expect(slots("whole")).toEqual(["support"]);
    expect(slots("words")).toEqual(["media"]);
    expect(slots("pictures")).toEqual(["text"]);
  });

  it("is none for a slide whose areas all hold something", () => {
    expect(slots("both")).toEqual([]);
    expect(slots("plain")).toEqual([]);
  });

  it("stands where the claim will go, and not in Evidence, while the slide has no claim", () => {
    expect(slots("claimless")).toEqual(["claim"]);
    expect(ghost("claim").closest(".dc-claim-region")).not.toBeNull();
  });

  it("is the editor's alone: the player draws the same slide without it", () => {
    canvas.render("words");
    expect(ghosts()).toHaveLength(1);
    const scene = session.doc.scenes.words;
    if (!scene) throw new Error("the scene should exist");
    const shown = renderScene(scene, { assetBase: "" });
    expect(shown.querySelector("[data-ghost], .ed-ghost")).toBeNull();
    expect(shown.querySelector(".dc-media-region")).toBeNull();
  });

  it("is not drawn without hooks to add with", () => {
    start(false);
    canvas.render("hollow");
    expect(ghosts()).toEqual([]);
  });

  it("is inside the area, which the player hides while it is empty", () => {
    canvas.render("hollow");
    expect(ghost("evidence").parentElement?.classList.contains("dc-evidence-region")).toBe(true);
  });

  it("makes the media area a text-only slide does not draw, before its sources", () => {
    canvas.render("words");
    const regions = canvas.element.querySelectorAll(".dc-media-region");
    expect(regions).toHaveLength(1);
    expect(ghost("media").parentElement).toBe(regions[0]);
    expect(regions[0]?.nextElementSibling).toBeNull();
    canvas.render("cited");
    const sources = canvas.element.querySelector(".dc-sources");
    expect(sources).not.toBeNull();
    expect(canvas.element.querySelector(".dc-media-region")?.nextElementSibling).toBe(sources);
  });

  it("does not make a second area where the player drew one", () => {
    canvas.render("both");
    expect(canvas.element.querySelectorAll(".dc-media-region")).toHaveLength(1);
    canvas.render("pictures");
    expect(canvas.element.querySelectorAll(".dc-text-region")).toHaveLength(1);
  });

  it("goes when a block fills the area, and comes back when it is taken out", () => {
    canvas.render("words");
    expect(ghosts()).toHaveLength(1);
    session.apply([{ op: "block.add", scene: "words", block: chart("late") }]);
    canvas.render("words");
    expect(ghosts()).toEqual([]);
    session.undo();
    canvas.render("words");
    expect(ghosts()).toHaveLength(1);
  });

  it("is named for the area, for a screen reader", () => {
    canvas.render("hollow");
    expect(ghost("evidence").getAttribute("aria-label")).toBe("Add evidence");
    expect(open("evidence").textContent).toBe("+ Add evidence");
  });
});

describe("adding from a place", () => {
  it("adds text at once where text is the only kind", () => {
    canvas.render("pictures");
    open("text").click();
    expect(asked).toEqual([{ slot: "text", kind: "text" }]);
  });

  it("gives the claim at once", () => {
    canvas.render("claimless");
    open("claim").click();
    expect(claims).toBe(1);
    expect(asked).toEqual([]);
  });

  it("asks what kind where there is a choice, and opens only when clicked", () => {
    canvas.render("hollow");
    expect(menu("evidence").hidden).toBe(true);
    expect(open("evidence").getAttribute("aria-expanded")).toBe("false");
    open("evidence").click();
    expect(menu("evidence").hidden).toBe(false);
    expect(open("evidence").getAttribute("aria-expanded")).toBe("true");
    expect(asked).toEqual([]);
    open("evidence").click();
    expect(menu("evidence").hidden).toBe(true);
  });

  it("offers the kinds the area takes, and no others", () => {
    canvas.render("hollow");
    const kinds = [...menu("evidence").children].map((node) => node.textContent);
    expect(kinds).toEqual(["Text", "Image", "Chart", "Clip"]);
    canvas.render("words");
    expect([...menu("media").children].map((node) => node.textContent)).toEqual(["Image", "Chart", "Clip"]);
  });

  it("adds the kind that was picked, to this area", () => {
    canvas.render("words");
    open("media").click();
    (menu("media").querySelector("[data-ghost-kind='bar-chart']") as HTMLElement).click();
    expect(asked).toEqual([{ slot: "media", kind: "bar-chart" }]);
  });

  it("hands over the file that was chosen for an image", () => {
    canvas.render("words");
    const input = menu("media").querySelector("input[type='file']") as HTMLInputElement;
    const file = new File(["x"], "a.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(asked).toEqual([{ slot: "media", kind: "image", file }]);
  });

  it("turns Clip off, and says why, while the deck has no video", () => {
    canvas.render("words");
    const clip = menu("media").querySelector<HTMLButtonElement>(
      "[data-ghost-kind='clip']",
    ) as HTMLButtonElement;
    expect(clip.disabled).toBe(true);
    expect(clip.title).toMatch(/\.mp4 or \.webm/);
    video = true;
    canvas.render("words");
    const again = menu("media").querySelector<HTMLButtonElement>(
      "[data-ghost-kind='clip']",
    ) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(again.title).toBe("");
  });

  it("closes the menu with Escape, and keeps the key to itself", () => {
    canvas.render("words");
    open("media").click();
    let reached = false;
    canvas.element.addEventListener("keydown", () => {
      reached = true;
    });
    (menu("media").firstElementChild as HTMLElement).focus();
    menu("media").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu("media").hidden).toBe(true);
    expect(reached).toBe(false);
    expect(document.activeElement).toBe(open("media"));
  });

  it("leaves Escape to the slide while the menu is closed", () => {
    canvas.render("words");
    let reached = false;
    canvas.element.addEventListener("keydown", () => {
      reached = true;
    });
    open("media").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reached).toBe(true);
  });

  it("closes the menu when the keyboard leaves the place", () => {
    canvas.render("words");
    open("media").click();
    ghost("media").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    expect(menu("media").hidden).toBe(true);
  });

  it("keeps the menu open while the keyboard moves inside the place", () => {
    canvas.render("words");
    open("media").click();
    ghost("media").dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: menu("media").firstElementChild }),
    );
    expect(menu("media").hidden).toBe(false);
  });
});

describe("dropping a block on an empty area", () => {
  const transfer = () => {
    const data = { types: [] as string[], dropEffect: "none" };
    return Object.assign(data, {
      effectAllowed: "none",
      setData: (type: string) => data.types.push(type),
      setDragImage() {},
    });
  };
  const fire = (target: Element, type: string, data: ReturnType<typeof transfer>) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: data });
    target.dispatchEvent(event);
    return event;
  };
  const carry = (id: string) => {
    const data = transfer();
    const grip = canvas.element.querySelector(`[data-grip='${id}']`) as Element;
    fire(grip, "dragstart", data);
    return data;
  };

  it("moves it there and cites it, when the area is Evidence", () => {
    canvas.render("hollow");
    const data = carry("one");
    const over = fire(ghost("evidence"), "dragover", data);
    expect(over.defaultPrevented).toBe(true);
    expect(ghost("evidence").parentElement?.getAttribute("data-place")).toBe("into");
    fire(ghost("evidence"), "drop", data);
    expect(session.doc.scenes.hollow?.summary?.evidenceIds).toEqual(["one"]);
  });

  it("is one step of Undo", () => {
    canvas.render("hollow");
    fire(ghost("evidence"), "drop", carry("one"));
    session.undo();
    expect(session.doc.scenes.hollow?.summary?.evidenceIds).toEqual([]);
  });

  it("refuses text for the media area, and the drop changes nothing", () => {
    canvas.render("words");
    const data = carry("said");
    fire(ghost("media"), "dragover", data);
    expect(ghost("media").parentElement?.getAttribute("data-place")).toBe("refused");
    expect(hints.at(-1)).toEqual({
      text: expect.stringMatching(/Text goes in the text area/),
      problem: true,
    });
    fire(ghost("media"), "drop", data);
    expect(session.doc.scenes.words?.blocks.map((block) => block.id)).toEqual(["said"]);
  });

  it("carries only a block, so a file dragged over the place is left to the slide", () => {
    canvas.render("hollow");
    const data = transfer();
    data.types.push("Files");
    expect(fire(ghost("evidence"), "dragover", data).defaultPrevented).toBe(false);
  });
});
