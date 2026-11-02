// The brand operations through deck_apply, on a copy of the branded fixture: they write what the editor's own apply
// of the same operations writes, and the refusals reach the agent with their hints.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDeck } from "@depthcue/cli/deck-api";
import { applyOps, docToFiles, type Op, revisionOf } from "@depthcue/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDepthcueServer, type DepthcueServer } from "../src/server.ts";

const branded = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));

let root: string;
let folder: string;
let depthcue: DepthcueServer;
let client: Client;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "depthcue-mcp-brand-"));
  folder = join(root, "deck");
  cpSync(branded, folder, { recursive: true });
  depthcue = createDepthcueServer(folder);
  client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([depthcue.server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await client.close();
  await depthcue.close();
  rmSync(root, { recursive: true, force: true });
});

async function apply(ops: Op[]): Promise<{ isError: boolean; json: any }> {
  const read = (await client.callTool({ name: "deck_get", arguments: {} })) as {
    content: Array<{ text?: string }>;
  };
  const rev = JSON.parse(read.content[0]?.text ?? "{}").rev as string;
  const result = (await client.callTool({ name: "deck_apply", arguments: { base_rev: rev, ops } })) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };
  return { isError: result.isError === true, json: JSON.parse(result.content[0]?.text ?? "{}") };
}

const docAt = (dir: string) => {
  const opened = openDeck(dir);
  if (!opened.ok) throw new Error(JSON.stringify(opened.diagnostics));
  return opened.doc;
};

describe("brand operations through deck_apply", () => {
  it("write the files the editor's apply of the same operations writes", async () => {
    const ops: Op[] = [
      {
        op: "slot.add",
        template: "cover",
        slot: {
          id: "date",
          role: "body",
          frame: { x: 8, y: 62, w: 40, h: 6 },
          accepts: ["caption"],
          hint: "The date.",
        },
      },
      { op: "slot.rename", template: "cover", id: "kicker", to: "label" },
      { op: "slot.set", template: "cover", id: "title", set: { valign: null } },
      { op: "template.set", id: "cover", set: { chrome: null } },
      { op: "style.set", id: "kicker", set: { tone: "evidence" } },
    ];
    const before = docAt(folder);
    const edited = applyOps(before, ops, revisionOf(before));
    if (!edited.ok) throw new Error(JSON.stringify(edited.diagnostics));
    const result = await apply(ops);
    expect(result.isError, JSON.stringify(result.json)).toBe(false);
    expect(result.json.rev).toBe(revisionOf(edited.doc));
    // A file the operations leave alone keeps its own layout on disk, so the files compare as JSON.
    for (const [path, text] of Object.entries(docToFiles(edited.doc))) {
      expect(JSON.parse(readFileSync(join(folder, path), "utf8")), path).toEqual(JSON.parse(text));
    }
    expect(
      JSON.parse(readFileSync(join(folder, "brand/templates/cover.json"), "utf8")).slots.map(
        (s: { id: string }) => s.id,
      ),
    ).toContain("label");
  });

  it("refuse a slot that holds blocks, and a built-in template, with what to do instead", async () => {
    const held = await apply([{ op: "slot.remove", template: "cover", id: "kicker" }]);
    expect(held.isError).toBe(true);
    expect(JSON.stringify(held.json)).toContain('holds block \\"welcome-kicker\\" of scene \\"welcome\\"');
    const builtIn = await apply([
      {
        op: "slot.add",
        template: "title",
        slot: {
          id: "date",
          role: "body",
          frame: { x: 8, y: 62, w: 40, h: 6 },
          accepts: ["caption"],
          hint: "The date.",
        },
      },
    ]);
    expect(builtIn.isError).toBe(true);
    expect(JSON.stringify(builtIn.json)).toContain("template.set");
  });
});
