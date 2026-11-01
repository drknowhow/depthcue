import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A comments file that changes in the middle of an edit cannot be made to happen on cue, so the outcome is
// stood in for here. comments-api.test.ts makes it happen for real and checks what the API reports.
vi.mock("../src/comments-api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/comments-api.ts")>()),
  applyCommentsToFolder: () => ({
    ok: false,
    code: "changed-on-disk",
    rev: "0123456789abcdef",
    diagnostics: [],
    hint: "The comments changed while the edit was being applied. Nothing was written. Read them again.",
  }),
}));

const { run } = await import("../src/index.ts");

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const ops = () => {
  root = mkdtempSync(join(tmpdir(), "depthcue-comments-race-"));
  const path = join(root, "ops.json");
  writeFileSync(path, JSON.stringify([{ op: "comment.resolve", id: "c1" }]));
  return path;
};

describe("depthcue comments apply when the file changes under it", () => {
  it("exits 3, like a stale revision, and says nothing was written", () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) };
    expect(run(["comments", "apply", "deck", ops(), "--base-rev", "x"], io)).toBe(3);
    expect(errors.join("\n")).toContain("Rejected (changed-on-disk); nothing was written.");
    expect(errors.join("\n")).toContain("Read them again.");
  });

  it("prints the rejection as JSON with --json, and exits 3", () => {
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: () => undefined };
    expect(run(["comments", "apply", "deck", ops(), "--base-rev", "x", "--json"], io)).toBe(3);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      ok: false,
      applied: false,
      code: "changed-on-disk",
      rev: "0123456789abcdef",
    });
  });
});
