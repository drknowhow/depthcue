import { isAbsolute } from "node:path";
import {
  applyCommentsToFolder,
  type CommentSummary,
  listComments,
  readCommentsFor,
  summarize,
} from "@depthcue/cli/comments-api";
import { applyToFolder, type Detail, getOutline, getScene, openDeck } from "@depthcue/cli/deck-api";
import {
  addImage,
  ImageRefused,
  listImages,
  MAX_ASSET_BYTES,
  readImageFile,
  removeImage,
} from "@depthcue/cli/images";
import { openRenderer, type Renderer, type SceneRender } from "@depthcue/cli/render";
import { commentOpsSchema, type Diagnostic, ID_PATTERN, opsSchema } from "@depthcue/core";
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

const exportArgs = z.strictObject({
  out: z.string().min(1).describe("Absolute path of the .pptx file, or of the folder."),
  format: z.enum(["pptx", "folder"]).default("pptx"),
  notes: z.boolean().default(true).describe("false leaves speaker notes out."),
  pictures: z.boolean().default(false).describe("pptx: each slide one picture."),
  steps: z.boolean().default(false).describe("pptx: a slide per build step."),
  posters: z.boolean().default(false).describe("pptx: clips as poster and link."),
});

const assetArgs = z.strictObject({
  action: z.enum(["add", "list", "remove"]),
  path: z.string().min(1).optional().describe("add: absolute path of a local image file."),
  data: z
    .string()
    .max(Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 8)
    .optional()
    .describe("add: the image bytes as base64, with `name`. Use path for a file on disk."),
  name: z.string().min(1).max(200).optional().describe("add with data: what to call the file."),
  asset: z
    .string()
    .min(1)
    .optional()
    .describe("remove: the path from add or list, such as assets/x-1a2b3c4d.png."),
});

/**
 * The ops schema as deck_apply carries it: without its document-level keys, so it can sit inside a tool schema, and
 * without what the tool list cannot afford to repeat on every turn and the core checks anyway when the operations run:
 * the id pattern on every id (a wrong id is refused with the pattern in the message), and each operation's
 * `type: "object"`, which `items` already says. Nothing else is left out (see the test that compares the two).
 */
export const opsForTools = (() => {
  const {
    $schema: _dialect,
    $id: _id,
    title: _title,
    ...body
  } = JSON.parse(JSON.stringify(opsSchema)) as {
    items: { oneOf: Array<Record<string, unknown>> };
  } & Record<string, unknown>;
  const strip = (node: unknown): void => {
    if (Array.isArray(node)) for (const item of node) strip(item);
    else if (typeof node === "object" && node !== null) {
      const record = node as Record<string, unknown>;
      if (record.pattern === ID_PATTERN) delete record.pattern;
      for (const value of Object.values(record)) strip(value);
    }
  };
  strip(body.items);
  for (const variant of body.items.oneOf) delete variant.type;
  return body;
})();

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
      "Read the deck. view 'outline' (default): `rev` (base_rev for deck_apply), scenes (id, title, layout or template, lead, counts), `comments` (open count, tasks), `templates` (id, name), `styles` (ids), `brand`; detailed adds slots. view 'scene' adds a scene's open comments, view 'comments' all comments. A block's `frame` {x,y,w,h} pins it: percent of the 16:9 slide, x+w and y+h within 100. Template scene blocks name a `slot`; `style` names a style for the block's kind. 0.3+ text is markup: **bold**, *italic*, [label](https: or mailto: URL), [label]{tone}, \\ escapes, `- ` or `1. ` body lines; other strings are literal. Text takes tone (text, muted, action, evidence), size (s-xl), align (start, center, end). table and chart hold `columns`, `rows`; a chart's first column is its categories. palette colors are #rrggbb. An image takes fit (contain|cover), crop {x,y,w,h} (percent of the file: the part shown), focus {x,y} and decorative (true: alt optional); a scene's background is {asset, scrim, color, focus, decorative, alt}.",
    inputSchema: jsonSchema(getArgs),
    annotations: { title: "Read the deck", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "deck_apply",
    description:
      "Edit the deck: `ops` apply atomically against `base_rev`, the `rev` from deck_get or your last edit. A bad op or stale base_rev writes nothing; read again and redo. `set` replaces each key it names whole (send whole arrays); null deletes one. deck.set keys: title, language, theme, palette, fonts, modules. scene.set keys: title, layout, template, background, lead, summary, sources, reading, steps, notes, voiceover. scene.add and block.add take a whole scene or block. `after`: sibling id, null first, omitted last. block.frame and block.unframe pin and unpin a block. scene.upgrade makes a scene 0.3, escaping its text. To swap layout and template: set one, null the other, block.set each `slot`. brand.set makes ({id, name}) or edits the brand. style.set and template.set take one whole (null removes it) or `set`. slot.add/set/rename/remove edit a brand template's slots (not a built-in's); rename and remove (`to` a slot, null pins) move its blocks in every scene. link.add/set/remove edit the deck's links; link.remove `to` moves uses. Other ids never change.",
    inputSchema: {
      type: "object",
      properties: {
        base_rev: { type: "string", description: "The deck revision you read. Get it from deck_get." },
        ops: { ...opsForTools, description: "Applied in order, all or none." },
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
      "Leave and answer comments on the deck's blocks. They are kept beside the deck, never in it. deck_get returns `comments.rev`, the base_rev to pass here, and `comments.tasks`, which people asked you to act on. Operations apply together or not at all. For a task: reply, make the change with deck_apply, then resolve it. You write as the agent, so leave author out. You cannot delete. `anchor` is where on the block the comment points, as fractions from 0 to 1 from its top left; add `w` and `h` (both, each above 0, with x+w and y+h at most 1) to mark an area that starts there, as a person does by dragging. A stale base_rev is rejected, never merged: read again and redo.",
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
  {
    name: "deck_asset",
    description:
      "Add, list or remove the deck's image files. add: `path` (absolute; a regular PNG, JPEG, GIF, WebP or plain SVG file up to 15 MB) or `data` (base64) with `name`. It returns `asset` (such as assets/x-1a2b3c4d.png), width, height and bytes; put `asset` in an image block with deck_apply. The same file added twice gives the same path. list: every image with width, height, bytes and `usedBy` (empty means unused). remove: `asset`, refused while anything names it. None of these changes the deck revision.",
    inputSchema: jsonSchema(assetArgs),
    annotations: {
      title: "Add images to the deck",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "deck_export",
    description:
      "Write the deck for people: format 'pptx', a PowerPoint file (text, tables, charts editable; a brand's master, layouts and fonts), or 'folder', a page that opens offline. Never replaces what the export did not write or what changed since. A deck with errors writes nothing. Returns what each slide could not carry over.",
    inputSchema: jsonSchema(exportArgs),
    annotations: {
      title: "Export the deck",
      readOnlyHint: false,
      // It replaces an earlier export of its own, and the folder export removes the files that one had and this lacks.
      destructiveHint: true,
      idempotentHint: true,
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
 * An MCP server over one deck folder. Seven tools, because every tool an agent can see costs it tokens on every
 * turn: deck_get reads, deck_apply edits, deck_comment answers the person's comments, deck_render checks the result
 * with a screenshot and measurements, deck_present drives the deck while the presenter has handed over control, and
 * deck_asset adds, lists and removes image files, and deck_export writes the PowerPoint file or the offline page. The browser starts on the first render and is kept
 * until `close()`; an export starts its own.
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

  function asset(raw: unknown): CallToolResult {
    const parsed = assetArgs.safeParse(raw ?? {});
    if (!parsed.success) return failure(complaint(parsed.error));
    const { action, path, data, name, asset: target } = parsed.data;
    const allowed: readonly string[] =
      action === "add" ? ["path", "data", "name"] : action === "remove" ? ["asset"] : [];
    const stray = Object.entries({ path, data, name, asset: target }).find(
      ([key, value]) => value !== undefined && !allowed.includes(key),
    );
    if (stray) return failure(`${action} does not take \`${stray[0]}\`.`);
    if (action === "add") {
      if ((path === undefined) === (data === undefined)) {
        return failure("add needs exactly one of `path` or `data`.");
      }
      if (data !== undefined && name === undefined) return failure("add with `data` needs `name`.");
      if (path !== undefined && name !== undefined) {
        return failure("`name` goes with `data`; a file keeps its own name.");
      }
      try {
        const read =
          path !== undefined
            ? readImageFile(path)
            : { bytes: Buffer.from(data as string, "base64"), name: name as string };
        return text({ ok: true, ...addImage(folder, read.bytes, read.name) });
      } catch (error) {
        if (error instanceof ImageRefused) return failure(`${error.message} (${error.code})`);
        throw error;
      }
    }
    const opened = openDeck(folder);
    if (!opened.ok) {
      return failure(
        `The deck has errors, so its images cannot be read. Fix these first: ${compact(opened.diagnostics.filter((d) => d.severity === "error").map(plain))}`,
      );
    }
    if (action === "list") return text({ ok: true, assets: listImages(folder, opened.doc) });
    if (target === undefined) return failure("remove needs `asset`.");
    const outcome = removeImage(folder, opened.doc, target);
    return outcome.ok ? text(outcome) : failure(compact(outcome));
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

  /**
   * Writes the PowerPoint file or the offline page where the caller says, one export at a time, after any render. The
   * export modules load on the first call, so a server that never exports never loads the PowerPoint writer.
   */
  async function exported(raw: unknown): Promise<CallToolResult> {
    const parsed = exportArgs.safeParse(raw ?? {});
    if (!parsed.success) return failure(complaint(parsed.error));
    const { out, format, notes, pictures, steps, posters } = parsed.data;
    if (!isAbsolute(out)) return failure(`\`out\` must be an absolute path, and ${out} is not.`);
    // A network share: writing there would also sign in to whatever server the path names. A local device path
    // (\\?\C:\...) is a path on this machine and is allowed.
    if (/^[\\/]{2}/.test(out) && !/^[\\/]{2}[?.][\\/][a-z]:[\\/]/i.test(out)) {
      return failure(
        `\`out\` is on a network share (${out}). Export to a folder on this machine, and copy the result there.`,
      );
    }
    if (format === "folder" && (pictures || steps || posters)) {
      return failure(
        "pictures, steps and posters are for format pptx; the folder export shows the deck as it is.",
      );
    }
    const invalid = (diagnostics: readonly Diagnostic[]) =>
      failure(
        `The deck has errors, so nothing was written. Fix them with deck_apply and export again: ${compact(diagnostics.filter((d) => d.severity === "error").map(plain))}`,
      );
    const run = queue.then(async (): Promise<CallToolResult> => {
      if (format === "folder") {
        const { ExportError, exportDeck } = await import("@depthcue/cli/export");
        try {
          const result = exportDeck({ folder, out, notes });
          if (!result.ok) return invalid(result.diagnostics);
          const { warnings, ...summary } = result.summary;
          return text({
            ok: true,
            format,
            ...summary,
            ...(warnings.length > 0 ? { warnings: warnings.map(plain) } : {}),
          });
        } catch (error) {
          if (error instanceof ExportError)
            return failure(compact({ ok: false, code: error.code, message: error.message }));
          throw error;
        }
      }
      const { exportPptx, PptxError } = await import("@depthcue/cli/pptx");
      try {
        const result = await exportPptx({ folder, out, notes, pictures, steps, posters });
        if (!result.ok) return invalid(result.diagnostics);
        const done = result.summary;
        return text({
          ok: true,
          format,
          out: done.out,
          bytes: done.bytes,
          ...(done.layouts.length > 0 ? { layouts: done.layouts } : {}),
          slides: done.slides.map((slide) => ({
            scene: slide.scene,
            ...(slide.step === undefined ? {} : { step: slide.step }),
            ...(slide.left.length > 0 ? { left: slide.left } : {}),
          })),
          fonts: done.fonts.map((font) => ({
            family: font.family,
            ...(font.roles.length > 0 ? { roles: font.roles } : {}),
            ...(font.as === undefined ? {} : { as: font.as }),
            embedded: font.embedded,
            ...(font.notes.length > 0 ? { notes: font.notes } : {}),
          })),
          deck: done.deck,
          ...(done.warnings.length > 0 ? { warnings: done.warnings.map(plain) } : {}),
        });
      } catch (error) {
        if (error instanceof PptxError)
          return failure(compact({ ok: false, code: error.code, message: error.message }));
        throw error;
      }
    });
    queue = run.catch(() => undefined);
    return run;
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
      if (name === "deck_asset") return asset(args);
      if (name === "deck_export") return await exported(args);
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
