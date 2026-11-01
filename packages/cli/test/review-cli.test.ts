import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_FILE } from "@depthcue/core";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) },
  };
}

/** A copy of the demo deck in its own folder, with room beside it for operation files. */
function copyDeck(): string {
  const root = mkdtempSync(join(tmpdir(), "depthcue-review-cli-"));
  temps.push(root);
  const dir = join(root, "deck");
  cpSync(demo, dir, { recursive: true });
  return dir;
}

let written = 0;
const opsFile = (dir: string, ops: unknown): string => {
  const path = join(dir, "..", `ops-${written++}.json`);
  writeFileSync(path, JSON.stringify(ops));
  return path;
};

const revOf = (dir: string): string => {
  const { io, lines } = capture();
  run(["rev", dir], io);
  return lines[0] as string;
};

/** An edit as the agent makes it from the command line: `depthcue apply`. */
function agent(dir: string, ...ops: unknown[]) {
  const { io, errors, lines } = capture();
  const code = run(["apply", dir, opsFile(dir, ops), "--base-rev", revOf(dir)], io);
  if (code !== 0) throw new Error(`the edit should apply: ${[...lines, ...errors].join("\n")}`);
}

const retitle = (text: string) => ({ op: "deck.set", set: { title: text } });
const text = (block: string, value: string) => ({
  op: "block.set",
  scene: "opening",
  id: block,
  set: { text: value },
});

const diff = (dir: string, ...args: string[]) => {
  const out = capture();
  const code = run(["diff", dir, ...args], out.io);
  return { code, lines: out.lines, errors: out.errors };
};
const diffJson = (dir: string, ...args: string[]) => {
  const result = diff(dir, ...args, "--json");
  return { ...result, json: JSON.parse(result.lines.join("\n")) };
};
const deckText = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

describe("depthcue diff", () => {
  it("forgets a reverted change in the review file, so the same change made by hand is not the agent's", () => {
    const dir = copyDeck();
    agent(dir, retitle("Agent's title"));
    expect(JSON.parse(deckText(dir, REVIEW_FILE)).agent).toEqual(["deck/title"]);
    expect(diff(dir, "revert", "deck/title").code).toBe(0);
    expect(JSON.parse(deckText(dir, REVIEW_FILE)).agent).toEqual([]);
  });

  it("says nobody has started a review on a deck the agent has not edited, and makes no file", () => {
    const dir = copyDeck();
    const result = diff(dir);
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("Nobody has started a review");
    expect(existsSync(join(dir, REVIEW_FILE))).toBe(false);
    expect(diffJson(dir).json).toMatchObject({
      ok: true,
      reviewed: null,
      agent: 0,
      outside: 0,
      changes: [],
    });
  });

  it("lists each change with who made it, what it is and what it was", () => {
    const dir = copyDeck();
    const start = revOf(dir);
    agent(dir, retitle("Channel B leads"), text("opening-title", "Channel B is ahead"));
    const result = diff(dir);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      `Reviewed at revision ${start}; the deck is at ${revOf(dir)}. 2 changes: 2 by the agent, 0 outside.`,
      "deck/title  agent",
      "  Deck title changed",
      '  - "Why channel B now leads"',
      '  + "Channel B leads"',
      "scene:opening/block:opening-title/text  agent",
      '  Text of block "opening-title" in scene "opening" changed',
      '  - "Channel B now leads demand"',
      '  + "Channel B is ahead"',
    ]);
  });

  it("says nothing has changed once everything is reviewed", () => {
    const dir = copyDeck();
    agent(dir, retitle("Channel B leads"));
    diff(dir, "accept", "--all");
    const result = diff(dir);
    expect(result.lines).toEqual([
      expect.stringMatching(
        /^Reviewed at revision [0-9a-f]{16}; the deck is at [0-9a-f]{16}\. Nothing has changed since\.$/,
      ),
    ]);
  });

  it("gives the same list as JSON, with the whole value of what changed", () => {
    const dir = copyDeck();
    const start = revOf(dir);
    agent(dir, retitle("Channel B leads"));
    const { json } = diffJson(dir);
    expect(json).toMatchObject({
      ok: true,
      errors: 0,
      rev: revOf(dir),
      reviewed: start,
      agent: 1,
      outside: 0,
      changes: [
        {
          id: "deck/title",
          scope: "deck",
          kind: "changed",
          field: "title",
          before: "Why channel B now leads",
          after: "Channel B leads",
          by: "agent",
        },
      ],
    });
  });

  it("shortens a long value in the text, and gives it whole in the JSON", () => {
    const dir = copyDeck();
    const long = "x".repeat(300);
    agent(dir, { op: "scene.set", id: "opening", set: { notes: long } });
    const lines = diff(dir).lines;
    const shownValue = lines.find((line) => line.startsWith("  + ")) as string;
    expect(shownValue.length).toBeLessThan(120);
    expect(shownValue.endsWith("…")).toBe(true);
    expect(diffJson(dir).json.changes[0].after).toBe(long);
  });

  it("marks a change made by hand as outside", () => {
    const dir = copyDeck();
    agent(dir, retitle("Channel B leads"));
    const path = join(dir, "scenes", "opening.json");
    writeFileSync(path, deckText(dir, "scenes/opening.json").replace('"lead": "human"', '"lead": "agent"'));
    const { json } = diffJson(dir);
    expect(json.agent).toBe(1);
    expect(json.outside).toBe(1);
    expect(json.changes.map((c: { id: string; by: string }) => [c.id, c.by])).toEqual([
      ["deck/title", "agent"],
      ["scene:opening/lead", "outside"],
    ]);
  });

  it("refuses a review that is not valid and says to delete it, exit 1", () => {
    const dir = copyDeck();
    writeFileSync(join(dir, REVIEW_FILE), "{ nope");
    const result = diff(dir);
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain("unreadable-review");
    expect(result.errors.join("\n")).toContain("Delete it");
    expect(diffJson(dir).json).toMatchObject({ ok: false, code: "unreadable-review" });
    expect(readFileSync(join(dir, REVIEW_FILE), "utf8")).toBe("{ nope");
  });

  it("refuses a deck with errors, exit 1", () => {
    const dir = copyDeck();
    unlinkSync(join(dir, "scenes", "method.json"));
    expect(diff(dir).code).toBe(1);
    expect(diffJson(dir).json.code).toBe("unreadable-deck");
  });
});

describe("depthcue diff accept", () => {
  it("marks one change as reviewed, leaves the others and the deck as they are", () => {
    const dir = copyDeck();
    agent(dir, retitle("Channel B leads"), text("opening-title", "Channel B is ahead"));
    const deckBefore = [deckText(dir, "deck.json"), deckText(dir, "scenes/opening.json")];
    const accepted = diff(dir, "accept", "deck/title");
    expect(accepted.code).toBe(0);
    expect(accepted.lines[0]).toMatch(
      /^Accepted 1 change\. The review is at revision [0-9a-f]{16}; 1 left to review\.$/,
    );
    expect(accepted.lines.slice(1)).toEqual(["  accepted deck/title"]);
    expect([deckText(dir, "deck.json"), deckText(dir, "scenes/opening.json")]).toEqual(deckBefore);
    const left = diffJson(dir).json;
    expect(left.changes.map((c: { id: string }) => c.id)).toEqual(["scene:opening/block:opening-title/text"]);
    expect(left.reviewed).not.toBe(revOf(dir));
  });

  it("takes several ids, and gives the result as JSON", () => {
    const dir = copyDeck();
    agent(dir, retitle("Channel B leads"), text("opening-title", "Channel B is ahead"));
    const result = diffJson(dir, "accept", "deck/title", "scene:opening/block:opening-title/text");
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      accepted: ["deck/title", "scene:opening/block:opening-title/text"],
      remaining: 0,
      reviewed: revOf(dir),
    });
  });

  it("starts a review from the deck as it is with --all when there is none", () => {
    const dir = copyDeck();
    const result = diff(dir, "accept", "--all");
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain("Nothing to accept");
    expect(JSON.parse(deckText(dir, REVIEW_FILE)).rev).toBe(revOf(dir));
    agent(dir, retitle("Channel B leads"));
    expect(diffJson(dir).json.changes).toHaveLength(1);
  });

  it("makes the deck as it is the reviewed one with --all", () => {
    const dir = copyDeck();
    agent(dir, retitle("Channel B leads"));
    const result = diffJson(dir, "accept", "--all");
    expect(result.json).toMatchObject({
      ok: true,
      accepted: ["deck/title"],
      remaining: 0,
      reviewed: revOf(dir),
    });
  });

  it("refuses ids when there is no review, and says how to start one", () => {
    const dir = copyDeck();
    const result = diff(dir, "accept", "deck/title");
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain("no-review");
    expect(result.errors.join("\n")).toContain("accept --all");
    expect(existsSync(join(dir, REVIEW_FILE))).toBe(false);
  });

  it("refuses an id that is not a change and accepts nothing, even of the ids that are", () => {
    const dir = copyDeck();
    agent(dir, retitle("Channel B leads"));
    const review = deckText(dir, REVIEW_FILE);
    const result = diffJson(dir, "accept", "deck/title", "deck/titel");
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ ok: false, code: "unknown-change", unknown: ["deck/titel"] });
    expect(deckText(dir, REVIEW_FILE)).toBe(review);
  });
});

describe("depthcue diff revert", () => {
  it("puts one change back as a new revision and leaves the others", () => {
    const dir = copyDeck();
    const start = revOf(dir);
    agent(dir, retitle("Channel B leads"), text("opening-title", "Channel B is ahead"));
    const before = revOf(dir);
    const result = diffJson(dir, "revert", "deck/title");
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      reverted: ["deck/title"],
      prevRev: before,
      rev: revOf(dir),
      written: ["deck.json"],
      remaining: 1,
    });
    expect(revOf(dir)).not.toBe(before);
    expect(revOf(dir)).not.toBe(start);
    expect(deckText(dir, "deck.json")).toContain("Why channel B now leads");
    expect(deckText(dir, "scenes/opening.json")).toContain("Channel B is ahead");
    expect(diffJson(dir).json.changes.map((c: { id: string }) => c.id)).toEqual([
      "scene:opening/block:opening-title/text",
    ]);
  });

  it("says what it did in words, and puts everything back with --all", () => {
    const dir = copyDeck();
    const start = revOf(dir);
    agent(dir, retitle("Channel B leads"), text("opening-title", "Channel B is ahead"));
    const before = revOf(dir);
    const result = diff(dir, "revert", "--all");
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(`Reverted 2 changes. Revision ${before} -> ${start}; 0 left to review.`);
    expect(result.lines.slice(1)).toEqual([
      "  reverted deck/title",
      "  reverted scene:opening/block:opening-title/text",
      "  wrote scenes/opening.json",
      "  wrote deck.json",
    ]);
    expect(revOf(dir)).toBe(start);
  });

  it("says there is nothing to revert, and writes nothing, when there are no changes", () => {
    const dir = copyDeck();
    agent(dir, retitle("Channel B leads"));
    diff(dir, "accept", "--all");
    const bytes = deckText(dir, "deck.json");
    const result = diff(dir, "revert", "--all");
    expect(result.code).toBe(0);
    expect(result.lines).toEqual(["Nothing to revert."]);
    expect(deckText(dir, "deck.json")).toBe(bytes);
  });

  it("does not record a revert as the agent's edit", () => {
    const dir = copyDeck();
    agent(dir, retitle("Channel B leads"), text("opening-title", "Channel B is ahead"));
    diff(dir, "revert", "deck/title");
    const { json } = diffJson(dir);
    expect(json.changes.map((c: { id: string; by: string }) => [c.id, c.by])).toEqual([
      ["scene:opening/block:opening-title/text", "agent"],
    ]);
  });

  it("refuses a change that would leave a deck that is not valid, and writes nothing", () => {
    const dir = copyDeck();
    agent(dir, { op: "block.remove", scene: "method", id: "method-diagram" });
    unlinkSync(join(dir, "assets", "method.svg"));
    const before = [deckText(dir, "scenes/method.json"), deckText(dir, REVIEW_FILE)];
    const result = diffJson(dir, "revert", "scene:method/block:method-diagram");
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ ok: false, code: "invalid-deck" });
    expect(result.json.diagnostics.map((d: { code: string }) => d.code)).toContain("missing-asset");
    expect([deckText(dir, "scenes/method.json"), deckText(dir, REVIEW_FILE)]).toEqual(before);
  });

  it("refuses an id that is not a change, and says so", () => {
    const dir = copyDeck();
    agent(dir, retitle("Channel B leads"));
    const result = diff(dir, "revert", "scene:method");
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain("unknown-change");
    expect(deckText(dir, "deck.json")).toContain("Channel B leads");
  });

  it("refuses when there is no review, because nothing says what to put back", () => {
    const dir = copyDeck();
    const result = diff(dir, "revert", "--all");
    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain("no-review");
  });
});

describe("depthcue diff usage", () => {
  const usage = (...args: string[]) => {
    const { io, errors } = capture();
    return { code: run(args, io) as number, text: errors.join("\n") };
  };

  it("needs a folder, and only knows accept and revert", () => {
    expect(usage("diff")).toMatchObject({
      code: 2,
      text: expect.stringContaining("diff needs a deck folder"),
    });
    expect(usage("diff", "deck", "forget")).toMatchObject({
      code: 2,
      text: expect.stringContaining('accept or revert after the folder, not "forget"'),
    });
  });

  it("needs ids or --all, never both, and --all alone does not list", () => {
    expect(usage("diff", "deck", "accept").text).toContain("needs change ids or --all");
    expect(usage("diff", "deck", "revert").text).toContain("needs change ids or --all");
    expect(usage("diff", "deck", "accept", "--all", "deck/title").text).toContain("not both");
    expect(usage("diff", "deck", "--all").text).toContain("--all belongs to diff accept and diff revert");
  });

  it("does not take options that belong to other commands", () => {
    expect(usage("diff", "deck", "--base-rev", "x").code).toBe(2);
    expect(usage("diff", "deck", "--port", "1").code).toBe(2);
    expect(usage("check", "deck", "--all").text).toContain(
      "--all belongs to comments list, diff accept and diff revert",
    );
  });

  it("is in the usage text", () => {
    const text = usage("nonsense").text;
    expect(text).toContain("depthcue diff <deck-folder> [--json]");
    expect(text).toContain("depthcue diff <deck-folder> accept <change-id...> | --all [--json]");
    expect(text).toContain("depthcue diff <deck-folder> revert <change-id...> | --all [--json]");
  });
});
