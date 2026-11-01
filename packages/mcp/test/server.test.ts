import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMENTS_FILE,
  commentOpsSchema,
  deckSchema,
  OP_NAMES,
  REVIEW_FILE,
  sceneSchema,
} from "@depthcue/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  it("offers exactly five tools, and keeps their definitions small", async () => {
    const { tools } = await client.listTools();
    const names = ["deck_get", "deck_apply", "deck_comment", "deck_render", "deck_present"];
    expect(tools.map((tool) => tool.name)).toEqual(names);
    expect(TOOL_NAMES).toEqual(names);
    // Every tool definition is in the agent's context on every turn. The cap was 9000 for four tools; the fifth,
    // deck_comment, is 2.3 KB (half of it the operations schema) and deck_get's comments sentences are 0.3 KB, which
    // makes 10.9 KB. Schema 0.3 adds scene.upgrade to the operations schema and, to deck_get and deck_apply, the
    // markup, the text fields, tables, charts and the deck's colors, 0.7 KB in all: a block is an open object in the
    // operations schema, so the descriptions are the only place an agent learns them. Raise it only for a reason of
    // that size.
    expect(JSON.stringify(tools).length).toBeLessThan(12000);
    for (const tool of tools) expect(tool.description?.length).toBeLessThan(1100);
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

  it("marks reads as read-only, and the edit, the comments and presenting as not", async () => {
    const { tools } = await client.listTools();
    const hint = (name: string) => tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint;
    expect([
      hint("deck_get"),
      hint("deck_apply"),
      hint("deck_comment"),
      hint("deck_render"),
      hint("deck_present"),
    ]).toEqual([true, false, false, true, false]);
  });

  it("gives deck_comment the comment operations an agent may use, and none it may not", async () => {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "deck_comment");
    const schema = tool?.inputSchema as any;
    expect(schema.required).toEqual(["ops", "base_rev"]);
    expect(schema.additionalProperties).toBe(false);
    const variants = schema.properties.ops.items.oneOf as Array<{
      required: string[];
      properties: Record<string, { const?: string }>;
    }>;
    expect(variants.map((variant) => variant.properties.op?.const)).toEqual([
      "comment.add",
      "comment.reply",
      "comment.resolve",
      "comment.reopen",
    ]);
    // Who writes is the server's to say, so the schema offers neither author nor ask.
    for (const variant of variants) {
      expect(Object.keys(variant.properties)).not.toContain("author");
      expect(Object.keys(variant.properties)).not.toContain("ask");
      expect(variant.required).not.toContain("author");
    }
    // Everything else is core's own schema, so a property added there reaches the agent without an edit here.
    const core = (
      commentOpsSchema.items.oneOf as unknown as ReadonlyArray<{ properties: object; required: string[] }>
    ).filter((variant) =>
      variants.some((mine) => mine.properties.op?.const === (variant.properties as any).op.const),
    );
    for (const [index, variant] of core.entries()) {
      const mine = variants[index];
      expect(Object.keys(mine?.properties ?? {}).sort()).toEqual(
        Object.keys(variant.properties)
          .filter((key) => key !== "author" && key !== "ask")
          .sort(),
      );
      expect(mine?.required).toEqual(variant.required.filter((key) => key !== "author"));
    }
  });

  it("tells the agent where comments are read, what a task is and how to answer one", async () => {
    const { tools } = await client.listTools();
    const described = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
    expect(described("deck_get")).toContain("`comments`");
    expect(described("deck_get")).toContain("view 'comments'");
    const comment = described("deck_comment");
    expect(comment).toContain("`comments.rev`");
    expect(comment).toContain("`comments.tasks`");
    expect(comment).toMatch(/reply, make the change with deck_apply, then resolve/);
    expect(comment).toContain("leave author out");
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

  it("records what it changed as the agent's, for the person to review", async () => {
    const reply = await call("deck_apply", {
      base_rev: await revision(),
      ops: [{ op: "scene.set", id: "method", set: { notes: "Added for review" } }],
    });
    expect(reply.json.ok).toBe(true);
    expect(reply.json.warnings).toBeUndefined();
    const review = JSON.parse(readFileSync(join(folder, REVIEW_FILE), "utf8"));
    expect(review.agent).toContain("scene:method/notes");
    // The reviewed deck is the one from before the agent's first edit, so it is not the deck the agent just read.
    expect(review.rev).not.toBe(await revision());
  });

  it("still edits when the review cannot be updated, and warns the agent", async () => {
    const path = join(folder, REVIEW_FILE);
    const kept = readFileSync(path, "utf8");
    writeFileSync(path, "{ not json");
    try {
      const reply = await call("deck_apply", {
        base_rev: await revision(),
        ops: [{ op: "scene.set", id: "method", set: { notes: "Edited anyway" } }],
      });
      expect(reply.isError).toBe(false);
      expect(reply.json.ok).toBe(true);
      expect(reply.json.warnings[0]).toMatchObject({ code: "review-not-recorded", at: REVIEW_FILE });
      expect(readFileSync(path, "utf8")).toBe("{ not json");
      expect(JSON.stringify((await call("deck_get", { view: "scene", scene: "method" })).json)).toContain(
        "Edited anyway",
      );
    } finally {
      writeFileSync(path, kept);
    }
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

describe("comments", () => {
  const NOW = "2026-11-01T10:00:00.000Z";
  const commentsPath = () => join(folder, COMMENTS_FILE);
  const person = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    scene: "method",
    block: "method-diagram",
    anchor: { x: 0.4, y: 0.6 },
    thread: [{ author: "you", text: "Make this label shorter.", at: NOW }],
    resolved: false,
    ...over,
  });
  /** The comments file as the person's editor would have left it. */
  const personWrites = (...comments: unknown[]) =>
    writeFileSync(commentsPath(), JSON.stringify({ format: "depthcue-comments/1", comments }));
  const summary = async () =>
    (await call("deck_get")).json.comments as { rev: string; open: number; tasks?: any[] };
  const items = async (args: Record<string, unknown> = {}) =>
    (await call("deck_get", { view: "comments", ...args })).json.comments;
  const answer = async (ops: unknown[], baseRev?: string) =>
    call("deck_comment", { base_rev: baseRev ?? (await summary()).rev, ops });
  const agentAdd = (over: Record<string, unknown> = {}) => ({
    op: "comment.add",
    scene: "opening",
    block: "opening-title",
    anchor: { x: 0.1, y: 0.9 },
    text: "The title runs long.",
    ...over,
  });

  beforeEach(() => rmSync(commentsPath(), { force: true }));
  afterAll(() => rmSync(commentsPath(), { force: true }));

  describe("deck_get", () => {
    it("tells a deck with no comments in a few tokens: the revision to pass and a count of none", async () => {
      const outline = await call("deck_get");
      expect(outline.json.comments).toEqual({ rev: expect.stringMatching(/^[0-9a-f]{16}$/), open: 0 });
      expect(outline.json.comments).not.toHaveProperty("tasks");
      expect(existsSync(commentsPath())).toBe(false);
    });

    it("puts a person's Ask-the-agent comment in the outline as a task, with the words and where", async () => {
      personWrites(person("c1", { ask: true }), person("c2"));
      expect((await summary()).tasks).toEqual([
        { id: "c1", scene: "method", block: "method-diagram", text: "Make this label shorter." },
      ]);
      expect((await summary()).open).toBe(2);
    });

    it("lists the open comments by default, the resolved ones on request, and one scene's on request", async () => {
      personWrites(
        person("c1"),
        person("c2", { resolved: true }),
        person("c3", { scene: "opening", block: "opening-title" }),
      );
      const open = await items();
      expect(open.items.map((item: { id: string }) => item.id)).toEqual(["c1", "c3"]);
      expect(open).toMatchObject({ open: 2, resolved: 1 });
      expect(open.rev).toBe((await summary()).rev);
      expect((await items({ resolved: true })).items.map((item: { id: string }) => item.id)).toEqual([
        "c1",
        "c2",
        "c3",
      ]);
      expect((await items({ scene: "opening" })).items.map((item: { id: string }) => item.id)).toEqual([
        "c3",
      ]);
      expect((await items({ scene: "no-such-scene" })).items).toEqual([]);
    });

    it("adds a scene's open comments to its scene view, and nothing to a scene without any", async () => {
      personWrites(
        person("c1"),
        person("c2", { resolved: true }),
        person("c3", { scene: "opening", block: "opening-title" }),
      );
      const method = await call("deck_get", { view: "scene", scene: "method" });
      expect(method.json.comments).toMatchObject({ open: 1, items: [{ id: "c1" }] });
      expect(method.json.comments.items).toHaveLength(1);
      expect(method.json.comments.rev).toBe((await summary()).rev);
      const demand = await call("deck_get", { view: "scene", scene: "demand" });
      expect(demand.json).not.toHaveProperty("comments");
    });

    it("flags a comment whose block has gone, in the outline and in the list", async () => {
      personWrites(person("c1", { block: "gone" }));
      const outline = await call("deck_get");
      expect(outline.json.warnings.map((w: { code: string }) => w.code)).toContain("orphaned-comment");
      expect((await items()).items[0]).toMatchObject({ id: "c1", orphaned: true });
    });

    it("still reads the deck when comments.json is not valid, and says so", async () => {
      writeFileSync(commentsPath(), "{ nope");
      const outline = await call("deck_get");
      expect(outline.isError).toBe(false);
      expect(outline.json.scenes).toHaveLength(3);
      expect(outline.json).not.toHaveProperty("comments");
      expect(outline.json.warnings.at(-1)).toMatchObject({ at: expect.stringMatching(/^comments\.json/) });
      expect(outline.json.warnings.at(-1).message).toContain("comments.json was not changed");
      const list = await call("deck_get", { view: "comments" });
      expect(list.isError).toBe(true);
      expect(list.text).toContain("comments.json is not valid");
    });
  });

  describe("deck_comment", () => {
    it("adds a comment as the agent, whatever the schema leaves out, and the deck does not move", async () => {
      const deckRev = await revision();
      const before = (await summary()).rev;
      const reply = await answer([agentAdd()]);
      expect(reply.isError, reply.text).toBe(false);
      expect(reply.json).toMatchObject({ ok: true, changed: ["c1"], removed: [] });
      expect(reply.json.rev).not.toBe(before);
      expect(reply.json.rev).toBe((await summary()).rev);
      const [added] = (await items()).items;
      expect(added).toMatchObject({ id: "c1", scene: "opening", block: "opening-title", resolved: false });
      expect(added.thread).toEqual([
        { author: "agent", text: "The title runs long.", at: expect.any(String) },
      ]);
      expect(added).not.toHaveProperty("ask");
      expect(await revision()).toBe(deckRev);
    });

    it("answers a task: reply, then resolve, and the task is gone from the outline at the reply", async () => {
      personWrites(person("c1", { ask: true }));
      expect((await summary()).tasks).toHaveLength(1);
      const replied = await answer([{ op: "comment.reply", id: "c1", text: "Shortened it." }]);
      expect(replied.json).toMatchObject({ ok: true, changed: ["c1"] });
      const afterReply = await summary();
      expect(afterReply).toMatchObject({ open: 1 });
      expect(afterReply).not.toHaveProperty("tasks");
      const [thread] = (await items()).items;
      expect(thread.thread.map((m: { author: string }) => m.author)).toEqual(["you", "agent"]);

      const resolved = await answer([{ op: "comment.resolve", id: "c1" }]);
      expect(resolved.json.ok).toBe(true);
      expect(await summary()).toMatchObject({ open: 0 });
      expect((await items()).items).toEqual([]);
      expect((await items({ resolved: true })).items[0]).toMatchObject({ id: "c1", resolved: true });
    });

    it("brings the task back when the person writes again after the agent's reply", async () => {
      personWrites(person("c1", { ask: true }));
      await answer([{ op: "comment.reply", id: "c1", text: "Done." }]);
      expect((await summary()).tasks).toBeUndefined();
      const written = JSON.parse(readFileSync(commentsPath(), "utf8"));
      written.comments[0].thread.push({ author: "you", text: "Still too long.", at: NOW });
      writeFileSync(commentsPath(), JSON.stringify(written));
      expect((await summary()).tasks).toEqual([
        expect.objectContaining({ id: "c1", text: "Still too long." }),
      ]);
    });

    it("reopens a comment, and applies a list of operations together", async () => {
      personWrites(person("c1", { resolved: true }));
      const reply = await answer([
        { op: "comment.reopen", id: "c1" },
        { op: "comment.reply", id: "c1", text: "Looking again." },
        agentAdd({ text: "Second thought." }),
      ]);
      expect(reply.json).toMatchObject({ ok: true, changed: ["c1", "c2"] });
      expect((await items()).items.map((item: { id: string }) => item.id)).toEqual(["c1", "c2"]);
    });

    it("refuses an author, an ask, or a delete, says why and writes nothing", async () => {
      personWrites(person("c1"));
      const text = readFileSync(commentsPath(), "utf8");
      const refused = async (op: Record<string, unknown>) => {
        const reply = await answer([op]);
        expect(reply.isError).toBe(true);
        expect(readFileSync(commentsPath(), "utf8")).toBe(text);
        return reply.text;
      };
      expect(await refused(agentAdd({ author: "you" }))).toContain("ops[0]: leave out `author`");
      expect(await refused({ op: "comment.reply", id: "c1", text: "Hi", author: "you" })).toContain(
        "`author`",
      );
      expect(await refused(agentAdd({ ask: true }))).toContain("leave out `ask`");
      expect(await refused(agentAdd({ author: "agent", ask: true }))).toContain("`author` and `ask`");
      expect(await refused({ op: "comment.delete", id: "c1" })).toContain(
        "comment.delete is for the person who wrote the comment. Resolve the comment instead.",
      );
    });

    it("names the operation that was refused, by its place in the list", async () => {
      const reply = await answer([agentAdd(), agentAdd({ author: "you" })]);
      expect(reply.text).toContain("ops[1]:");
      expect(existsSync(commentsPath())).toBe(false);
    });

    it("rejects a stale revision, writes nothing and says which revision to use", async () => {
      const stale = (await summary()).rev;
      await answer([agentAdd()], stale);
      const now = (await summary()).rev;
      const text = readFileSync(commentsPath(), "utf8");
      const reply = await answer([agentAdd({ text: "Too late." })], stale);
      expect(reply.isError).toBe(true);
      expect(reply.json).toMatchObject({ ok: false, code: "stale-revision", rev: now });
      expect(reply.json.hint).toContain(`base_rev "${now}"`);
      expect(readFileSync(commentsPath(), "utf8")).toBe(text);
    });

    it("takes the deck's revision for a stale one, because the two are separate", async () => {
      const reply = await answer([agentAdd()], await revision());
      expect(reply.isError).toBe(true);
      expect(reply.json.code).toBe("stale-revision");
      expect(existsSync(commentsPath())).toBe(false);
    });

    it("rejects a comment that names a block the deck does not have, with where and why", async () => {
      const reply = await answer([agentAdd({ block: "no-such-block" })]);
      expect(reply.isError).toBe(true);
      expect(reply.json.code).toBe("bad-op");
      expect(reply.json.hint).toContain("Nothing was applied");
      expect(reply.json.diagnostics[0].at).toMatch(/^ops\/0/);
      expect(existsSync(commentsPath())).toBe(false);
    });

    it("rejects an unknown comment, an empty list and a missing revision, naming the field", async () => {
      expect((await answer([{ op: "comment.resolve", id: "c9" }])).json.code).toBe("bad-op");
      expect((await call("deck_comment", { base_rev: "x", ops: [] })).text).toContain("ops");
      expect((await call("deck_comment", { ops: [agentAdd()] })).text).toContain("base_rev");
      expect((await answer([{ text: "no operation" }])).json.code).toBe("bad-op");
    });

    it("leaves a comments.json that is not valid exactly as it was, and says to fix it by hand", async () => {
      writeFileSync(commentsPath(), "{ nope");
      const reply = await call("deck_comment", { base_rev: "x", ops: [agentAdd()] });
      expect(reply.isError).toBe(true);
      expect(reply.json.code).toBe("unreadable-comments");
      expect(reply.json.hint).toContain("not valid");
      expect(readFileSync(commentsPath(), "utf8")).toBe("{ nope");
    });
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
    expect(reply.text).toContain("deck_get, deck_apply, deck_comment, deck_render");
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
      expect((await remote.listTools()).tools).toHaveLength(5);
      const outline = (await remote.callTool({ name: "deck_get", arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(outline.content[0]?.text as string).scenes).toHaveLength(3);
    } finally {
      await remote.close();
    }
  }, 30_000);
});
