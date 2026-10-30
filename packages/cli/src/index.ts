import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkDeckFiles, type Diagnostic, loadDoc, revisionOf } from "@depthcue/core";
import { applyToFolder, openDeck } from "./deck-api.ts";
import { loadDeckDir } from "./loader.ts";
import { openRenderer, type RenderOptions } from "./render.ts";
import { builtPlayerDir, startServer } from "./serve.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage:
  depthcue check <deck-folder> [--json]
  depthcue rev <deck-folder>
  depthcue apply <deck-folder> <ops.json> --base-rev <rev> [--json]
  depthcue serve <deck-folder> [--port <n>]
  depthcue render <deck-folder> [scene] [--out <dir>] [--step <n>] [--width <px>] [--height <px>] [--json]

check  Checks deck.json, every scene file, every reference and every asset.
rev    Prints the deck's revision, a hash of its content. Pass it back as --base-rev.
apply  Applies a list of operations as one transaction, or none of them. It is rejected
       when --base-rev is not the current revision, and the files stay untouched.

serve  Shows the deck in the player at a loopback address and reloads the page when the folder changes.
       The default port is 4173; --port 0 picks a free one.

render Renders scenes in a headless browser at the stage size (default 1280x720, controls hidden), measures
       the result, and reports overflow, clipping, overlap, text that is too small and low contrast. With
       --out it also writes one PNG per scene. It needs Chrome or Edge; set DEPTHCUE_BROWSER for another.
       Without a scene it renders them all. --step shows that many steps (default: all).

Exit codes: 0 done, 1 errors found or edit rejected, 2 could not run, 3 stale revision.`;

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

const VALUE_FLAGS = ["base-rev", "port", "out", "step", "width", "height"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

interface Parsed {
  positional: string[];
  json: boolean;
  values: Partial<Record<ValueFlag, string>>;
  unknown: string[];
}

function parse(args: readonly string[]): Parsed {
  const parsed: Parsed = { positional: [], json: false, values: {}, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") {
      parsed.json = true;
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

async function serve(folder: string, port: number, io: Io): Promise<number> {
  const diagnostics = checkDeckFiles(loadDeckDir(folder));
  const errors = count(diagnostics, "error");
  const dir = builtPlayerDir();
  if (!existsSync(join(dir, "app.js"))) {
    io.err("The player is not built. Run `pnpm build` first.");
    return 2;
  }
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ folder, playerDir: dir, port });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      io.err(`Port ${port} is in use. Pick another with --port, or --port 0 for a free one.`);
      return 2;
    }
    throw error;
  }
  io.out(`Serving ${folder} at ${server.url}`);
  if (errors > 0)
    io.out(`The deck has ${errors} error${errors === 1 ? "" : "s"}; run \`depthcue check\` for details.`);
  io.out("Edits to the folder reload the page. Press Ctrl+C to stop.");
  await new Promise<void>((done) => {
    process.once("SIGINT", () => done());
    process.once("SIGTERM", () => done());
  });
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

export function run(argv: readonly string[], io: Io): number | Promise<number> {
  const [command, ...rest] = argv;
  const { positional, json, values, unknown } = parse(rest);
  const baseRev = values["base-rev"];
  const portText = values.port;
  const port = portText === undefined ? undefined : Number(portText);
  const [folder, opsFile, ...extra] = positional;
  const renderFlags = values.out ?? values.step ?? values.width ?? values.height;
  const usage = (message?: string) => {
    io.err(message ? `${message}\n\n${USAGE}` : USAGE);
    return 2;
  };
  if (unknown.length > 0) return usage(`Unknown option ${unknown[0]}.`);
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
      command === "serve" &&
      folder &&
      opsFile === undefined &&
      !json &&
      baseRev === undefined &&
      !renderFlags
    ) {
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
        return usage("--port needs a whole number from 0 to 65535.");
      }
      return serve(folder, port ?? 4173, io).catch((error: Error) => {
        io.err(error.message);
        return 2;
      });
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
