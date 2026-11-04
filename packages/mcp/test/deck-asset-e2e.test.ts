// An agent brings a picture into a deck: deck_asset adds the file, deck_apply puts an image block on a slide, and
// `depthcue check` finds nothing wrong. Removing the file is refused while the block names it.
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@depthcue/cli";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDepthcueServer, type DepthcueServer } from "../src/server.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

/** A 40 by 30 PNG: the signature and the header chunk are all a reader of its size needs. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 40, 0, 0, 0, 30, 8, 2, 0, 0, 0, 0, 0, 0, 0]),
  Buffer.alloc(32, 1),
]);

let root: string;
let folder: string;
let depthcue: DepthcueServer;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "depthcue-asset-e2e-"));
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

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
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

async function check(): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await run(["check", folder, "--json"], {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  });
  return { code, out: lines.join("\n") };
}

describe("deck_asset", () => {
  let asset = "";

  it("adds a picture by path, and the deck uses it with deck_apply", async () => {
    const file = join(root, "My Picture.png");
    writeFileSync(file, PNG);
    const added = await call("deck_asset", { action: "add", path: file });
    expect(added.isError).toBe(false);
    expect(added.json).toMatchObject({ ok: true, kind: "png", width: 40, height: 30, bytes: PNG.length });
    asset = added.json.asset as string;
    expect(asset).toMatch(/^assets\/my-picture-[0-9a-f]{8}\.png$/);
    expect(existsSync(join(folder, asset))).toBe(true);

    // Adding does not change the deck's revision, so the revision read before it is still good.
    const outline = await call("deck_get", {});
    const applied = await call("deck_apply", {
      base_rev: outline.json.rev,
      ops: [
        {
          op: "block.add",
          scene: "method",
          block: { id: "method-photo", type: "image", asset, alt: "A small test picture" },
        },
      ],
    });
    expect(applied.json.ok).toBe(true);
    const checked = await check();
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.out)).toMatchObject({ ok: true });
    expect(checked.out).not.toContain('"severity": "error"');
  });

  it("adding the same bytes again, as base64, gives the same path", async () => {
    const again = await call("deck_asset", {
      action: "add",
      data: PNG.toString("base64"),
      name: "My Picture.png",
    });
    expect(again.json.asset).toBe(asset);
    expect(readdirSync(join(folder, "assets")).filter((n) => n.startsWith("my-picture"))).toHaveLength(1);
  });

  it("lists the picture with its size and the block that names it", async () => {
    const listed = await call("deck_asset", { action: "list" });
    const entry = listed.json.assets.find((a: { asset: string }) => a.asset === asset);
    expect(entry).toMatchObject({ width: 40, height: 30, usedBy: [{ scene: "method" }] });
    expect(entry.usedBy[0].path).toMatch(/^\/blocks\/\d+\/asset$/);
  });

  it("refuses to remove it while the block names it, and removes it once the block is gone", async () => {
    const refused = await call("deck_asset", { action: "remove", asset });
    expect(refused.isError).toBe(true);
    expect(refused.json).toMatchObject({ ok: false, code: "in-use" });
    expect(existsSync(join(folder, asset))).toBe(true);

    const rev = (await call("deck_get", {})).json.rev;
    const gone = await call("deck_apply", {
      base_rev: rev,
      ops: [{ op: "block.remove", scene: "method", id: "method-photo" }],
    });
    expect(gone.json.ok).toBe(true);
    const removed = await call("deck_asset", { action: "remove", asset });
    expect(removed.json).toEqual({ ok: true, asset });
    expect(existsSync(join(folder, asset))).toBe(false);
  });

  it("refuses what is not an image, what is not a plain file, and arguments that do not fit", async () => {
    const text = join(root, "notes.png");
    writeFileSync(text, "not a picture");
    expect((await call("deck_asset", { action: "add", path: text })).text).toContain("unsupported");
    expect((await call("deck_asset", { action: "add", path: root })).text).toContain("not a regular file");
    expect((await call("deck_asset", { action: "add", path: "photo.png" })).text).toContain("absolute");
    const script = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
    expect(
      (await call("deck_asset", { action: "add", data: script.toString("base64"), name: "s.svg" })).isError,
    ).toBe(true);
    const real = join(root, "real.png");
    writeFileSync(real, PNG);
    try {
      symlinkSync(real, join(root, "link.png"));
      expect((await call("deck_asset", { action: "add", path: join(root, "link.png") })).isError).toBe(true);
    } catch {
      // A machine that does not allow links has none to refuse.
    }
    expect((await call("deck_asset", { action: "add" })).isError).toBe(true);
    expect((await call("deck_asset", { action: "add", data: "AAAA" })).isError).toBe(true);
    expect((await call("deck_asset", { action: "list", path: real })).isError).toBe(true);
    expect((await call("deck_asset", { action: "remove", asset: "assets/report.csv" })).isError).toBe(true);
    expect((await call("deck_asset", { action: "remove", asset: "deck.json" })).isError).toBe(true);
    expect(existsSync(join(folder, "deck.json"))).toBe(true);
  });
});
