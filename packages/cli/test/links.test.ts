// `depthcue link`: the deck's link library from the command line. Each test works on its own copy of the demo deck.
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { temporaryFolders } from "./brand-import-fixtures.ts";

const make = temporaryFolders();
const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

function deck(): string {
  const dir = make();
  cpSync(demo, dir, { recursive: true });
  return dir;
}

const links = (dir: string) =>
  (JSON.parse(readFileSync(join(dir, "deck.json"), "utf8")) as { links?: Array<Record<string, string>> })
    .links;

describe("depthcue link", () => {
  it("adds, lists, changes and removes a saved link", async () => {
    const dir = deck();
    expect((await cli("link", "list", dir)).out).toContain("no saved links");

    const added = await cli("link", "add", dir, "docs", "https://example.com/docs", "--name", "Docs");
    expect(added.code).toBe(0);
    expect(links(dir)).toEqual([{ id: "docs", title: "Docs", target: "https://example.com/docs" }]);

    const listed = JSON.parse((await cli("link", "list", dir, "--json")).out);
    expect(listed.links[0]).toMatchObject({ id: "docs", kind: "address", uses: [] });

    const set = await cli("link", "set", dir, "docs", "--target", "mailto:a@example.com", "--note", "ask");
    expect(set.code).toBe(0);
    expect(links(dir)?.[0]).toMatchObject({ target: "mailto:a@example.com", note: "ask" });

    expect((await cli("link", "remove", dir, "docs")).code).toBe(0);
    expect(links(dir) ?? []).toEqual([]);
  });

  it("refuses a target that is not allowed and writes nothing", async () => {
    const dir = deck();
    const before = readFileSync(join(dir, "deck.json"), "utf8");
    const refused = await cli("link", "add", dir, "bad", "javascript:alert(1)");
    expect(refused.code).toBe(1);
    expect(readFileSync(join(dir, "deck.json"), "utf8")).toBe(before);
  });

  it("checks: warns about an unused link and a path that is not there, and fails on an unknown scene", async () => {
    const dir = deck();
    await cli("link", "add", dir, "gone", "path:nowhere/at-all");
    const checked = await cli("link", "check", dir);
    expect(checked.code).toBe(0);
    expect(checked.out).toContain("is used by no block or source");
    expect(checked.out).toContain("which is not there");

    const bad = await cli("link", "add", dir, "ghost", "scene:no-such-scene");
    expect(bad.code).toBe(1);
  });

  it("is strict about arguments", async () => {
    const dir = deck();
    expect((await cli("link")).code).toBe(2);
    expect((await cli("link", "nope", dir)).code).toBe(2);
    expect((await cli("link", "add", dir, "x")).code).toBe(2);
    expect((await cli("link", "list", dir, "--to", "x")).code).toBe(2);
    expect((await cli("link", "list", dir, "--online")).code).toBe(2);
    expect((await cli("link", "set", dir, "x")).code).toBe(2);
    expect((await cli("check", dir, "--target", "x")).code).toBe(2);
  });
});
