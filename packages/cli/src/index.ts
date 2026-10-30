import { readFileSync } from "node:fs";
import { applyOps, checkDeckFiles, type Diagnostic, loadDoc, revisionOf } from "@depthcue/core";
import { loadDeckDir } from "./loader.ts";
import { ChangedOnDiskError, saveDeckDir } from "./save.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage:
  depthcue check <deck-folder> [--json]
  depthcue rev <deck-folder>
  depthcue apply <deck-folder> <ops.json> --base-rev <rev> [--json]

check  Checks deck.json, every scene file, every reference and every asset.
rev    Prints the deck's revision, a hash of its content. Pass it back as --base-rev.
apply  Applies a list of operations as one transaction, or none of them. It is rejected
       when --base-rev is not the current revision, and the files stay untouched.

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
  unknown: string[];
}

function parse(args: readonly string[]): Parsed {
  const parsed: Parsed = { positional: [], json: false, baseRev: undefined, unknown: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--base-rev") parsed.baseRev = args[++i];
    else if (arg.startsWith("--base-rev=")) parsed.baseRev = arg.slice("--base-rev=".length);
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

export function run(argv: readonly string[], io: Io): number {
  const [command, ...rest] = argv;
  const { positional, json, baseRev, unknown } = parse(rest);
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
