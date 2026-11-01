import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMENTS_FILE } from "@depthcue/core";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));
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
  const root = mkdtempSync(join(tmpdir(), "depthcue-comments-cli-"));
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

const revOfDeck = (dir: string): string => {
  const { io, lines } = capture();
  run(["rev", dir], io);
  return lines[0] as string;
};

const listJson = (dir: string, ...flags: string[]) => {
  const { io, lines } = capture();
  expect(run(["comments", "list", dir, "--json", ...flags], io)).toBe(0);
  return JSON.parse(lines.join("\n"));
};
const rev = (dir: string): string => listJson(dir).rev;

const add = (over: Record<string, unknown> = {}) => ({
  op: "comment.add",
  scene: "method",
  block: "method-diagram",
  anchor: { x: 0.5, y: 0.25 },
  author: "you",
  text: "Is this label right?",
  ...over,
});

describe("depthcue comments list", () => {
  it("says there are none on a deck that has no comments file", () => {
    const dir = copyDeck();
    const { io, lines } = capture();
    expect(run(["comments", "list", dir], io)).toBe(0);
    expect(lines).toEqual([
      expect.stringMatching(
        /^Comments revision [0-9a-f]{16}: 0 open comments, 0 resolved\. 0 tasks for the agent\.$/,
      ),
    ]);
    expect(existsSync(join(dir, COMMENTS_FILE))).toBe(false);
  });

  it("shows each open comment with its thread, and marks an ask the agent has not answered", () => {
    const dir = copyDeck();
    run(
      [
        "comments",
        "apply",
        dir,
        opsFile(dir, [add({ ask: true }), add({ text: "Just a note." })]),
        "--base-rev",
        rev(dir),
      ],
      capture().io,
    );
    const { io, lines } = capture();
    expect(run(["comments", "list", dir], io)).toBe(0);
    expect(lines[0]).toMatch(/2 open comments, 0 resolved\. 1 task for the agent\.$/);
    expect(lines.slice(1)).toEqual([
      "c1  method/method-diagram  open, ask, waiting for the agent",
      "  you  Is this label right?",
      "c2  method/method-diagram  open",
      "  you  Just a note.",
    ]);
  });

  it("says only ask once the agent has answered it, and asks again when the person writes next", () => {
    const dir = copyDeck();
    run(["comments", "apply", dir, opsFile(dir, [add({ ask: true })]), "--base-rev", rev(dir)], capture().io);
    const reply = { op: "comment.reply", id: "c1", author: "agent", text: "Shortened." };
    run(["comments", "apply", dir, opsFile(dir, [reply]), "--base-rev", rev(dir)], capture().io);
    const answered = capture();
    run(["comments", "list", dir], answered.io);
    expect(answered.lines[0]).toMatch(/1 open comment, 0 resolved\. 0 tasks for the agent\.$/);
    expect(answered.lines[1]).toBe("c1  method/method-diagram  open, ask");
    expect(answered.lines.slice(2)).toEqual(["  you  Is this label right?", "  agent  Shortened."]);
    const again = { ...reply, author: "you", text: "Still long." };
    run(["comments", "apply", dir, opsFile(dir, [again]), "--base-rev", rev(dir)], capture().io);
    const waiting = capture();
    run(["comments", "list", dir], waiting.io);
    expect(waiting.lines[1]).toBe("c1  method/method-diagram  open, ask, waiting for the agent");
  });

  it("hides resolved comments, and --all adds them", () => {
    const dir = copyDeck();
    const first = rev(dir);
    run(
      ["comments", "apply", dir, opsFile(dir, [add(), add({ text: "Second." })]), "--base-rev", first],
      capture().io,
    );
    run(
      ["comments", "apply", dir, opsFile(dir, [{ op: "comment.resolve", id: "c1" }]), "--base-rev", rev(dir)],
      capture().io,
    );
    expect(listJson(dir).comments.map((c: { id: string }) => c.id)).toEqual(["c2"]);
    expect(listJson(dir).resolved).toBe(1);
    const all = capture();
    expect(run(["comments", "list", dir, "--all"], all.io)).toBe(0);
    expect(all.lines).toContain("c1  method/method-diagram  resolved");
    expect(listJson(dir, "--all").comments.map((c: { id: string }) => c.id)).toEqual(["c1", "c2"]);
  });

  it("prints the revision, the counts, the tasks and the comments with --json", () => {
    const dir = copyDeck();
    run(["comments", "apply", dir, opsFile(dir, [add({ ask: true })]), "--base-rev", rev(dir)], capture().io);
    const json = listJson(dir);
    expect(json).toMatchObject({ ok: true, open: 1, resolved: 0, diagnostics: [] });
    expect(json.rev).toMatch(/^[0-9a-f]{16}$/);
    expect(json.tasks).toEqual([
      { id: "c1", scene: "method", block: "method-diagram", text: "Is this label right?" },
    ]);
    expect(json.comments[0]).toMatchObject({ id: "c1", ask: true, resolved: false });
  });

  it("says when a comment's block is gone, and exits 0", () => {
    const dir = copyDeck();
    const orphan = {
      id: "c1",
      scene: "method",
      block: "gone",
      anchor: { x: 0.5, y: 0.5 },
      thread: [{ author: "you", text: "Where did it go?", at: "2026-11-01T10:00:00.000Z" }],
      resolved: false,
    };
    writeFileSync(
      join(dir, COMMENTS_FILE),
      JSON.stringify({ format: "depthcue-comments/1", comments: [orphan] }),
    );
    const { io, lines } = capture();
    expect(run(["comments", "list", dir], io)).toBe(0);
    expect(lines).toContain("c1  method/gone  open, its block is gone");
    expect(lines.join("\n")).toContain(
      'comments.json/comments/0  warning  Comment "c1" points at block "gone"',
    );
    expect(listJson(dir).comments[0].orphaned).toBe(true);
    expect(listJson(dir).diagnostics.map((d: { code: string }) => d.code)).toEqual(["orphaned-comment"]);
  });

  it("exits 1 and names the problem when comments.json is not valid", () => {
    const dir = copyDeck();
    writeFileSync(join(dir, COMMENTS_FILE), "{ nope");
    const { io, lines } = capture();
    expect(run(["comments", "list", dir], io)).toBe(1);
    expect(lines.join("\n")).toContain("comments.json");
    expect(lines.at(-1)).toMatch(/error/);
  });
});

describe("depthcue comments apply", () => {
  it("adds a comment, writes only comments.json and leaves the deck's revision alone", () => {
    const dir = copyDeck();
    const deckRev = revOfDeck(dir);
    const before = rev(dir);
    const { io, lines } = capture();
    expect(run(["comments", "apply", dir, opsFile(dir, [add()]), "--base-rev", before], io)).toBe(0);
    expect(lines[0]).toMatch(new RegExp(`^Applied\\. Comments revision ${before} -> [0-9a-f]{16}$`));
    expect(lines[1]).toBe("  changed c1");
    expect(readFileSync(join(dir, COMMENTS_FILE), "utf8")).toContain("Is this label right?");
    expect(revOfDeck(dir)).toBe(deckRev);
    expect(run(["check", dir], capture().io)).toBe(0);
  });

  it("says which comments were removed", () => {
    const dir = copyDeck();
    run(["comments", "apply", dir, opsFile(dir, [add()]), "--base-rev", rev(dir)], capture().io);
    const { io, lines } = capture();
    const remove = [{ op: "comment.delete", id: "c1" }];
    expect(run(["comments", "apply", dir, opsFile(dir, remove), "--base-rev", rev(dir)], io)).toBe(0);
    expect(lines).toEqual([expect.stringMatching(/^Applied\. Comments revision /), "  removed c1"]);
    expect(listJson(dir, "--all").comments).toEqual([]);
  });

  it("says when nothing changed", () => {
    const dir = copyDeck();
    run(["comments", "apply", dir, opsFile(dir, [add()]), "--base-rev", rev(dir)], capture().io);
    const { io, lines } = capture();
    const resolve = [{ op: "comment.resolve", id: "c1" }];
    run(["comments", "apply", dir, opsFile(dir, resolve), "--base-rev", rev(dir)], capture().io);
    expect(run(["comments", "apply", dir, opsFile(dir, resolve), "--base-rev", rev(dir)], io)).toBe(0);
    expect(lines[0]).toMatch(/^Applied\. Nothing changed; the comments stay at revision [0-9a-f]{16}\.$/);
  });

  it("prints what changed with --json", () => {
    const dir = copyDeck();
    const before = rev(dir);
    const { io, lines } = capture();
    expect(run(["comments", "apply", dir, opsFile(dir, [add()]), "--base-rev", before, "--json"], io)).toBe(
      0,
    );
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      ok: true,
      applied: true,
      prevRev: before,
      changed: ["c1"],
      removed: [],
      warnings: [],
    });
  });

  it("rejects a stale revision with exit 3 and writes nothing", () => {
    const dir = copyDeck();
    run(["comments", "apply", dir, opsFile(dir, [add()]), "--base-rev", rev(dir)], capture().io);
    const text = readFileSync(join(dir, COMMENTS_FILE), "utf8");
    const { io, errors } = capture();
    expect(run(["comments", "apply", dir, opsFile(dir, [add()]), "--base-rev", "0123456789abcdef"], io)).toBe(
      3,
    );
    expect(errors.join("\n")).toContain("Rejected (stale-revision); nothing was written.");
    expect(errors.join("\n")).toContain(`base_rev "${rev(dir)}"`);
    expect(readFileSync(join(dir, COMMENTS_FILE), "utf8")).toBe(text);
  });

  it("rejects a bad operation with exit 1, naming where, and writes nothing", () => {
    const dir = copyDeck();
    const { io, lines, errors } = capture();
    const ops = [{ op: "comment.resolve", id: "c9" }];
    expect(run(["comments", "apply", dir, opsFile(dir, ops), "--base-rev", rev(dir)], io)).toBe(1);
    expect(lines.join("\n")).toContain('ops/0/id  error  There is no comment "c9".');
    expect(errors.join("\n")).toContain("Rejected (bad-op); nothing was written.");
    expect(existsSync(join(dir, COMMENTS_FILE))).toBe(false);
  });

  it("needs the author of a message in the file, since the command does not know who is writing", () => {
    const dir = copyDeck();
    const { author: _author, ...anonymous } = add();
    expect(
      run(["comments", "apply", dir, opsFile(dir, [anonymous]), "--base-rev", rev(dir)], capture().io),
    ).toBe(1);
  });

  it("exits 2 when the operations file is not JSON", () => {
    const dir = copyDeck();
    const path = opsFile(dir, []);
    writeFileSync(path, "{ nope");
    const { io, errors } = capture();
    expect(run(["comments", "apply", dir, path, "--base-rev", rev(dir)], io)).toBe(2);
    expect(errors[0]).toContain("as JSON");
  });

  it("prints the rejection as JSON with the hint and the diagnostics", () => {
    const dir = copyDeck();
    const { io, lines } = capture();
    expect(
      run(["comments", "apply", dir, opsFile(dir, [add()]), "--base-rev", "0123456789abcdef", "--json"], io),
    ).toBe(3);
    const json = JSON.parse(lines.join("\n"));
    expect(json).toMatchObject({ ok: false, applied: false, code: "stale-revision" });
    expect(json.hint).toContain("Read them");
  });
});

describe("depthcue comments, used wrongly", () => {
  const usage = (...args: string[]) => {
    const { io, errors } = capture();
    const code = run(args, io);
    return { code, text: errors.join("\n") };
  };

  it("needs a subcommand, and a deck folder", () => {
    expect(usage("comments")).toMatchObject({ code: 2 });
    expect(usage("comments").text).toContain("comments list or comments apply");
    expect(usage("comments", "show", "x").code).toBe(2);
    expect(usage("comments", "list").text).toContain("needs a deck folder");
  });

  it("needs --base-rev and an operations file to apply", () => {
    const dir = copyDeck();
    expect(usage("comments", "apply", dir).text).toContain("needs a deck folder and an operations file");
    const ops = opsFile(dir, [add()]);
    expect(usage("comments", "apply", dir, ops).text).toContain("needs --base-rev");
    expect(usage("comments", "apply", dir, ops, "extra", "--base-rev", "x").text).toContain(
      "Unexpected argument extra",
    );
  });

  it("keeps --all to comments list, and the apply flags off it", () => {
    const dir = copyDeck();
    const ops = opsFile(dir, [add()]);
    expect(usage("comments", "apply", dir, ops, "--base-rev", "x", "--all").text).toContain(
      "--all belongs to comments list",
    );
    expect(usage("check", dir, "--all").text).toContain("--all belongs to comments list");
    expect(usage("clip", "build", dir, "scene.kine", "--all").text).toContain(
      "--all belongs to comments list",
    );
    expect(usage("comments", "list", dir, "--base-rev", "x").text).toContain(
      "takes a deck folder, --all and --json",
    );
    expect(usage("comments", "list", dir, ops).text).toContain("takes a deck folder, --all and --json");
    expect(usage("comments", "list", dir, "--port", "1").code).toBe(2);
    expect(usage("comments", "list", dir, "--quality", "draft").text).toContain("belong to clip build");
  });

  it("lists the command in the usage text", () => {
    const text = usage("comments").text;
    expect(text).toContain("depthcue comments list <deck-folder> [--all] [--json]");
    expect(text).toContain("depthcue comments apply <deck-folder> <ops.json> --base-rev <rev> [--json]");
  });
});
