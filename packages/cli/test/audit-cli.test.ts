import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_FILE, type AuditEntry } from "@depthcue/core";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_MAX_BYTES, appendAudit, loadAuditDir } from "../src/audit-file.ts";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";

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

function copyDeck(): string {
  const root = mkdtempSync(join(tmpdir(), "depthcue-audit-cli-"));
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

const commentsRev = (dir: string): string => {
  const { io, lines } = capture();
  run(["comments", "list", dir, "--json"], io);
  return JSON.parse(lines.join("\n")).rev;
};

function apply(dir: string, ...ops: unknown[]) {
  const { io, errors, lines } = capture();
  const code = run(["apply", dir, opsFile(dir, ops), "--base-rev", revOf(dir)], io);
  if (code !== 0) throw new Error(`the edit should apply: ${[...lines, ...errors].join("\n")}`);
}

function comment(dir: string, ...ops: unknown[]) {
  const { io, errors, lines } = capture();
  const code = run(["comments", "apply", dir, opsFile(dir, ops), "--base-rev", commentsRev(dir)], io);
  if (code !== 0) throw new Error(`the comments should apply: ${[...lines, ...errors].join("\n")}`);
}

const retitle = (title: string) => ({ op: "deck.set", set: { title } });
const text = (block: string, value: string) => ({
  op: "block.set",
  scene: "opening",
  id: block,
  set: { text: value },
});
const add = (over: Record<string, unknown> = {}) => ({
  op: "comment.add",
  scene: "method",
  block: "method-diagram",
  anchor: { x: 0.5, y: 0.25 },
  author: "you",
  text: "Is this label right?",
  ...over,
});

const log = (dir: string, ...args: string[]) => {
  const out = capture();
  const code = run(["log", dir, ...args], out.io);
  return { code, lines: out.lines, errors: out.errors };
};
const entries = (dir: string, ...args: string[]): AuditEntry[] => {
  const result = log(dir, ...args, "--json");
  expect(result.code).toBe(0);
  return JSON.parse(result.lines.join("\n")).entries;
};

describe("the audit log", () => {
  it("records an agent edit under the slide it changed", () => {
    const dir = copyDeck();
    apply(dir, text("opening-title", "Channel B is ahead"));
    expect(entries(dir)).toEqual([
      expect.objectContaining({ by: "agent", kind: "edit", scene: "opening", block: "opening-title" }),
    ]);
  });

  it("records comments, replies and resolves with who sent them and the slide", () => {
    const dir = copyDeck();
    comment(dir, add({ ask: true }));
    comment(
      dir,
      { op: "comment.reply", id: "c1", author: "agent", text: "Fixed." },
      { op: "comment.resolve", id: "c1" },
    );
    expect(entries(dir).map((e) => [e.by, e.kind, e.scene, e.comment])).toEqual([
      ["you", "comment", "method", "c1"],
      ["agent", "reply", "method", "c1"],
      ["agent", "resolve", "method", "c1"],
    ]);
  });

  it("records accept and revert by the change they concern", () => {
    const dir = copyDeck();
    apply(dir, text("opening-title", "Channel B is ahead"), retitle("Channel B leads"));
    const accepted = capture();
    expect(run(["diff", dir, "accept", "deck/title"], accepted.io)).toBe(0);
    const reverted = capture();
    expect(run(["diff", dir, "revert", "--all"], reverted.io)).toBe(0);
    expect(entries(dir, "--kind", "accept")).toEqual([
      expect.objectContaining({ by: "you", kind: "accept" }),
    ]);
    expect(entries(dir, "--kind", "revert")).toEqual([
      expect.objectContaining({ kind: "revert", scene: "opening", block: "opening-title" }),
    ]);
  });

  it("filters by slide and by what came after an entry", () => {
    const dir = copyDeck();
    comment(dir, add());
    apply(dir, text("opening-title", "Channel B is ahead"));
    comment(dir, { op: "comment.reply", id: "c1", author: "agent", text: "Looked." });
    expect(entries(dir, "--scene", "method").map((e) => e.kind)).toEqual(["comment", "reply"]);
    const [first] = entries(dir);
    expect(entries(dir, "--since", (first as AuditEntry).id).map((e) => e.kind)).toEqual(["edit", "reply"]);
    expect(entries(dir, "--limit", "1").map((e) => e.kind)).toEqual(["reply"]);
  });

  it("prints one line for each entry", () => {
    const dir = copyDeck();
    apply(dir, text("opening-title", "Channel B is ahead"));
    const { lines } = log(dir);
    expect(lines[0]).toBe("1 entry of 1.");
    expect(lines[1]).toMatch(/^\S+ {2}agent {2}edit {2}opening\/opening-title {2}/);
  });

  it("refuses an author or kind it does not know", () => {
    const dir = copyDeck();
    expect(log(dir, "--by", "robot").code).toBe(2);
    expect(log(dir, "--kind", "poke").code).toBe(2);
    expect(log(dir, "--limit", "0").code).toBe(2);
  });

  it("does not stop an edit when the log is unreadable", () => {
    const dir = copyDeck();
    writeFileSync(join(dir, AUDIT_FILE), "this is not a log\n");
    apply(dir, retitle("Channel B leads"));
    const read = loadAuditDir(dir);
    expect(read.skipped).toBe(1);
    expect(read.entries).toHaveLength(1);
  });
});

describe("appendAudit", () => {
  it("rolls a log past the size limit into audit.1.jsonl and starts a new one", () => {
    const dir = copyDeck();
    writeFileSync(join(dir, AUDIT_FILE), "x".repeat(AUDIT_MAX_BYTES + 1));
    expect(appendAudit(dir, [{ by: "you", kind: "edit", summary: "later" }])).toBe(true);
    expect(readFileSync(join(dir, "audit.1.jsonl"), "utf8")).toHaveLength(AUDIT_MAX_BYTES + 1);
    expect(loadAuditDir(dir).entries.map((e) => e.summary)).toEqual(["later"]);
  });

  it("reports false instead of throwing when the folder is not there", () => {
    const dir = copyDeck();
    expect(appendAudit(join(dir, "missing"), [{ by: "you", kind: "edit", summary: "lost" }])).toBe(false);
  });

  it("gives each entry its own id and the time it was given", () => {
    const dir = copyDeck();
    appendAudit(
      dir,
      [
        { by: "you", kind: "edit", summary: "one" },
        { by: "you", kind: "edit", summary: "two" },
      ],
      () => "2026-11-05T10:00:00.000Z",
    );
    const { entries: written } = loadAuditDir(dir);
    expect(new Set(written.map((e) => e.id)).size).toBe(2);
    expect(written.every((e) => e.time === "2026-11-05T10:00:00.000Z")).toBe(true);
  });
});

describe("the audit file and the deck", () => {
  it("is not read as part of the deck and does not change its revision", () => {
    const dir = copyDeck();
    const before = revOf(dir);
    appendAudit(dir, [{ by: "agent", kind: "edit", summary: "zebra-marker-7f3a" }]);
    expect(existsSync(join(dir, AUDIT_FILE))).toBe(true);
    expect(revOf(dir)).toBe(before);
    expect(JSON.stringify(Object.keys(loadDeckDir(dir).text))).not.toContain("audit");
  });
});
