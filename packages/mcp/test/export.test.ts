import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDepthcueServer, type DepthcueServer } from "../src/server.ts";

/**
 * deck_export: the PowerPoint file and the offline page, written where the agent says, as the CLI writes them. It never
 * replaces a file the export did not write, and it takes only an absolute path, so where a file lands never depends on
 * the server's working directory.
 */

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

let root: string;
let folder: string;
let depthcue: DepthcueServer;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "depthcue-mcp-export-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  depthcue = createDepthcueServer(folder);
  client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([depthcue.server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  await depthcue.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(args: Record<string, unknown>) {
  const result = (await client.callTool({ name: "deck_export", arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
}

/** A run that needs the browser and the built player, which a machine without them skips; CI has both. */
const unavailable = (reply: { isError: boolean; json: any }) =>
  reply.isError && ["no-browser", "player-not-built"].includes(reply.json?.code) && !process.env.CI;

describe("deck_export", () => {
  it("writes the PowerPoint file and says what each slide could not carry over", async ({ skip }) => {
    const out = join(root, "deck.pptx");
    const reply = await call({ out });
    if (unavailable(reply)) return skip();
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.json).toMatchObject({ ok: true, format: "pptx", out });
    expect(reply.json.slides.map((slide: { scene: string }) => slide.scene)).toEqual(
      JSON.parse(readFileSync(join(folder, "deck.json"), "utf8")).scenes,
    );
    expect(reply.json.fonts.length).toBeGreaterThan(0);
    expect(readFileSync(out).subarray(0, 2).toString("latin1")).toBe("PK");
    // An earlier export of its own, unchanged since, is replaced.
    const again = await call({ out, notes: false });
    expect(again.isError, again.text).toBe(false);
  }, 120_000);

  it("writes the offline page with format folder, with the speaker notes only when asked", async () => {
    // A note only the speaker should see, in a scene of the shared copy.
    const note = "Speaker only: the board has not seen these figures.";
    const sceneFile = join(folder, "scenes", "opening.json");
    writeFileSync(sceneFile, JSON.stringify({ ...JSON.parse(readFileSync(sceneFile, "utf8")), notes: note }));
    const pages = (dir: string) =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"))
        .join("\n");

    const out = join(root, "site");
    const reply = await call({ out, format: "folder" });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.json).toMatchObject({ ok: true, format: "folder", notes: true });
    expect(existsSync(join(out, "index.html"))).toBe(true);
    expect(pages(out)).toContain(note);

    const bare = join(root, "site-without-notes");
    const without = await call({ out: bare, format: "folder", notes: false });
    expect(without.isError, without.text).toBe(false);
    expect(without.json).toMatchObject({ ok: true, format: "folder", notes: false });
    expect(existsSync(join(bare, "index.html"))).toBe(true);
    expect(pages(bare)).not.toContain(note);
  }, 60_000);

  it("refuses a relative path, before anything runs", async () => {
    const reply = await call({ out: "deck.pptx" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("`out` must be an absolute path, and deck.pptx is not.");
  });

  it("refuses a network share, which writing to would sign in to the server it names", async () => {
    const shares = ["//server/share/deck.pptx"];
    if (process.platform === "win32")
      shares.push("\\\\server\\share\\deck.pptx", "\\\\?\\UNC\\server\\share\\deck.pptx");
    for (const out of shares) {
      const reply = await call({ out });
      expect(reply.isError, out).toBe(true);
      expect(reply.text, out).toBe(
        `\`out\` is on a network share (${out}). Export to a folder on this machine, and copy the result there.`,
      );
    }
  });

  it("refuses a PowerPoint file inside the deck folder, before the browser starts", async () => {
    for (const out of [join(folder, "deck.pptx"), join(folder, "assets", "deck.pptx")]) {
      const reply = await call({ out });
      expect(reply.isError, out).toBe(true);
      expect(reply.json, out).toMatchObject({ ok: false, code: "out-in-deck" });
      expect(existsSync(out)).toBe(false);
    }
  });

  it("refuses to replace a file the export did not write, and leaves it as it was", async () => {
    const out = join(root, "theirs.pptx");
    writeFileSync(out, "someone else's slides");
    const reply = await call({ out });
    expect(reply.isError).toBe(true);
    expect(reply.json).toMatchObject({ ok: false, code: "out-not-ours" });
    expect(readFileSync(out, "utf8")).toBe("someone else's slides");
  });

  it("refuses the PowerPoint switches for the folder export, and options it does not have", async () => {
    const folderish = await call({ out: join(root, "site2"), format: "folder", pictures: true });
    expect(folderish.isError).toBe(true);
    expect(folderish.text).toContain("pictures, steps and posters are for format pptx");
    expect(existsSync(join(root, "site2"))).toBe(false);
    const unknown = await call({ out: join(root, "x.pptx"), format: "pdf" });
    expect(unknown.isError).toBe(true);
    const extra = await call({ out: join(root, "x.pptx"), quality: "high" });
    expect(extra.isError).toBe(true);
  });
});
