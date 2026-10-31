import { applyToFolder, type Detail, getOutline, getScene, openDeck } from "@depthcue/cli/deck-api";
import { openRenderer, type Renderer, type SceneRender } from "@depthcue/cli/render";
import { type Diagnostic, opsSchema } from "@depthcue/core";
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
    .enum(["outline", "scene"])
    .default("outline")
    .describe("outline lists the scenes; scene returns one."),
  scene: z.string().optional().describe("Scene id. Required when view is scene."),
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

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

const TOOLS = [
  {
    name: "deck_get",
    description:
      "Read the deck. view 'outline' (default) lists every scene with its id, title, layout, lead, block count and step count, and returns `rev`, the deck revision to pass to deck_apply as base_rev. view 'scene' returns one scene's full JSON. Use detail 'detailed' for block lists, per-scene revisions, and the asset list.",
    inputSchema: jsonSchema(getArgs),
    annotations: { title: "Read the deck", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "deck_apply",
    description:
      "Edit the deck. Applies `ops` atomically against `base_rev`, the `rev` from deck_get or your last deck_apply. If any op is invalid or base_rev is stale, nothing is written and the reply says how to fix it; a stale revision is never merged: read again and redo. `set` replaces each key it names whole: send whole arrays (chart data, steps). null deletes an optional key. deck.set keys: title, language, theme, modules. scene.set keys: title, layout, lead, summary, sources, reading, steps, notes. scene.add and block.add take a whole scene or block. `after` is a sibling id, null for first, omitted for last. Ids never change: add the new item, remove the old. Then deck_render changed scenes.",
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
    name: "deck_render",
    description:
      "Render one scene at the stage size in a real browser, with fonts loaded and motion off, then measure it. Returns a PNG and diagnostics for overflow, clipping, overlap, text under the minimum size, low contrast, and images that failed to load. Each diagnostic names a `path` into the scene JSON and a `fix`. Repair order: shorten the text, pick a roomier template, split the scene. Nothing is scaled down to fit. A scene is done when its diagnostics are empty.",
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
 * An MCP server over one deck folder. Four tools, because every tool an agent can see costs it tokens on every
 * turn: deck_get reads, deck_apply edits, deck_render checks the result with a screenshot and measurements,
 * deck_present drives the deck while the presenter has handed over control.
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
    const { view, scene, detail: level } = parsed.data;
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
    const warnings = opened.diagnostics.filter((d) => d.severity === "warning").map(plain);
    const extra = warnings.length > 0 ? { warnings } : {};
    if (view === "outline") return text({ ...getOutline(opened.doc, level as Detail), ...extra });

    const found = getScene(opened.doc, scene as string, level as Detail);
    return found.ok ? text({ ...found, ...extra }) : failure(found.message);
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
    const body = {
      ok: result.diagnostics.length === 0,
      scene: result.scene,
      step: result.step,
      viewport: result.viewport,
      diagnostics: result.diagnostics.map(plain),
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
