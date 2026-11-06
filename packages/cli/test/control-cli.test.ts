import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { readLink } from "../src/link.ts";

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

/** A deck to control, and a program that stands in for Claude Code: it writes the arguments it got, then exits 7. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "depthcue-control-"));
  temps.push(root);
  const deck = join(root, "deck");
  cpSync(demo, deck, { recursive: true });
  const seen = join(root, "seen.json");
  const stand = join(root, "claude-stand-in.mjs");
  writeFileSync(
    stand,
    `import { writeFileSync, existsSync } from "node:fs";
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.exit(7);`,
  );
  return { deck, seen, claude: [process.execPath, stand] as const };
}

describe("depthcue control", () => {
  it("shows both commands, and runs neither, with --print", async () => {
    const { deck, claude } = setup();
    const { io, lines } = capture();
    expect(await run(["control", deck, "--print"], io, { claude })).toBe(0);
    expect(lines[0]).toMatch(/^Editor: {2}depthcue edit /);
    const session = lines[1] ?? "";
    expect(session).toContain("--dangerously-load-development-channels server:depthcue");
    expect(session).toContain("--mcp-config");
  });

  it("writes a configuration that starts the deck's server on this folder", async () => {
    const { deck, claude } = setup();
    const { io, lines } = capture();
    await run(["control", deck, "--print"], io, { claude });
    const path = /--mcp-config (\S+|"[^"]+")/.exec(lines[1] ?? "")?.[1]?.replaceAll('"', "") ?? "";
    const config = JSON.parse(readFileSync(path.replaceAll("\\\\", "\\"), "utf8"));
    expect(config.mcpServers.depthcue.command).toBe(process.execPath);
    expect(config.mcpServers.depthcue.args[1]).toBe(resolve(deck));
    expect(existsSync(config.mcpServers.depthcue.args[0])).toBe(true);
  });

  it("starts the editor, starts the session with the channel on, and ends the editor with it", async () => {
    const { deck, seen, claude } = setup();
    const { io, lines, errors } = capture();
    expect(await run(["control", deck, "--port", "0"], io, { claude })).toBe(7);
    expect(errors).toEqual([]);
    expect(lines[0]).toMatch(/^Editing .* at http:\/\/127\.0\.0\.1:\d+\//);
    const got = JSON.parse(readFileSync(seen, "utf8"));
    expect(got.args).toEqual([
      "--mcp-config",
      expect.stringContaining("depthcue-control"),
      "--dangerously-load-development-channels",
      "server:depthcue",
    ]);
    expect(resolve(got.cwd)).toBe(resolve(deck));
    // The editor's link, which agents use to find it, is gone with the editor.
    expect(readLink(deck)).toBeUndefined();
  });

  it("says how to get Claude Code when it cannot be started", async () => {
    const { deck } = setup();
    const { io, errors } = capture();
    expect(await run(["control", deck, "--port", "0"], io, { claude: ["depthcue-no-such-program"] })).toBe(2);
    expect(errors.join("\n")).toContain("DEPTHCUE_CLAUDE");
  });

  it("refuses what it does not take", async () => {
    const { deck } = setup();
    for (const argv of [
      ["control"],
      ["control", deck, "--json"],
      ["control", deck, "--port", "x"],
      ["check", deck, "--print"],
    ]) {
      const { io, errors } = capture();
      expect(await run(argv, io)).toBe(2);
      expect(errors.length).toBeGreaterThan(0);
    }
  });
});
