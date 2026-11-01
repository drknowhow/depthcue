import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDeckFiles, type Diagnostic, loadDoc, revisionOf } from "@depthcue/core";
import { buildClip, ClipError, kineCommand, QUALITIES, type Quality } from "./clip.ts";
import { applyCommentsToFolder, listComments, readFolderComments } from "./comments-api.ts";
import { applyToFolder, openDeck } from "./deck-api.ts";
import { ExportError, exportDeck } from "./export.ts";
import { writeLink } from "./link.ts";
import { loadDeckDir } from "./loader.ts";
import { openRenderer, type RenderOptions } from "./render.ts";
import { builtEditorDir, builtPlayerDir, startServer } from "./serve.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage:
  depthcue check <deck-folder> [--json]
  depthcue rev <deck-folder>
  depthcue apply <deck-folder> <ops.json> --base-rev <rev> [--json]
  depthcue serve <deck-folder> [--port <n>]
  depthcue edit <deck-folder> [--port <n>]
  depthcue export <deck-folder> [--out <dir>] [--no-notes] [--json]
  depthcue render <deck-folder> [scene] [--out <dir>] [--step <n>] [--width <px>] [--height <px>] [--json]
  depthcue clip build <deck-folder> <kinescript-scene> [--name <id>] [--quality draft|standard|high]
                      [--scale <0.1-1>] [--kine <path>] [--json]
  depthcue comments list <deck-folder> [--all] [--json]
  depthcue comments apply <deck-folder> <ops.json> --base-rev <rev> [--json]

check  Checks deck.json, every scene file, every reference and every asset.
rev    Prints the deck's revision, a hash of its content. Pass it back as --base-rev.
apply  Applies a list of operations as one transaction, or none of them. It is rejected
       when --base-rev is not the current revision, and the files stay untouched.

serve  Shows the deck in the player at a loopback address and reloads the page when the folder changes.
       The default port is 4173; --port 0 picks a free one.

edit   Opens the editor at a loopback address. Changes go through the same operations an agent uses, save
       to the folder only when you ask, and a draft survives a closed tab. The deck must pass check.
       The player is at /present. Same default port as serve; keep one port to keep your drafts.

export Writes a folder that opens by double-click: index.html with the deck inside it, the player beside it
       and only the assets a scene names. It needs no server and no network, so it works from a USB stick.
       The default folder is <deck-folder name>-export here; an earlier export is replaced, any other
       folder with files in it is refused. Speaker notes go with the deck; --no-notes leaves them out.
       A deck with errors writes nothing. Exports have no presenter view yet.

render Renders scenes in a headless browser at the stage size (default 1280x720, controls hidden), measures
       the result, and reports overflow, clipping, overlap, text that is too small and low contrast. With
       --out it also writes one PNG per scene. It needs Chrome or Edge; set DEPTHCUE_BROWSER for another.
       Without a scene it renders them all. --step shows that many steps (default: all).

clip   Builds a clip from a Kinescript scene with the kine program you have installed (pip install
       kinescript; --kine or DEPTHCUE_KINE points elsewhere). It writes assets/<name>.mp4, a poster
       and a cue map, and skips the render when nothing changed. Add the result to a scene as a
       clip block. --scale 0.5 with --quality draft is the fast way to try a scene.

comments Lists the comments kept beside the deck in comments.json (the open ones; --all adds the resolved ones),
       with the ones people asked the agent to act on marked "ask". apply changes them the way apply changes
       the deck: operations all or none, against the comments' own revision, which list prints. The comments
       are never part of the deck: they do not change its revision and an export leaves them out.

Exit codes: 0 done, 1 errors found, edit rejected or a clip did not build, 2 could not run, 3 stale revision.`;

function format(diagnostic: Diagnostic): string[] {
  const where = `${diagnostic.file}${diagnostic.path}`;
  const lines = [`${where}  ${diagnostic.severity}  ${diagnostic.message}`];
  if (diagnostic.fix) lines.push(`  fix: ${diagnostic.fix}`);
  return lines;
}

const count = (diagnostics: readonly Diagnostic[], severity: Diagnostic["severity"]) =>
  diagnostics.filter((d) => d.severity === severity).length;

function summary(diagnostics: readonly Diagnostic[]): string {
  const errors = count(diagnostics, "error");
  const warnings = count(diagnostics, "warning");
  return `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

const VALUE_FLAGS = [
  "base-rev",
  "port",
  "out",
  "step",
  "width",
  "height",
  "name",
  "quality",
  "scale",
  "kine",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

interface Parsed {
  positional: string[];
  json: boolean;
  noNotes: boolean;
  all: boolean;
  values: Partial<Record<ValueFlag, string>>;
  unknown: string[];
}

function parse(args: readonly string[]): Parsed {
  const parsed: Parsed = { positional: [], json: false, noNotes: false, all: false, values: {}, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--all") {
      parsed.all = true;
      continue;
    }
    if (arg === "--no-notes") {
      parsed.noNotes = true;
      continue;
    }
    const flag = VALUE_FLAGS.find((name) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (flag) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      if (value !== undefined) parsed.values[flag] = value;
    } else if (arg.startsWith("--")) {
      parsed.unknown.push(arg);
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

function report(io: Io, diagnostics: readonly Diagnostic[], json: boolean, extra: object = {}): void {
  const errors = count(diagnostics, "error");
  if (json) {
    io.out(
      JSON.stringify(
        { ok: errors === 0, errors, warnings: count(diagnostics, "warning"), ...extra, diagnostics },
        null,
        2,
      ),
    );
  } else {
    for (const diagnostic of diagnostics) for (const line of format(diagnostic)) io.out(line);
  }
}

function check(folder: string, json: boolean, io: Io): number {
  const diagnostics = checkDeckFiles(loadDeckDir(folder));
  report(io, diagnostics, json);
  if (!json) io.out(summary(diagnostics));
  return count(diagnostics, "error") === 0 ? 0 : 1;
}

function rev(folder: string, io: Io): number {
  const { doc, diagnostics } = loadDoc(loadDeckDir(folder));
  if (!doc) {
    report(io, diagnostics, false);
    io.out(summary(diagnostics));
    return 1;
  }
  io.out(revisionOf(doc));
  return 0;
}

function apply(folder: string, opsFile: string, baseRev: string, json: boolean, io: Io): number {
  let ops: unknown;
  try {
    ops = JSON.parse(readFileSync(opsFile, "utf8"));
  } catch (error) {
    io.err(`Could not read ${opsFile} as JSON: ${(error as Error).message}`);
    return 2;
  }

  const outcome = applyToFolder(folder, ops, baseRev);
  if (!outcome.ok) {
    if (outcome.code === "changed-on-disk") {
      io.err(outcome.hint);
      return 3;
    }
    report(io, outcome.diagnostics, json, { applied: false, code: outcome.code, rev: outcome.rev });
    if (!json) {
      io.out(
        outcome.code === "unreadable-deck"
          ? summary(outcome.diagnostics)
          : `Rejected (${outcome.code}); nothing was written. ${summary(outcome.diagnostics)}`,
      );
    }
    return outcome.code === "stale-revision" ? 3 : 1;
  }
  if (json) {
    io.out(
      JSON.stringify(
        {
          ok: true,
          applied: true,
          prevRev: outcome.prevRev,
          rev: outcome.rev,
          changed: outcome.changed,
          removed: outcome.removed,
          written: outcome.written,
        },
        null,
        2,
      ),
    );
  } else {
    io.out(`Applied. Revision ${outcome.prevRev} -> ${outcome.rev}`);
    for (const path of outcome.written) io.out(`  wrote ${path}`);
  }
  return 0;
}

async function serve(folder: string, port: number, edit: boolean, io: Io): Promise<number> {
  const diagnostics = checkDeckFiles(loadDeckDir(folder));
  const errors = count(diagnostics, "error");
  const dir = builtPlayerDir();
  if (!existsSync(join(dir, "app.js"))) {
    io.err("The player is not built. Run `pnpm build` first.");
    return 2;
  }
  const editorDir = edit ? builtEditorDir() : undefined;
  if (editorDir && !existsSync(join(editorDir, "editor.js"))) {
    io.err("The editor is not built. Run `pnpm build` first.");
    return 2;
  }
  if (edit && errors > 0) {
    report(io, diagnostics, false);
    io.err("The editor needs a deck that passes `depthcue check`. Fix these first.");
    return 1;
  }
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ folder, playerDir: dir, port, ...(editorDir ? { editorDir } : {}) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      io.err(`Port ${port} is in use. Pick another with --port, or --port 0 for a free one.`);
      return 2;
    }
    throw error;
  }
  // An agent working on this folder finds the page and the secret for its lease calls through this file.
  const unlink = writeLink(folder, { url: server.url, token: server.agentToken, pid: process.pid });
  io.out(`${edit ? "Editing" : "Serving"} ${folder} at ${server.url}`);
  if (errors > 0)
    io.out(`The deck has ${errors} error${errors === 1 ? "" : "s"}; run \`depthcue check\` for details.`);
  io.out(
    edit
      ? `Present with ${server.url}present. Changes made elsewhere show up in the editor. Press Ctrl+C to stop.`
      : "Edits to the folder reload the page. Press Ctrl+C to stop.",
  );
  await new Promise<void>((done) => {
    process.once("SIGINT", () => done());
    process.once("SIGTERM", () => done());
  });
  unlink();
  await server.close();
  return 0;
}

const wholeNumber = (value: string | undefined, min: number, max: number): number | undefined | "bad" => {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : "bad";
};

async function renderCommand(
  folder: string,
  scene: string | undefined,
  options: RenderOptions,
  out: string | undefined,
  json: boolean,
  io: Io,
): Promise<number> {
  const opened = openDeck(folder);
  if (!opened.ok) {
    report(io, opened.diagnostics, json);
    if (!json) io.out(summary(opened.diagnostics));
    return 1;
  }
  const ids = scene ? [scene] : opened.doc.deck.scenes;
  const renderer = await openRenderer(folder);
  const found: Diagnostic[] = [];
  const rows: Array<{ scene: string; step: number; screenshot?: string; errors: number }> = [];
  try {
    if (out) mkdirSync(out, { recursive: true });
    for (const id of ids) {
      const result = await renderer.render(id, { ...options, screenshot: out !== undefined });
      found.push(...result.diagnostics);
      const row: (typeof rows)[number] = { scene: id, step: result.step, errors: result.diagnostics.length };
      if (out && result.png) {
        row.screenshot = join(out, `${id}.png`);
        writeFileSync(row.screenshot, result.png);
      }
      rows.push(row);
      if (!json) {
        io.out(`${row.errors === 0 ? "ok  " : "FAIL"} ${id}${row.screenshot ? `  ${row.screenshot}` : ""}`);
        for (const diagnostic of result.diagnostics)
          for (const line of format(diagnostic)) io.out(`  ${line}`);
      }
    }
  } finally {
    await renderer.close();
  }
  const errors = count(found, "error");
  if (json) report(io, found, true, { scenes: rows });
  else io.out(`${ids.length} scene${ids.length === 1 ? "" : "s"} rendered, ${summary(found)}`);
  return errors === 0 ? 0 : 1;
}

interface ClipRequest {
  folder: string;
  scene: string;
  name: string | undefined;
  quality: Quality | undefined;
  scale: number | undefined;
  kine: readonly string[];
}

/** Builds a clip and tells the person, or a program reading --json, what was written. */
async function clipBuildCommand(request: ClipRequest, json: boolean, io: Io): Promise<number> {
  if (!existsSync(join(request.folder, "deck.json"))) {
    io.err(`${request.folder} is not a deck folder: it has no deck.json.`);
    return 2;
  }
  const stop = new AbortController();
  const onInterrupt = () => stop.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const built = await buildClip({
      folder: request.folder,
      scene: request.scene,
      kine: request.kine,
      signal: stop.signal,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.quality === undefined ? {} : { quality: request.quality }),
      ...(request.scale === undefined ? {} : { scale: request.scale }),
    });
    if (json) {
      io.out(JSON.stringify({ ok: true, ...built, seconds: Number(built.seconds.toFixed(2)) }, null, 2));
    } else if (built.built) {
      io.out(
        `Built ${built.source}: ${built.duration} s, ${built.width}x${built.height}, ${built.cueCount} cue${built.cueCount === 1 ? "" : "s"}, ${built.seconds.toFixed(1)} s with ${built.kinescript}.`,
      );
      io.out(`  poster ${built.poster}`);
      io.out(`  cues   ${built.cues}`);
    } else {
      io.out(`Up to date: ${built.source}. Nothing was rebuilt.`);
    }
    if (!json) {
      io.out(
        `Add it to a scene as a block: ${JSON.stringify({ type: "clip", source: built.source, poster: built.poster, alt: "..." })}`,
      );
    }
    return 0;
  } catch (error) {
    if (!(error instanceof ClipError)) throw error;
    if (json) io.out(JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2));
    else io.err(error.message);
    return error.code === "kine-failed" ? 1 : 2;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Writes the folder that opens by double-click, and says what went into it. */
function exportCommand(
  folder: string,
  out: string | undefined,
  notes: boolean,
  json: boolean,
  io: Io,
): number {
  try {
    const result = exportDeck({ folder, notes, ...(out === undefined ? {} : { out }) });
    if (!result.ok) {
      report(io, result.diagnostics, json, { code: "deck-invalid" });
      if (!json) {
        io.out(summary(result.diagnostics));
        io.out("Nothing was exported. Fix the errors and run it again.");
      }
      return 1;
    }
    const done = result.summary;
    if (json) {
      const { warnings, ...rest } = done;
      report(io, warnings, true, rest);
      return 0;
    }
    for (const diagnostic of done.warnings) for (const line of format(diagnostic)) io.out(line);
    io.out(`Exported ${plural(done.scenes, "scene")} to ${done.out}`);
    io.out(`  open ${done.index}`);
    io.out(
      `  ${plural(done.files, "file")}, ${kilobytes(done.bytes)}: ${plural(done.assets.length, "asset")}, ${plural(done.cueMaps.length, "cue map")}, notes ${done.notes ? "kept" : "left out"}`,
    );
    if (done.skipped.length > 0) {
      io.out(`  left out because no scene names them: ${done.skipped.join(", ")}`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof ExportError)) throw error;
    if (json) io.out(JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2));
    else io.err(error.message);
    return 2;
  }
}

/** Lists the comments, so a person or a program can see what is open and what the agent has been asked to do. */
function commentsListCommand(folder: string, all: boolean, json: boolean, io: Io): number {
  const read = readFolderComments(folder);
  if (!read.ok) {
    report(io, read.diagnostics, json, { code: read.code });
    if (!json) io.out(summary(read.diagnostics));
    return 1;
  }
  const list = listComments(read.file, read.doc, all);
  if (json) {
    report(io, read.warnings, true, list);
    return 0;
  }
  const asked = new Set(list.tasks.map((task) => task.id));
  io.out(
    `Comments revision ${list.rev}: ${plural(list.open, "open comment")}, ${list.resolved} resolved. ${plural(list.tasks.length, "task")} for the agent.`,
  );
  for (const item of list.comments) {
    const flags = [
      item.resolved ? "resolved" : "open",
      ...(item.ask === true ? [asked.has(item.id) ? "ask, waiting for the agent" : "ask"] : []),
      ...(item.orphaned === true ? ["its block is gone"] : []),
    ];
    io.out(`${item.id}  ${item.scene}/${item.block}  ${flags.join(", ")}`);
    for (const message of item.thread) io.out(`  ${message.author}  ${message.text}`);
  }
  for (const diagnostic of read.warnings) for (const line of format(diagnostic)) io.out(line);
  return 0;
}

/** Applies comment operations from a file, all or none, and says what changed. */
function commentsApplyCommand(
  folder: string,
  opsFile: string,
  baseRev: string,
  json: boolean,
  io: Io,
): number {
  let ops: unknown;
  try {
    ops = JSON.parse(readFileSync(opsFile, "utf8"));
  } catch (error) {
    io.err(`Could not read ${opsFile} as JSON: ${(error as Error).message}`);
    return 2;
  }
  const outcome = applyCommentsToFolder(folder, ops, baseRev);
  if (!outcome.ok) {
    if (json) {
      io.out(
        JSON.stringify(
          {
            ok: false,
            applied: false,
            code: outcome.code,
            ...(outcome.rev === undefined ? {} : { rev: outcome.rev }),
            hint: outcome.hint,
            diagnostics: outcome.diagnostics,
          },
          null,
          2,
        ),
      );
    } else {
      for (const diagnostic of outcome.diagnostics) for (const line of format(diagnostic)) io.out(line);
      io.err(`Rejected (${outcome.code}); nothing was written. ${outcome.hint}`);
    }
    return outcome.code === "stale-revision" || outcome.code === "changed-on-disk" ? 3 : 1;
  }
  if (json) {
    io.out(
      JSON.stringify(
        {
          ok: true,
          applied: true,
          prevRev: outcome.prevRev,
          rev: outcome.rev,
          changed: outcome.changed,
          removed: outcome.removed,
          warnings: outcome.warnings,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(
    outcome.prevRev === outcome.rev
      ? `Applied. Nothing changed; the comments stay at revision ${outcome.rev}.`
      : `Applied. Comments revision ${outcome.prevRev} -> ${outcome.rev}`,
  );
  if (outcome.changed.length > 0) io.out(`  changed ${outcome.changed.join(", ")}`);
  if (outcome.removed.length > 0) io.out(`  removed ${outcome.removed.join(", ")}`);
  for (const diagnostic of outcome.warnings) for (const line of format(diagnostic)) io.out(line);
  return 0;
}

/** Test seams: the command that runs Kinescript, so a stand-in can be used where it is not installed. */
export interface RunOptions {
  kine?: readonly string[];
}

export function run(argv: readonly string[], io: Io, options: RunOptions = {}): number | Promise<number> {
  const [command, ...rest] = argv;
  const { positional, json, noNotes, all, values, unknown } = parse(rest);
  const baseRev = values["base-rev"];
  const portText = values.port;
  const port = portText === undefined ? undefined : Number(portText);
  const [folder, opsFile, ...extra] = positional;
  const renderFlags = values.out ?? values.step ?? values.width ?? values.height;
  const clipFlags = values.name ?? values.quality ?? values.scale ?? values.kine;
  const usage = (message?: string) => {
    io.err(message ? `${message}\n\n${USAGE}` : USAGE);
    return 2;
  };
  if (unknown.length > 0) return usage(`Unknown option ${unknown[0]}.`);
  if (noNotes && command !== "export") return usage("--no-notes belongs to export.");
  if (all && command !== "comments") return usage("--all belongs to comments list.");

  if (command === "clip") {
    const [sub, clipFolder, scene, ...more] = positional;
    if (sub !== "build") return usage("clip needs a subcommand. The one there is: clip build.");
    if (!clipFolder || !scene) return usage("clip build needs a deck folder and a Kinescript scene file.");
    if (more.length > 0) return usage(`Unexpected argument ${more[0]}.`);
    if (baseRev !== undefined || portText !== undefined || renderFlags !== undefined) {
      return usage("clip build takes --name, --quality, --scale, --kine and --json.");
    }
    const quality = values.quality;
    if (quality !== undefined && !(QUALITIES as readonly string[]).includes(quality)) {
      return usage(`--quality is one of ${QUALITIES.join(", ")}.`);
    }
    const scale = values.scale === undefined ? undefined : Number(values.scale);
    if (scale !== undefined && !(scale >= 0.1 && scale <= 1)) {
      return usage("--scale needs a number from 0.1 to 1.");
    }
    return clipBuildCommand(
      {
        folder: clipFolder,
        scene,
        name: values.name,
        quality: quality as Quality | undefined,
        scale,
        kine: options.kine ?? kineCommand(values.kine),
      },
      json,
      io,
    ).catch((error: Error) => {
      io.err(error.message);
      return 2;
    });
  }
  if (clipFlags !== undefined) return usage("--name, --quality, --scale and --kine belong to clip build.");
  if (command === "comments") {
    const [sub, commentsFolder, commentsOps, ...more] = positional;
    if (sub !== "list" && sub !== "apply") {
      return usage("comments needs a subcommand: comments list or comments apply.");
    }
    if (!commentsFolder) return usage(`comments ${sub} needs a deck folder.`);
    if (portText !== undefined || renderFlags !== undefined) {
      return usage(`comments ${sub} does not take that option.`);
    }
    if (sub === "list") {
      if (commentsOps !== undefined || baseRev !== undefined)
        return usage("comments list takes a deck folder, --all and --json.");
      return commentsListCommand(commentsFolder, all, json, io);
    }
    if (all) return usage("--all belongs to comments list.");
    if (more.length > 0) return usage(`Unexpected argument ${more[0]}.`);
    if (!commentsOps) return usage("comments apply needs a deck folder and an operations file.");
    if (baseRev === undefined) {
      return usage(
        "comments apply needs --base-rev, the comments revision you read. Get it with: depthcue comments list <deck-folder>",
      );
    }
    return commentsApplyCommand(commentsFolder, commentsOps, baseRev, json, io);
  }
  if (extra.length > 0) return usage(`Unexpected argument ${extra[0]}.`);

  try {
    if (command === "check" && folder && opsFile === undefined && baseRev === undefined && !renderFlags) {
      return check(folder, json, io);
    }
    if (
      command === "rev" &&
      folder &&
      opsFile === undefined &&
      !json &&
      baseRev === undefined &&
      !renderFlags
    ) {
      return rev(folder, io);
    }
    if (
      (command === "serve" || command === "edit") &&
      folder &&
      opsFile === undefined &&
      !json &&
      baseRev === undefined &&
      !renderFlags
    ) {
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
        return usage("--port needs a whole number from 0 to 65535.");
      }
      return serve(folder, port ?? 4173, command === "edit", io).catch((error: Error) => {
        io.err(error.message);
        return 2;
      });
    }
    if (
      command === "export" &&
      folder &&
      opsFile === undefined &&
      baseRev === undefined &&
      port === undefined &&
      values.step === undefined &&
      values.width === undefined &&
      values.height === undefined
    ) {
      return exportCommand(folder, values.out, !noNotes, json, io);
    }
    if (command === "render" && folder && baseRev === undefined && port === undefined) {
      const step = wholeNumber(values.step, 0, 100);
      const width = wholeNumber(values.width, 160, 7680);
      const height = wholeNumber(values.height, 90, 4320);
      if (step === "bad") return usage("--step needs a whole number from 0 to 100.");
      if (width === "bad") return usage("--width needs a whole number from 160 to 7680.");
      if (height === "bad") return usage("--height needs a whole number from 90 to 4320.");
      const options: RenderOptions = {
        ...(step === undefined ? {} : { step }),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
      };
      return renderCommand(folder, opsFile, options, values.out, json, io).catch((error: Error) => {
        io.err(error.message);
        return 2;
      });
    }
    if (command === "apply" && folder && opsFile && !renderFlags) {
      if (baseRev === undefined) {
        return usage(
          "apply needs --base-rev, the revision you read. Get it with: depthcue rev <deck-folder>",
        );
      }
      return apply(folder, opsFile, baseRev, json, io);
    }
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  return usage();
}
