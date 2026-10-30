import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { applyOps, checkDeckFiles, type Diagnostic, loadDoc, revisionOf } from "@depthcue/core";
import { loadDeckDir } from "./loader.ts";
import { ChangedOnDiskError, saveDeckDir } from "./save.ts";
import { startServer } from "./serve.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage:
  depthcue check <deck-folder> [--json]
  depthcue rev <deck-folder>
  depthcue apply <deck-folder> <ops.json> --base-rev <rev> [--json]
  depthcue serve <deck-folder> [--port <n>]

check  Checks deck.json, every scene file, every reference and every asset.
rev    Prints the deck's revision, a hash of its content. Pass it back as --base-rev.
apply  Applies a list of operations as one transaction, or none of them. It is rejected
       when --base-rev is not the current revision, and the files stay untouched.

serve  Shows the deck in the player at a loopback address and reloads the page when the folder changes.
       The default port is 4173; --port 0 picks a free one.

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

interface Parsed {
  positional: string[];
  json: boolean;
  baseRev: string | undefined;
  port: number | undefined;
  unknown: string[];
}

function parse(args: readonly string[]): Parsed {
  const parsed: Parsed = { positional: [], json: false, baseRev: undefined, port: undefined, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--base-rev") parsed.baseRev = args[++i];
    else if (arg.startsWith("--base-rev=")) parsed.baseRev = arg.slice("--base-rev=".length);
    else if (arg === "--port") parsed.port = Number(args[++i]);
    else if (arg.startsWith("--port=")) parsed.port = Number(arg.slice("--port=".length));
    else if (arg.startsWith("--")) parsed.unknown.push(arg);
    else parsed.positional.push(arg);
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
  const { doc, diagnostics: loadDiagnostics } = loadDoc(loadDeckDir(folder));
  if (!doc) {
    report(io, loadDiagnostics, json);
    if (!json) io.out(summary(loadDiagnostics));
    return 1;
  }
  let ops: unknown;
  try {
    ops = JSON.parse(readFileSync(opsFile, "utf8"));
  } catch (error) {
    io.err(`Could not read ${opsFile} as JSON: ${(error as Error).message}`);
    return 2;
  }

  const result = applyOps(doc, ops, baseRev);
  if (!result.ok) {
    report(io, result.diagnostics, json, { applied: false, code: result.code, rev: result.rev });
    if (!json) io.out(`Rejected (${result.code}); nothing was written. ${summary(result.diagnostics)}`);
    return result.code === "stale-revision" ? 3 : 1;
  }

  let written: string[] = [];
  try {
    written = saveDeckDir(folder, doc, result.doc);
  } catch (error) {
    if (error instanceof ChangedOnDiskError) {
      io.err(error.message);
      return 3;
    }
    throw error;
  }
  if (json) {
    io.out(
      JSON.stringify(
        {
          ok: true,
          applied: true,
          prevRev: result.prevRev,
          rev: result.rev,
          changed: result.changed,
          removed: result.removed,
          written,
        },
        null,
        2,
      ),
    );
  } else {
    io.out(`Applied. Revision ${result.prevRev} -> ${result.rev}`);
    for (const path of written) io.out(`  wrote ${path}`);
  }
  return 0;
}

function playerDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@depthcue/player/package.json")), "dist");
}

async function serve(folder: string, port: number, io: Io): Promise<number> {
  const diagnostics = checkDeckFiles(loadDeckDir(folder));
  const errors = count(diagnostics, "error");
  const dir = playerDir();
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

export function run(argv: readonly string[], io: Io): number | Promise<number> {
  const [command, ...rest] = argv;
  const { positional, json, baseRev, port, unknown } = parse(rest);
  const [folder, opsFile, ...extra] = positional;
  const usage = (message?: string) => {
    io.err(message ? `${message}\n\n${USAGE}` : USAGE);
    return 2;
  };
  if (unknown.length > 0) return usage(`Unknown option ${unknown[0]}.`);
  if (extra.length > 0) return usage(`Unexpected argument ${extra[0]}.`);

  try {
    if (command === "check" && folder && opsFile === undefined && baseRev === undefined) {
      return check(folder, json, io);
    }
    if (command === "rev" && folder && opsFile === undefined && !json && baseRev === undefined) {
      return rev(folder, io);
    }
    if (command === "serve" && folder && opsFile === undefined && !json && baseRev === undefined) {
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
        return usage("--port needs a whole number from 0 to 65535.");
      }
      return serve(folder, port ?? 4173, io).catch((error: Error) => {
        io.err(error.message);
        return 2;
      });
    }
    if (command === "apply" && folder && opsFile) {
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
