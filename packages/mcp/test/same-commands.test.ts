// The editor and the agent tools are two front ends over one command layer. These tests drive the real editor store
// (over HTTP to the real `depthcue edit` server) and the real `deck_apply` tool (over an MCP client) with the same
// edit, and require the same result and the same refusal of a stale revision. A front end that grew its own way of
// editing would make them differ.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DraftStore, loadDoc, type Op, revisionOf } from "@depthcue/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDeckDir } from "../../cli/src/loader.ts";
import { type RunningServer, startServer } from "../../cli/src/serve.ts";
import { createApi } from "../../editor/src/api.ts";
import { type EditorStore, openStore } from "../../editor/src/store.ts";
import { createDepthcueServer, type DepthcueServer } from "../src/server.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

const RETITLE: Op[] = [{ op: "scene.set", id: "demand", set: { title: "Demand is shifting fast" } }];
const RENAME_DECK: Op[] = [{ op: "deck.set", set: { title: "Retitled by someone else" } }];

let root: string;
let folder: string;
let server: RunningServer;
let depthcue: DepthcueServer;
let agent: Client;
let editor: EditorStore;

/** Every text file of the deck, by path, so two folders or one folder at two moments can be compared. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = { "deck.json": readFileSync(join(dir, "deck.json"), "utf8") };
  for (const name of readdirSync(join(dir, "scenes"))) {
    files[`scenes/${name}`] = readFileSync(join(dir, "scenes", name), "utf8");
  }
  return files;
}

const revisionOnDisk = (dir: string): string => {
  const { doc } = loadDoc(loadDeckDir(dir));
  if (!doc) throw new Error("the deck on disk should be valid");
  return revisionOf(doc);
};

const memoryDrafts = (): DraftStore => {
  let held: string | null = null;
  return { read: () => held, write: (text) => (held = text), clear: () => (held = null) };
};

/** An editor over the real edit server at `dir`, wired like the browser's: a token, and paths under the server. */
async function openEditor(dir: string): Promise<{ store: EditorStore; close: () => Promise<void> }> {
  const playerDir = join(root, `player-${dir.length}`);
  const editorDir = join(root, `editor-${dir.length}`);
  mkdirSync(playerDir, { recursive: true });
  mkdirSync(editorDir, { recursive: true });
  writeFileSync(join(playerDir, "app.js"), "export {};");
  writeFileSync(join(editorDir, "editor.js"), "export {};");
  writeFileSync(join(editorDir, "editor.css"), "body{}");
  const running = await startServer({ folder: dir, playerDir, editorDir, port: 0 });
  const api = createApi(
    running.token as string,
    ((path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${running.port}${path}`, init)) as typeof fetch,
  );
  const store = await openStore(api, memoryDrafts);
  return {
    store,
    close: async () => {
      store.dispose();
      await running.close();
    },
  };
}

interface ToolAnswer {
  isError: boolean;
  json: Record<string, unknown>;
}

async function deckApply(client: Client, baseRev: string, ops: Op[]): Promise<ToolAnswer> {
  const result = (await client.callTool({ name: "deck_apply", arguments: { base_rev: baseRev, ops } })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.find((part) => part.type === "text")?.text ?? "{}";
  return { isError: result.isError === true, json: JSON.parse(text) as Record<string, unknown> };
}

async function connect(dir: string): Promise<{ client: Client; server: DepthcueServer }> {
  const mcp = createDepthcueServer(dir);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.server.connect(serverSide), client.connect(clientSide)]);
  return { client, server: mcp };
}

let closeEditor: () => Promise<void>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-same-"));
});

afterEach(async () => {
  await closeEditor?.();
  await agent?.close();
  await depthcue?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("one command layer under the editor and the agent tools", () => {
  it("gives the same files and the same revision for the same edit", async () => {
    const byEditor = join(root, "by-editor");
    const byAgent = join(root, "by-agent");
    cpSync(demo, byEditor, { recursive: true });
    cpSync(demo, byAgent, { recursive: true });
    expect(snapshot(byEditor)).toEqual(snapshot(byAgent));
    const start = revisionOnDisk(byAgent);

    const opened = await openEditor(byEditor);
    editor = opened.store;
    closeEditor = opened.close;
    const edited = editor.session.apply(RETITLE);
    expect(edited.ok).toBe(true);
    await editor.save();
    expect(editor.status.save).toBe("saved");

    const connected = await connect(byAgent);
    agent = connected.client;
    depthcue = connected.server;
    const applied = await deckApply(agent, start, RETITLE);
    expect(applied.isError).toBe(false);

    expect(snapshot(byEditor)).toEqual(snapshot(byAgent));
    expect(revisionOnDisk(byEditor)).toBe(revisionOnDisk(byAgent));
    expect(applied.json.rev).toBe(revisionOnDisk(byEditor));
    expect(snapshot(byEditor)).not.toEqual(snapshot(demo));
  });

  it("refuses a stale base revision the same way from both sides, and writes nothing", async () => {
    folder = join(root, "deck");
    cpSync(demo, folder, { recursive: true });
    const opened = await openEditor(folder);
    editor = opened.store;
    closeEditor = opened.close;
    const connected = await connect(folder);
    agent = connected.client;
    depthcue = connected.server;
    const before = revisionOnDisk(folder);

    // The agent edits first, so the editor's copy and the revision both sides hold are now behind the disk.
    const first = await deckApply(agent, before, RENAME_DECK);
    expect(first.isError).toBe(false);
    const afterAgent = snapshot(folder);
    const now = revisionOnDisk(folder);
    expect(now).not.toBe(before);

    // The same operations, named against a revision the document does not hold, get the same code from the command
    // layer. The tool's document is the disk, now at `now`, so `before` is stale. The editor's document is still at
    // `before`, so `now` is the revision it does not hold.
    const refusedByTool = await deckApply(agent, before, RETITLE);
    const refusedByEditor = editor.session.apply(RETITLE, { baseRev: now });
    expect(refusedByTool.isError).toBe(true);
    expect(refusedByTool.json).toMatchObject({ ok: false, code: "stale-revision", rev: expect.any(String) });
    expect(refusedByEditor).toMatchObject({ ok: false, code: "stale-revision" });
    expect(snapshot(folder)).toEqual(afterAgent);

    // The editor's own save is refused too: it started from the old revision, and the disk has moved on.
    expect(editor.session.apply(RETITLE).ok).toBe(true);
    await editor.save();
    expect(editor.status.conflict).toEqual({ diskRev: now });
    expect(editor.status.save).toBe("error");
    expect(snapshot(folder)).toEqual(afterAgent);
    expect(revisionOnDisk(folder)).toBe(now);
  });
});
