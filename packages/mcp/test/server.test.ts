import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deckSchema, OP_NAMES, sceneSchema } from "@depthcue/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDepthcueServer, type DepthcueServer, TOOL_NAMES } from "../src/server.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));
const built = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let folder: string;
let depthcue: DepthcueServer;
let client: Client;
let hasBrowser = true;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "depthcue-mcp-"));
  cpSync(demo, folder, { recursive: true });
  depthcue = createDepthcueServer(folder);
  client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([depthcue.server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  await depthcue.close();
  rmSync(folder, { recursive: true, force: true });
});

interface Reply {
  isError: boolean;
  text: string;
  json: any;
  images: Array<{ data: string; mimeType: string }>;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  };
  const body = result.content.find((part) => part.type === "text")?.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  return {
    isError: result.isError === true,
    text: body,
    json,
    images: result.content.flatMap((part) =>
      part.type === "image" ? [{ data: part.data as string, mimeType: part.mimeType as string }] : [],
    ),
  };
}

const revision = async () => (await call("deck_get")).json.rev as string;

describe("the tool list", () => {
  it("offers exactly four tools, and keeps their definitions small", async () => {
    const { tools } = await client.listTools();
    const names = ["deck_get", "deck_apply", "deck_render", "deck_present"];
    expect(tools.map((tool) => tool.name)).toEqual(names);
    expect(TOOL_NAMES).toEqual(names);
    // Every tool definition is in the agent's context on every turn.
    expect(JSON.stringify(tools).length).toBeLessThan(9000);
    for (const tool of tools) expect(tool.description?.length).toBeLessThan(700);
  });

  it("gives deck_apply the exact operations schema and requires base_rev", async () => {
    const apply = (await client.listTools()).tools.find((tool) => tool.name === "deck_apply");
    const schema = apply?.inputSchema as any;
    expect(schema.required).toEqual(["ops", "base_rev"]);
    expect(schema.properties.ops.items.oneOf).toHaveLength(OP_NAMES.length);
    expect(schema.additionalProperties).toBe(false);
  });

  it("lists in deck_apply the keys that deck.set and scene.set accept, as the schemas have them", async () => {
    // The description repeats the keys because a model cannot guess them. If a schema gains or loses a key,
    // this fails and names the description to update.
    const description = (await client.listTools()).tools.find(
      (tool) => tool.name === "deck_apply",
    )?.description;
    const listed = (op: string) =>
      new RegExp(`${op} keys: ([a-z, ]+)\\.`).exec(description ?? "")?.[1]?.split(", ") ?? [];
    const settable = (schema: { properties: object }, apart: string[]) =>
      Object.keys(schema.properties).filter((key) => !apart.includes(key));
    expect(listed("deck.set").sort(), "update the deck.set keys in the deck_apply description").toEqual(
      settable(deckSchema, ["$schema", "schemaVersion", "id", "scenes"]).sort(),
    );
    expect(listed("scene.set").sort(), "update the scene.set keys in the deck_apply description").toEqual(
      settable(sceneSchema, ["$schema", "schemaVersion", "id", "blocks"]).sort(),
    );
  });

  it("marks reads as read-only, and the edit and presenting as not", async () => {
    const { tools } = await client.listTools();
    const hint = (name: string) => tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint;
    expect([hint("deck_get"), hint("deck_apply"), hint("deck_render"), hint("deck_present")]).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});

describe("deck_get", () => {
  it("returns a concise outline and the revision to edit against", async () => {
    const outline = await call("deck_get");
    expect(outline.isError).toBe(false);
    expect(outline.json.rev).toMatch(/^[0-9a-f]{16}$/);
    expect(outline.json.scenes.map((scene: { id: string }) => scene.id)).toEqual([
      "opening",
      "demand",
      "method",
    ]);
    expect(outline.json.scenes[0].blockList).toBeUndefined();
  });

  it("adds block lists when detailed", async () => {
    const outline = await call("deck_get", { detail: "detailed" });
    expect(outline.json.scenes[1].blockList).toEqual([{ id: "chart-demand", type: "bar-chart" }]);
  });

  it("returns one scene's JSON", async () => {
    const scene = await call("deck_get", { view: "scene", scene: "demand" });
    expect(scene.json.scene.id).toBe("demand");
    expect(scene.json.rev).toMatch(/^[0-9a-f]{16}$/);
  });

  it("says how to fix a scene call without a scene, or with a wrong one", async () => {
    const missing = await call("deck_get", { view: "scene" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("needs `scene`");
    const wrong = await call("deck_get", { view: "scene", scene: "Demand" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('Did you mean "demand"?');
  });

  it("names the field when an argument is wrong", async () => {
    const bad = await call("deck_get", { view: "bogus" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^Invalid arguments: view: .*Fix them and call again\.$/);
    const extra = await call("deck_get", { nope: 1 });
    expect(extra.isError).toBe(true);
  });
});

describe("deck_apply", () => {
  it("applies an edit, returns the new revision and says what to render", async () => {
    const before = await revision();
    const reply = await call("deck_apply", {
      base_rev: before,
      ops: [{ op: "block.set", scene: "opening", id: "opening-sub", set: { text: "A shorter line." } }],
    });
    expect(reply.isError).toBe(false);
    expect(reply.json).toMatchObject({ ok: true, changed: ["opening"], removed: [] });
    expect(reply.json.rev).not.toBe(before);
    expect(reply.json.rev).toBe(await revision());
    expect(reply.json.next).toBe("Call deck_render for: opening.");
    const scene = await call("deck_get", { view: "scene", scene: "opening" });
    expect(JSON.stringify(scene.json.scene)).toContain("A shorter line.");
  });

  it("does not suggest a render when only the deck changed", async () => {
    const reply = await call("deck_apply", {
      base_rev: await revision(),
      ops: [{ op: "deck.set", set: { title: "Why channel B leads" } }],
    });
    expect(reply.json.ok).toBe(true);
    expect(reply.json.changed).toEqual([]);
    expect(reply.json.next).toBeUndefined();
  });

  it("rejects a stale revision, writes nothing and tells the agent what to do", async () => {
    const stale = await revision();
    await call("deck_apply", {
      base_rev: stale,
      ops: [{ op: "deck.set", set: { title: "Changed under you" } }],
    });
    const now = await revision();
    const reply = await call("deck_apply", {
      base_rev: stale,
      ops: [{ op: "deck.set", set: { title: "Too late" } }],
    });
    expect(reply.isError).toBe(true);
    expect(reply.json).toMatchObject({ ok: false, code: "stale-revision", rev: now });
    expect(reply.json.hint).toContain(`base_rev "${now}"`);
    expect(await revision()).toBe(now);
  });

  it("rejects a bad operation with where, why and the fix", async () => {
    const before = await revision();
    const reply = await call("deck_apply", {
      base_rev: before,
      ops: [{ op: "scene.remove", id: "missing" }],
    });
    expect(reply.isError).toBe(true);
    expect(reply.json.code).toBe("bad-op");
    expect(reply.json.hint).toContain("Nothing was applied");
    expect(reply.json.diagnostics[0].at).toMatch(/^ops\/0/);
    expect(reply.json.diagnostics[0].message).toBeTruthy();
    expect(await revision()).toBe(before);
  });

  it("rejects an edit that would leave an invalid deck, naming the limit", async () => {
    const before = await revision();
    const reply = await call("deck_apply", {
      base_rev: before,
      ops: [{ op: "block.set", scene: "opening", id: "opening-title", set: { text: "x".repeat(200) } }],
    });
    expect(reply.isError).toBe(true);
    expect(reply.json.code).toBe("invalid-deck");
    expect(reply.json.diagnostics[0]).toMatchObject({
      code: "too-long",
      at: "scenes/opening.json/blocks/0/text",
    });
    expect(await revision()).toBe(before);
  });

  it("names the field when the call itself is malformed", async () => {
    expect((await call("deck_apply", { ops: [] })).text).toContain("Invalid arguments");
    expect((await call("deck_apply", { base_rev: "x" })).text).toContain("ops");
    expect((await call("deck_apply", { base_rev: "x", ops: [] })).text).toContain("ops");
  });
});

describe("deck_render", () => {
  const png = [0x89, 0x50, 0x4e, 0x47];

  it("returns the scene as a PNG with empty diagnostics when it fits", async ({ skip }) => {
    const reply = await call("deck_render", { scene: "demand" });
    if (reply.isError && /No browser/.test(reply.text) && !process.env.CI) {
      hasBrowser = false;
      return skip();
    }
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.json).toMatchObject({ ok: true, scene: "demand", step: 2, diagnostics: [] });
    expect(reply.images).toHaveLength(1);
    expect(reply.images[0]?.mimeType).toBe("image/png");
    expect([...Buffer.from(reply.images[0]?.data as string, "base64").subarray(0, 4)]).toEqual(png);
  }, 60_000);

  it("skips the picture on request and adds measurements when detailed", async ({ skip }) => {
    if (!hasBrowser) return skip();
    const reply = await call("deck_render", {
      scene: "opening",
      screenshot: false,
      detail: "detailed",
    });
    expect(reply.images).toHaveLength(0);
    expect(reply.json.step).toBe(0);
    expect(reply.json.words).toBeGreaterThan(0);
    expect(reply.json.blocks.length).toBeGreaterThan(0);
  }, 60_000);

  it("reports a scene that does not fit, with paths and the repair order", async ({ skip }) => {
    if (!hasBrowser) return skip();
    const body = (n: number) => ({
      id: `crowd-${n}`,
      type: "text",
      role: "body",
      text: Array.from({ length: 80 }, (_, i) => `word${i}`).join(" "),
    });
    const added = await call("deck_apply", {
      base_rev: await revision(),
      ops: [
        {
          op: "scene.add",
          scene: {
            id: "crowded",
            title: "Crowded",
            layout: "text-media",
            blocks: [1, 2, 3, 4, 5, 6].map(body),
          },
        },
      ],
    });
    expect(added.json.ok, added.text).toBe(true);
    const reply = await call("deck_render", { scene: "crowded", screenshot: false });
    expect(reply.json.ok).toBe(false);
    const overflow = reply.json.diagnostics.find((d: { code: string }) => d.code === "overflow");
    expect(overflow.at).toMatch(/^scenes\/crowded\.json\/blocks\/\d$/);
    expect(overflow.fix).toMatch(/Shorten the text first.*roomier template.*split the scene/);
  }, 60_000);

  it("names the scenes when the scene does not exist", async ({ skip }) => {
    if (!hasBrowser) return skip();
    const reply = await call("deck_render", { scene: "nope" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/no scene "nope".*opening, demand, method/);
  }, 60_000);

  it("rejects a size outside the allowed range before starting a browser", async () => {
    const reply = await call("deck_render", { scene: "demand", width: 10 });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("width");
  });
});

describe("pinned blocks", () => {
  const frame = { x: 56, y: 14, w: 38, h: 44 };
  const pinnedScene = {
    schemaVersion: "0.2",
    id: "mcp-pins",
    title: "Pins",
    layout: "text-media",
    blocks: [
      { id: "mcp-pins-heading", type: "text", role: "heading", text: "A heading in the template" },
      { id: "mcp-pins-note", type: "text", role: "body", text: "A short note.", frame },
    ],
  };
  const noteFrame = async () => {
    const scene = await call("deck_get", { view: "scene", scene: "mcp-pins" });
    return scene.json.scene.blocks[1].frame;
  };

  beforeAll(async () => {
    const added = await call("deck_apply", {
      base_rev: await revision(),
      ops: [{ op: "scene.add", scene: pinnedScene }],
    });
    if (added.json?.ok !== true) throw new Error(added.text);
  });

  afterAll(async () => {
    await call("deck_apply", { base_rev: await revision(), ops: [{ op: "scene.remove", id: "mcp-pins" }] });
  });

  it("is told to the agent by the descriptions of deck_get, deck_apply and deck_render", async () => {
    const described = (name: string) =>
      (client.listTools() as Promise<{ tools: Array<{ name: string; description?: string }> }>).then(
        ({ tools }) => tools.find((tool) => tool.name === name)?.description ?? "",
      );
    expect(await described("deck_get")).toContain("`frame` {x,y,w,h}");
    const apply = await described("deck_apply");
    expect(apply).toContain("block.frame");
    expect(apply).toContain("block.unframe");
    expect(await described("deck_render")).toContain("`warnings`");
  });

  it("shows the frame of a pinned block, and counts the pins of a scene in the outline", async () => {
    const outline = await call("deck_get");
    const scenes = outline.json.scenes as Array<{ id: string; pinned?: number }>;
    expect(scenes.find((scene) => scene.id === "mcp-pins")?.pinned).toBe(1);
    expect(scenes.find((scene) => scene.id === "demand")).not.toHaveProperty("pinned");
    const detailed = await call("deck_get", { detail: "detailed" });
    const listed = detailed.json.scenes.find((scene: { id: string }) => scene.id === "mcp-pins").blockList;
    expect(listed).toEqual([
      { id: "mcp-pins-heading", type: "text" },
      { id: "mcp-pins-note", type: "text", frame },
    ]);
    expect(await noteFrame()).toEqual(frame);
  });

  it("pins and unpins through deck_apply, and warns about a text frame in the margin", async () => {
    const edge = { x: 0, y: 10, w: 30, h: 20 };
    const placed = await call("deck_apply", {
      base_rev: await revision(),
      ops: [{ op: "block.frame", scene: "mcp-pins", id: "mcp-pins-note", frame: edge }],
    });
    expect(placed.json.ok, placed.text).toBe(true);
    expect(placed.json.warnings.map((w: { code: string }) => w.code)).toEqual(["frame-outside-safe-area"]);
    expect(await noteFrame()).toEqual(edge);

    const moved = await call("deck_apply", {
      base_rev: await revision(),
      ops: [{ op: "block.frame", scene: "mcp-pins", id: "mcp-pins-note", frame }],
    });
    expect(moved.json.ok).toBe(true);
    expect(moved.json).not.toHaveProperty("warnings");

    const freed = await call("deck_apply", {
      base_rev: await revision(),
      ops: [{ op: "block.unframe", scene: "mcp-pins", id: "mcp-pins-note" }],
    });
    expect(freed.json.ok).toBe(true);
    expect(await noteFrame()).toBeUndefined();
    const again = await call("deck_apply", {
      base_rev: await revision(),
      ops: [{ op: "block.frame", scene: "mcp-pins", id: "mcp-pins-note", frame }],
    });
    expect(again.json.ok).toBe(true);
  });

  it("refuses a frame that runs off the slide, and says how far", async () => {
    const before = await revision();
    const reply = await call("deck_apply", {
      base_rev: before,
      ops: [
        { op: "block.frame", scene: "mcp-pins", id: "mcp-pins-note", frame: { x: 70, y: 10, w: 40, h: 20 } },
      ],
    });
    expect(reply.isError).toBe(true);
    expect(reply.json.diagnostics[0]).toMatchObject({ code: "frame-off-slide" });
    expect(reply.json.diagnostics[0].message).toContain("110%");
    expect(await revision()).toBe(before);
  });

  it("keeps the frame of a block when the agent rewrites its text", async () => {
    expect(await noteFrame()).toEqual(frame);
    const reply = await call("deck_apply", {
      base_rev: await revision(),
      ops: [{ op: "block.set", scene: "mcp-pins", id: "mcp-pins-note", set: { text: "A rewritten note." } }],
    });
    expect(reply.json.ok, reply.text).toBe(true);
    const scene = await call("deck_get", { view: "scene", scene: "mcp-pins" });
    expect(scene.json.scene.blocks[1]).toMatchObject({ text: "A rewritten note.", frame });
  });

  it("drops the frame of a block the agent removes and adds again, unless the new block has one", async () => {
    const note = { id: "mcp-pins-note", type: "text", role: "body", text: "Added back." };
    const bare = await call("deck_apply", {
      base_rev: await revision(),
      ops: [
        { op: "block.remove", scene: "mcp-pins", id: "mcp-pins-note" },
        { op: "block.add", scene: "mcp-pins", block: note },
      ],
    });
    expect(bare.json.ok, bare.text).toBe(true);
    expect(await noteFrame()).toBeUndefined();
    const framed = await call("deck_apply", {
      base_rev: await revision(),
      ops: [
        { op: "block.remove", scene: "mcp-pins", id: "mcp-pins-note" },
        { op: "block.add", scene: "mcp-pins", block: { ...note, frame } },
      ],
    });
    expect(framed.json.ok, framed.text).toBe(true);
    expect(await noteFrame()).toEqual(frame);
  });

  it("rejects a stale revision on a pinned scene, and changes neither the text nor the frame", async () => {
    const stale = await revision();
    const moved = await call("deck_apply", {
      base_rev: stale,
      ops: [{ op: "block.frame", scene: "mcp-pins", id: "mcp-pins-note", frame: { ...frame, y: 20 } }],
    });
    expect(moved.json.ok, moved.text).toBe(true);
    const now = await revision();
    const late = await call("deck_apply", {
      base_rev: stale,
      ops: [
        { op: "block.set", scene: "mcp-pins", id: "mcp-pins-note", set: { text: "Written on old news." } },
        { op: "block.frame", scene: "mcp-pins", id: "mcp-pins-note", frame: { ...frame, y: 30 } },
      ],
    });
    expect(late.isError).toBe(true);
    expect(late.json).toMatchObject({ ok: false, code: "stale-revision", rev: now });
    expect(await revision()).toBe(now);
    const scene = await call("deck_get", { view: "scene", scene: "mcp-pins" });
    expect(scene.json.scene.blocks[1]).toMatchObject({ frame: { ...frame, y: 20 } });
    expect(scene.json.scene.blocks[1].text).not.toBe("Written on old news.");
    const restored = await call("deck_apply", {
      base_rev: now,
      ops: [{ op: "block.frame", scene: "mcp-pins", id: "mcp-pins-note", frame }],
    });
    expect(restored.json.ok).toBe(true);
  });

  it("renders a block pinned over another as a warning, which still leaves the scene done", async ({
    skip,
  }) => {
    if (!hasBrowser) return skip();
    const edit = await call("deck_apply", {
      base_rev: await revision(),
      ops: [
        { op: "block.frame", scene: "mcp-pins", id: "mcp-pins-note", frame: { x: 5, y: 35, w: 90, h: 30 } },
      ],
    });
    expect(edit.json.ok, edit.text).toBe(true);
    const reply = await call("deck_render", { scene: "mcp-pins", screenshot: false });
    expect(reply.json.ok, reply.text).toBe(true);
    expect(reply.json.diagnostics).toEqual([]);
    expect(reply.json.warnings).toHaveLength(1);
    expect(reply.json.warnings[0]).toMatchObject({
      code: "frame-overlap",
      at: "scenes/mcp-pins.json/blocks/1",
    });
    expect(reply.json.warnings[0].fix).toContain('frame of "mcp-pins-note"');
  }, 60_000);

  it("renders a block larger than its frame as an error, with no warning beside it", async ({ skip }) => {
    if (!hasBrowser) return skip();
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const edit = await call("deck_apply", {
      base_rev: await revision(),
      ops: [
        { op: "block.set", scene: "mcp-pins", id: "mcp-pins-note", set: { text: long } },
        { op: "block.frame", scene: "mcp-pins", id: "mcp-pins-note", frame: { x: 5, y: 20, w: 25, h: 6 } },
      ],
    });
    expect(edit.json.ok, edit.text).toBe(true);
    const reply = await call("deck_render", { scene: "mcp-pins", screenshot: false });
    expect(reply.json.ok).toBe(false);
    expect(reply.json.diagnostics.map((d: { code: string }) => d.code)).toEqual(["frame-overflow"]);
    expect(reply.json.diagnostics[0].at).toBe("scenes/mcp-pins.json/blocks/1");
    expect(reply.json).not.toHaveProperty("warnings");
  }, 60_000);
});

describe("unknown tools", () => {
  it("lists the tools that exist", async () => {
    const reply = await call("deck_delete");
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("deck_get, deck_apply, deck_render");
  });
});

describe("the built binary", () => {
  it("speaks MCP over stdio with nothing else on stdout", async ({ skip }) => {
    if (!existsSync(built)) return skip();
    const stdio = new StdioClientTransport({
      command: process.execPath,
      args: [built, demo],
      stderr: "pipe",
    });
    const remote = new Client({ name: "stdio-test", version: "0.0.0" });
    await remote.connect(stdio);
    try {
      expect((await remote.listTools()).tools).toHaveLength(4);
      const outline = (await remote.callTool({ name: "deck_get", arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(outline.content[0]?.text as string).scenes).toHaveLength(3);
    } finally {
      await remote.close();
    }
  }, 30_000);
});
