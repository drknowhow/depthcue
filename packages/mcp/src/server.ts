import {
  applyCommentsToFolder,
  type CommentSummary,
  listComments,
  readCommentsFor,
  summarize,
} from "@depthcue/cli/comments-api";
import { applyToFolder, type Detail, getOutline, getScene, openDeck } from "@depthcue/cli/deck-api";
import { openRenderer, type Renderer, type SceneRender } from "@depthcue/cli/render";
import { commentOpsSchema, type Diagnostic, opsSchema } from "@depthcue/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { createPresent, presentArgs } from "./present.ts";

const detail = z
  .enum(["concise", "detailed"])
  .default("concise")
  .describe("concise answers the next decision; detailed adds everything the deck knows.");

const getArgs = z.strictObject({
  view: z
    .enum(["outline", "scene", "comments"])
    .default("outline")
    .describe("outline lists the scenes; scene returns one; comments lists the comments."),
  scene: z.string().optional().describe("Scene id. Required when view is scene; narrows view comments."),
  resolved: z.boolean().default(false).describe("With view comments, true adds the resolved ones."),
  detail,
});

const renderArgs = z.strictObject({
  scene: z.string().describe("Scene id."),
  step: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("How many steps are shown. Default: all of them, the fullest the scene gets."),
  width: z.number().int().min(160).max(7680).optional().describe("Stage width in CSS pixels. Default 1280."),
  height: z.number().int().min(90).max(4320).optional().describe("Stage height in CSS pixels. Default 720."),
  screenshot: z
    .boolean()
    .default(true)
    .describe("false returns diagnostics only, which costs far fewer tokens."),
  detail,
});

const applyArgs = z.strictObject({
  ops: z.array(z.unknown()).min(1).max(100),
  base_rev: z.string().min(1),
});

/** The ops schema without its document-level keys, so it can sit inside a tool schema. */
const { $schema: _dialect, $id: _id, title: _title, ...opsBody } = opsSchema as Record<string, unknown>;

/**
 * What an agent may do to comments. It reads and answers: add, reply, resolve and reopen. Deleting is for the person
 * who wrote the comment, and who wrote a message is not the agent's to say, so `author`, `ask` and `comment.delete`
 * are left out of the schema and refused if sent.
 */
const AGENT_COMMENT_OPS = ["comment.add", "comment.reply", "comment.resolve", "comment.reopen"] as const;
const COMMENT_OPS_LEFT_OUT = ["author", "ask"] as const;

interface OpVariant {
  required: string[];
  properties: Record<string, { const?: string }>;
}
const commentOpsBody = (() => {
  const {
    $schema: _dialect,
    $id: _id,
    title: _title,
    ...body
  } = JSON.parse(JSON.stringify(commentOpsSchema)) as { items: { oneOf: OpVariant[] } } & Record<
    string,
    unknown
  >;
  body.items.oneOf = body.items.oneOf
    .filter((variant) => AGENT_COMMENT_OPS.includes(variant.properties.op?.const as never))
    .map((variant) => {
      for (const key of COMMENT_OPS_LEFT_OUT) delete variant.properties[key];
      variant.required = variant.required.filter(
        (key) => !(COMMENT_OPS_LEFT_OUT as readonly string[]).includes(key),
      );
      return variant;
    });
  return body;
})();

/**
 * Turns an agent's comment operations into core's: the author is the agent, always. An operation that names an
 * author or an ask, or deletes, is refused with the reason, because accepting it would put words in a person's mouth
 * or remove what a person wrote.
 */
function asAgent(ops: readonly unknown[]): { ok: true; ops: unknown[] } | { ok: false; message: string } {
  const out: unknown[] = [];
  for (const [index, entry] of ops.entries()) {
    const body = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
    const name = body?.op;
    if (body === undefined || typeof name !== "string") {
      out.push(entry);
      continue;
    }
    if (name === "comment.delete")
      return {
        ok: false,
        message: `ops[${index}]: comment.delete is for the person who wrote the comment. Resolve the comment instead.`,
      };
    const sent = COMMENT_OPS_LEFT_OUT.filter((key) => key in body);
    if (sent.length > 0)
      return {
        ok: false,
        message: `ops[${index}]: leave out ${sent.map((key) => `\`${key}\``).join(" and ")}. You write as the agent, and only a person asks you to act.`,
      };
    out.push(name === "comment.add" || name === "comment.reply" ? { ...body, author: "agent" } : body);
  }
  return { ok: true, ops: out };
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

const TOOLS = [
  {
    name: "deck_get",
    description:
      "Read the deck. view 'outline' (default) lists every scene with its id, title, layout, lead, block and step counts, and returns `rev`, the deck revision to pass to deck_apply as base_rev, and `comments`: the open count and your tasks. view 'scene' returns one scene's full JSON and its open comments. view 'comments' lists comments, open ones unless resolved is true. detail 'detailed' adds block lists, per-scene revisions and assets. A block with a `frame` {x,y,w,h} is pinned: percent of the 16:9 slide, x,y its top-left corner, so x+w and y+h stay within 100. The rest sit in their layout's slots. Only a text block's `text` in a 0.3 scene is markup: **bold**, *italic*, [label](https: or mailto: URL), [label]{tone}, \\ escapes, and `- ` or `1. ` lines in body text. Every other string, and older text, is literal. Text blocks take tone (text, muted, action, evidence), size (s to xl), align (start, center, end). table and chart blocks hold `columns` and `rows`; a chart's first column is its categories, and series take palette colors. deck.json takes palette {color: #rrggbb} and fonts.",
    inputSchema: jsonSchema(getArgs),
    annotations: { title: "Read the deck", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "deck_apply",
    description:
      "Edit the deck. Applies `ops` atomically against `base_rev`, the `rev` from deck_get or your last deck_apply. An invalid op or a stale base_rev writes nothing and the reply says how to fix it; a stale revision is never merged: read again and redo. `set` replaces each key it names whole: send whole arrays (rows, steps). null deletes an optional key. deck.set keys: title, language, theme, palette, fonts, modules. scene.set keys: title, layout, lead, summary, sources, reading, steps, notes. scene.add and block.add take a whole scene or block. `after` is a sibling id, null for first, omitted for last. block.frame and block.unframe pin and unpin a block. scene.upgrade makes an older scene 0.3 and escapes its text, as adding a 0.3 field does; other scenes keep their version. Unknown fields are rejected, never dropped. Ids never change: add the new item, remove the old.",
    inputSchema: {
      type: "object",
      properties: {
        base_rev: { type: "string", description: "The deck revision you read. Get it from deck_get." },
        ops: { ...opsBody, description: "Operations, applied in order as one transaction." },
      },
      required: ["ops", "base_rev"],
      additionalProperties: false,
    },
    annotations: {
      title: "Edit the deck",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "deck_comment",
    description:
      "Leave and answer comments on the deck's blocks. They are kept beside the deck, never in it. deck_get returns `comments.rev`, the base_rev to pass here, and `comments.tasks`, which people asked you to act on. Operations apply together or not at all. For a task: reply, make the change with deck_apply, then resolve it. You write as the agent, so leave author out. You cannot delete. `anchor` is where on the block the comment points, as fractions from 0 to 1 from its top left. A stale base_rev is rejected, never merged: read again and redo.",
    inputSchema: {
      type: "object",
      properties: {
        base_rev: {
          type: "string",
          description: "The comments revision you read: `comments.rev` from deck_get.",
        },
        ops: { ...commentOpsBody, description: "Comment operations, applied in order as one transaction." },
      },
      required: ["ops", "base_rev"],
      additionalProperties: false,
    },
    annotations: {
      title: "Comment on the deck",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "deck_render",
    description:
      "Render one scene at the stage size in a real browser, with fonts loaded and motion off, then measure it. Returns a PNG and diagnostics for overflow, clipping, overlap, text under the minimum size, low contrast, images that failed to load, and a pinned block larger than its frame. Each diagnostic names a `path` into the scene JSON and a `fix`. Repair order: shorten the text, pick a roomier template, split the scene. Nothing is scaled down to fit. A scene is done when `diagnostics` is empty. `warnings`, such as a pinned block over another block, are advice.",
    inputSchema: jsonSchema(renderArgs),
    annotations: { title: "Render a scene", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "deck_present",
    description:
      "Present the deck while the presenter has handed you control; you cannot take it (they press Hand to agent on the page). `status` shows who holds control, where the deck is (scene, step, steps) and, if you hold it, your scenes and actions. Then `next`, `previous`, `goto` (scene, step) and `invoke` (block, command, args) move the deck within your scenes, and `release` hands control back. Control is renewed while you keep calling, and let go after two idle minutes. If holder is 'human', the presenter took over: stop, never retry, wait to be handed control again. Needs `depthcue serve` running on this folder with its page open.",
    inputSchema: jsonSchema(presentArgs),
    annotations: {
      title: "Present the deck",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
] as const;

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

/** What an agent is told about each tool. The docs site prints these, so the reference cannot drift from the server. */
export const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.fromEntries(
  TOOLS.map((tool) => [tool.name, tool.description]),
);

const compact = (value: unknown): string => JSON.stringify(value);

/** A summary without an empty task list, so a quiet deck costs a few tokens. */
function commentsOf({ tasks, ...rest }: CommentSummary) {
  return { ...rest, ...(tasks.length > 0 ? { tasks } : {}) };
}

const plain = (d: Diagnostic) => ({
  code: d.code,
  at: `${d.file}${d.path}`,
  message: d.message,
  ...(d.fix === undefined ? {} : { fix: d.fix }),
});

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: compact(value) }] });

const failure = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

function complaint(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "arguments"}: ${issue.message}`)
    .join("; ");
  return `Invalid arguments: ${issues}. Fix them and call again.`;
}

export interface DepthcueServer {
  server: Server;
  close(): Promise<void>;
}

/**
 * An MCP server over one deck folder. Five tools, because every tool an agent can see costs it tokens on every
 * turn: deck_get reads, deck_apply edits, deck_comment answers the person's comments, deck_render checks the result
 * with a screenshot and measurements, deck_present drives the deck while the presenter has handed over control.
 * The browser starts on the first render and is kept until `close()`.
 */
export function createDepthcueServer(folder: string, version = "0.0.0"): DepthcueServer {
  const server = new Server({ name: "depthcue", version }, { capabilities: { tools: {} } });
  let renderer: Promise<Renderer> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const present = createPresent(folder);

  /** Renders one at a time: a headless browser per request would swamp a laptop. */
  const renderOnce = (task: (r: Renderer) => Promise<SceneRender>): Promise<SceneRender> => {
    renderer ??= openRenderer(folder);
    const started = renderer;
    const run = queue.then(async () => task(await started));
    queue = run.catch(() => undefined);
    return run;
  };

  function get(raw: unknown): CallToolResult {
    const parsed = getArgs.safeParse(raw ?? {});
    if (!parsed.success) return failure(complaint(parsed.error));
    const { view, scene, resolved, detail: level } = parsed.data;
    if (view === "scene" && !scene)
      return failure(
        "view 'scene' needs `scene`, the scene id. Call deck_get with view 'outline' to list them.",
      );

    const opened = openDeck(folder);
    if (!opened.ok) {
      return failure(
        `The deck has errors, so it cannot be read. Fix these in the files, or with deck_apply once it opens: ${compact(opened.diagnostics.filter((d) => d.severity === "error").map(plain))}`,
      );
    }
    const deckWarnings = opened.diagnostics.filter((d) => d.severity === "warning").map(plain);
    const read = readCommentsFor(folder, opened.doc);
    // A comments file that cannot be read is told as a warning: the deck is still fine to read and edit.
    const commentWarnings = read.ok
      ? read.warnings.map(plain)
      : read.diagnostics.map((d) => ({
          ...plain(d),
          message: `${d.message} (comments.json was not changed.)`,
        }));
    const warnings = [...deckWarnings, ...(view === "scene" ? [] : commentWarnings)];
    const extra = warnings.length > 0 ? { warnings } : {};

    if (view === "comments") {
      if (!read.ok)
        return failure(
          `comments.json is not valid, so it cannot be read. Fix the file by hand, or ask the person to: ${compact(read.diagnostics.map(plain))}`,
        );
      const { comments: items, resolved: closed, ...summary } = listComments(read.file, opened.doc, resolved);
      const shown = scene === undefined ? items : items.filter((comment) => comment.scene === scene);
      return text({ comments: { ...commentsOf(summary), resolved: closed, items: shown }, ...extra });
    }
    if (view === "outline") {
      const comments = read.ok ? { comments: commentsOf(summarize(read.file)) } : {};
      return text({ ...getOutline(opened.doc, level as Detail), ...comments, ...extra });
    }

    const found = getScene(opened.doc, scene as string, level as Detail);
    if (!found.ok) return failure(found.message);
    const here = read.ok
      ? listComments(read.file, opened.doc).comments.filter((comment) => comment.scene === scene)
      : [];
    const comments =
      read.ok && here.length > 0
        ? { comments: { rev: summarize(read.file).rev, open: here.length, items: here } }
        : {};
    return text({ ...found, ...comments, ...extra });
  }

  function comment(raw: unknown): CallToolResult {
    const parsed = applyArgs.safeParse(raw ?? {});
    if (!parsed.success) return failure(complaint(parsed.error));
    const agent = asAgent(parsed.data.ops);
    if (!agent.ok) return failure(agent.message);
    const outcome = applyCommentsToFolder(folder, agent.ops, parsed.data.base_rev);
    if (!outcome.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: compact({
              ok: false,
              code: outcome.code,
              ...(outcome.rev === undefined ? {} : { rev: outcome.rev }),
              hint: outcome.hint,
              diagnostics: outcome.diagnostics.map(plain),
            }),
          },
        ],
      };
    }
    const warnings = outcome.warnings.map(plain);
    return text({
      ok: true,
      rev: outcome.rev,
      changed: outcome.changed,
      removed: outcome.removed,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }

  function apply(raw: unknown): CallToolResult {
    const parsed = applyArgs.safeParse(raw ?? {});
    if (!parsed.success) return failure(complaint(parsed.error));
    const outcome = applyToFolder(folder, parsed.data.ops, parsed.data.base_rev);
    if (!outcome.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: compact({
              ok: false,
              code: outcome.code,
              ...(outcome.rev === undefined ? {} : { rev: outcome.rev }),
              hint: outcome.hint,
              diagnostics: outcome.diagnostics.map(plain),
            }),
          },
        ],
      };
    }
    const warnings = outcome.diagnostics.filter((d) => d.severity === "warning").map(plain);
    return text({
      ok: true,
      rev: outcome.rev,
      changed: outcome.changed,
      removed: outcome.removed,
      ...(outcome.changed.length > 0 ? { next: `Call deck_render for: ${outcome.changed.join(", ")}.` } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }

  async function render(raw: unknown): Promise<CallToolResult> {
    const parsed = renderArgs.safeParse(raw ?? {});
    if (!parsed.success) return failure(complaint(parsed.error));
    const { scene, step, width, height, screenshot, detail: level } = parsed.data;
    const result = await renderOnce((r) =>
      r.render(scene, {
        screenshot,
        ...(step === undefined ? {} : { step }),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      }),
    );
    // A warning is advice: a block pinned over another may be meant, so only an error keeps a scene from done.
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    const warnings = result.diagnostics.filter((d) => d.severity === "warning");
    const body = {
      ok: errors.length === 0,
      scene: result.scene,
      step: result.step,
      viewport: result.viewport,
      diagnostics: errors.map(plain),
      ...(warnings.length > 0 ? { warnings: warnings.map(plain) } : {}),
      ...(level === "detailed"
        ? {
            words: result.measure.words,
            content: {
              width: result.measure.view.scrollWidth,
              height: result.measure.view.scrollHeight,
            },
            blocks: result.measure.boxes.map(({ id, x, y, width: w, height: h }) => ({ id, x, y, w, h })),
          }
        : {}),
    };
    const content: CallToolResult["content"] = [];
    if (result.png)
      content.push({ type: "image", data: result.png.toString("base64"), mimeType: "image/png" });
    content.push({ type: "text", text: compact(body) });
    return { content };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] as never }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    try {
      if (name === "deck_get") return get(args);
      if (name === "deck_apply") return apply(args);
      if (name === "deck_comment") return comment(args);
      if (name === "deck_render") return await render(args);
      if (name === "deck_present") return await present.run(args);
      return failure(`There is no tool "${name}". The tools are: ${TOOL_NAMES.join(", ")}.`);
    } catch (error) {
      return failure(`${name} failed: ${(error as Error).message}`);
    }
  });

  return {
    server,
    async close() {
      present.close();
      await server.close();
      if (renderer) await (await renderer).close();
    },
  };
}
