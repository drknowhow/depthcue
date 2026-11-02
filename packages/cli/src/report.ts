/** How the command line reports diagnostics, as lines for a person or as JSON. Shared by `index.ts` and the brand commands. */
import type { Diagnostic } from "@depthcue/core";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export function format(diagnostic: Diagnostic): string[] {
  const where = `${diagnostic.file}${diagnostic.path}`;
  const lines = [`${where}  ${diagnostic.severity}  ${diagnostic.message}`];
  if (diagnostic.fix) lines.push(`  fix: ${diagnostic.fix}`);
  return lines;
}

export const count = (diagnostics: readonly Diagnostic[], severity: Diagnostic["severity"]) =>
  diagnostics.filter((d) => d.severity === severity).length;

export function summary(diagnostics: readonly Diagnostic[]): string {
  const errors = count(diagnostics, "error");
  const warnings = count(diagnostics, "warning");
  return `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

export function report(io: Io, diagnostics: readonly Diagnostic[], json: boolean, extra: object = {}): void {
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
