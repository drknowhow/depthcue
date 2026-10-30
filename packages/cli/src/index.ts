import { checkDeckFiles, type Diagnostic } from "@depthcue/core";
import { loadDeckDir } from "./loader.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage: depthcue check <deck-folder> [--json]

Checks deck.json, every scene file and every asset reference.
Exit codes: 0 clean (warnings allowed), 1 errors found, 2 could not run.`;

function format(diagnostic: Diagnostic): string[] {
  const where = `${diagnostic.file}${diagnostic.path}`;
  const lines = [`${where}  ${diagnostic.severity}  ${diagnostic.message}`];
  if (diagnostic.fix) lines.push(`  fix: ${diagnostic.fix}`);
  return lines;
}

export function run(argv: readonly string[], io: Io): number {
  const [command, folder, ...flags] = argv;
  if (command !== "check" || !folder || flags.some((flag) => flag !== "--json")) {
    io.err(USAGE);
    return 2;
  }
  let diagnostics: Diagnostic[];
  try {
    diagnostics = checkDeckFiles(loadDeckDir(folder));
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  if (flags.includes("--json")) {
    io.out(JSON.stringify({ ok: errors === 0, errors, warnings, diagnostics }, null, 2));
  } else {
    for (const diagnostic of diagnostics) for (const line of format(diagnostic)) io.out(line);
    io.out(`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
  }
  return errors === 0 ? 0 : 1;
}
