import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

function copyDeck(): string {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-"));
  temps.push(dir);
  cpSync(demo, dir, { recursive: true });
  return dir;
}

describe("depthcue check", () => {
  it("exits 0 on the fixture deck", () => {
    const { io, lines } = capture();
    expect(run(["check", demo], io)).toBe(0);
    expect(lines.at(-1)).toBe("0 errors, 0 warnings");
  });

  it("exits 1 and prints the fix for a broken scene", () => {
    const dir = copyDeck();
    writeFileSync(
      join(dir, "scenes", "opening.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        id: "opening",
        title: "T",
        layout: "title",
        blocks: [{ id: "h", type: "text", role: "heading", text: "x".repeat(120) }],
      }),
    );
    const { io, lines } = capture();
    expect(run(["check", dir], io)).toBe(1);
    expect(lines.join("\n")).toContain(
      "scenes/opening.json/blocks/0/text  error  120 characters; the limit is 90.",
    );
    expect(lines.join("\n")).toContain("fix: Shorten it by 30");
  });

  it("prints machine-readable output with --json", () => {
    const { io, lines } = capture();
    expect(run(["check", demo, "--json"], io)).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, errors: 0, warnings: 0 });
  });

  it("exits 2 with usage when the arguments are wrong", () => {
    const { io, errors } = capture();
    expect(run(["check"], io)).toBe(2);
    expect(errors[0]).toContain("Usage: depthcue check");
  });

  it("exits 2 when the folder does not exist", () => {
    const { io, errors } = capture();
    expect(run(["check", join(tmpdir(), "depthcue-does-not-exist")], io)).toBe(2);
    expect(errors[0]).toContain("is not a directory");
  });
});
