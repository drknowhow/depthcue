import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(errors[0]).toContain("depthcue check <deck-folder>");
  });

  it("exits 2 when the folder does not exist", () => {
    const { io, errors } = capture();
    expect(run(["check", join(tmpdir(), "depthcue-does-not-exist")], io)).toBe(2);
    expect(errors[0]).toContain("is not a directory");
  });
});

function opsFile(ops: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-ops-"));
  temps.push(dir);
  const file = join(dir, "ops.json");
  writeFileSync(file, JSON.stringify(ops));
  return file;
}

function revOf(dir: string): string {
  const { io, lines } = capture();
  expect(run(["rev", dir], io)).toBe(0);
  return lines[0] as string;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

describe("depthcue rev", () => {
  it("prints a stable 16 character revision", () => {
    const dir = copyDeck();
    expect(revOf(dir)).toMatch(/^[0-9a-f]{16}$/);
    expect(revOf(dir)).toBe(revOf(dir));
    expect(revOf(dir)).toBe(revOf(demo));
  });

  it("exits 1 with the diagnostics when the deck has errors", () => {
    const dir = copyDeck();
    rmSync(join(dir, "scenes", "method.json"));
    const { io, lines } = capture();
    expect(run(["rev", dir], io)).toBe(1);
    expect(lines.join("\n")).toContain('Scene "method" is listed but scenes/method.json does not exist.');
  });
});

describe("depthcue apply", () => {
  const retitle = [
    { op: "block.set", scene: "opening", id: "opening-title", set: { text: "Channel B leads" } },
  ];

  it("applies a transaction, writes only the files that changed, and moves the revision", () => {
    const dir = copyDeck();
    const before = revOf(dir);
    const demand = read(dir, "scenes/demand.json");
    const { io, lines } = capture();
    expect(run(["apply", dir, opsFile(retitle), "--base-rev", before], io)).toBe(0);
    expect(lines[0]).toMatch(new RegExp(`^Applied\\. Revision ${before} -> [0-9a-f]{16}$`));
    expect(lines.slice(1)).toEqual(["  wrote scenes/opening.json"]);
    expect(revOf(dir)).not.toBe(before);
    expect(read(dir, "scenes/demand.json")).toBe(demand);
    expect(read(dir, "scenes/opening.json")).toContain("Channel B leads");
    expect(run(["check", dir], capture().io)).toBe(0);
    expect(readdirSync(join(dir, "scenes")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects a stale revision with exit 3 and leaves the folder alone", () => {
    const dir = copyDeck();
    const opening = read(dir, "scenes/opening.json");
    const { io, lines } = capture();
    expect(run(["apply", dir, opsFile(retitle), "--base-rev", "0123456789abcdef"], io)).toBe(3);
    expect(lines.join("\n")).toContain("Rejected (stale-revision); nothing was written.");
    expect(read(dir, "scenes/opening.json")).toBe(opening);
  });

  it("rejects a result that is not a valid deck with exit 1 and writes nothing", () => {
    const dir = copyDeck();
    const opening = read(dir, "scenes/opening.json");
    const tooLong = [
      { op: "block.set", scene: "opening", id: "opening-title", set: { text: "x".repeat(120) } },
    ];
    const { io, lines } = capture();
    expect(run(["apply", dir, opsFile(tooLong), "--base-rev", revOf(dir)], io)).toBe(1);
    expect(lines.join("\n")).toContain(
      "scenes/opening.json/blocks/0/text  error  120 characters; the limit is 90.",
    );
    expect(read(dir, "scenes/opening.json")).toBe(opening);
  });

  it("adds a scene file and lists it, and deletes the file of a removed scene", () => {
    const dir = copyDeck();
    const add = [
      {
        op: "scene.add",
        scene: {
          id: "next-steps",
          title: "Next steps",
          layout: "title",
          blocks: [{ id: "next-heading", type: "text", role: "heading", text: "Check the numbers" }],
        },
      },
    ];
    expect(run(["apply", dir, opsFile(add), "--base-rev", revOf(dir)], capture().io)).toBe(0);
    expect(existsSync(join(dir, "scenes", "next-steps.json"))).toBe(true);
    expect(JSON.parse(read(dir, "deck.json")).scenes).toEqual(["opening", "demand", "method", "next-steps"]);

    const remove = [{ op: "scene.remove", id: "next-steps" }];
    expect(run(["apply", dir, opsFile(remove), "--base-rev", revOf(dir)], capture().io)).toBe(0);
    expect(existsSync(join(dir, "scenes", "next-steps.json"))).toBe(false);
    expect(run(["check", dir], capture().io)).toBe(0);
  });

  it("prints machine-readable output with --json", () => {
    const dir = copyDeck();
    const before = revOf(dir);
    const { io, lines } = capture();
    expect(run(["apply", dir, opsFile(retitle), "--base-rev", before, "--json"], io)).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      ok: true,
      applied: true,
      prevRev: before,
      changed: ["opening"],
      removed: [],
      written: ["scenes/opening.json"],
    });
  });

  it("accepts --base-rev=<rev> and insists on a revision", () => {
    const dir = copyDeck();
    expect(run(["apply", dir, opsFile(retitle), `--base-rev=${revOf(dir)}`], capture().io)).toBe(0);
    const { io, errors } = capture();
    expect(run(["apply", dir, opsFile(retitle)], io)).toBe(2);
    expect(errors[0]).toContain("apply needs --base-rev");
  });

  it("exits 2 when the operations file is not JSON", () => {
    const dir = copyDeck();
    const file = opsFile([]);
    writeFileSync(file, "{ nope");
    const { io, errors } = capture();
    expect(run(["apply", dir, file, "--base-rev", revOf(dir)], io)).toBe(2);
    expect(errors[0]).toContain("as JSON");
  });
});
