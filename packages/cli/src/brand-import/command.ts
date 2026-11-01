/**
 * The `depthcue brand import` command: runs the import and says what it took and what it left out, as lines for a
 * person or as data for a program (`--json`). Exit codes: 0 done, 1 the file has no theme or no usable layout, 2 the file
 * could not be read or the folder could not be written.
 */
import type { Diagnostic } from "@depthcue/core";
import type { Io } from "../index.ts";
import { ImportError, type ImportReport, importBrand } from "./index.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const slotLine = (slot: ImportReport["templates"][number]["slots"][number]): string => {
  const { x, y, w, h } = slot.frame;
  const valign = slot.valign ? `, ${slot.valign}` : "";
  return `      ${slot.id.padEnd(12)} ${slot.role.padEnd(9)} ${x}% ${y}%, ${w}% by ${h}%${valign}  takes ${slot.accepts.join(", ")}`;
};

/** The report as lines for a person. */
export function reportLines(report: ImportReport, diagnostics: readonly Diagnostic[]): string[] {
  const lines: string[] = [];
  const out = (line = "") => lines.push(line);
  const { source } = report;
  out(`Imported ${source.file} into ${report.out}`);
  out(
    `  brand "${report.brand.name}" (${report.brand.id}), ${source.theme ? `theme "${source.theme}", ` : ""}slide ${source.slide.ratio}`,
  );
  out();
  out(`Colors: ${report.preset.why}`);
  for (const color of report.colors) {
    out(
      `  ${color.name.padEnd(9)} ${color.value}  ${color.source === "theme" ? "" : `(${color.source}) `}${color.from}`,
    );
  }
  for (const kept of report.kept) {
    out(
      `  kept the preset's ${kept.name} ${kept.used}: ${kept.from} is ${kept.wanted}, ${kept.ratio} against ${kept.against} ${kept.againstValue}, and it needs ${kept.need}:1`,
    );
  }
  out(
    report.chart
      ? `  chart     ${report.chart.colors.join(" ")}  (${report.chart.from.join(", ")}: the accents that reach 3:1 on the background)`
      : "  chart     none",
  );
  out();
  out("Fonts");
  if (report.fonts) {
    const { display, body } = report.fonts;
    out(`  headings  ${display.family}: a ${display.kind}, because ${display.rule}`);
    out(`  text      ${body.family}: a ${body.kind}, because ${body.rule}`);
    out(`  fallback  ${report.fonts.fallback}: ${report.fonts.fallbackRule}. No font files are taken.`);
  } else {
    out("  none taken");
  }
  out();
  out("Logo");
  out(
    report.logo
      ? `  ${report.logo.file}, ${report.logo.corner}, size ${report.logo.size}: ${report.logo.from}`
      : "  none taken",
  );
  const chrome = Object.entries(report.chrome);
  out(
    chrome.length > 0
      ? `Chrome  ${chrome.map(([name, value]) => `${name} ${value}`).join("; ")}`
      : "Chrome  none",
  );
  out();
  out(`Templates (${report.templates.length})`);
  for (const template of report.templates) {
    const extras = [
      template.background ? `background ${template.background}` : "",
      template.chrome ? `chrome ${template.chrome}` : "",
    ].filter(Boolean);
    out(
      `  ${template.id}  "${template.name}"${template.layout === template.name ? "" : ` from the layout "${template.layout}"`}${extras.length > 0 ? `  (${extras.join(", ")})` : ""}`,
    );
    for (const slot of template.slots) out(slotLine(slot));
  }
  if (report.left.length > 0) {
    out();
    out("Left out");
    for (const item of report.left) out(`  ${item.what}: ${item.why}.`);
  }
  if (report.notes.length > 0) {
    out();
    out("Notes");
    for (const note of report.notes) out(`  ${note}`);
  }
  out();
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  out(`Checks: 0 errors, ${plural(warnings.length, "warning")}`);
  for (const diagnostic of warnings) {
    out(`  ${diagnostic.file}${diagnostic.path}  warning  ${diagnostic.message}`);
    if (diagnostic.fix) out(`    fix: ${diagnostic.fix}`);
  }
  out();
  out(
    `Wrote ${plural(report.files.length, "file")} to ${report.out}. Use it with a deck: copy the folder to <deck>/brand and name "${report.brand.id}" as "brand" in deck.json.`,
  );
  return lines;
}

/** Runs the import and prints its report. */
export async function brandImportCommand(
  file: string,
  out: string | undefined,
  json: boolean,
  io: Io,
): Promise<number> {
  try {
    const result = await importBrand({ file, ...(out === undefined ? {} : { out }) });
    if (!result.ok) {
      if (json) {
        io.out(
          JSON.stringify(
            {
              ok: false,
              code: result.code,
              message: result.message,
              left: result.left,
              diagnostics: result.diagnostics,
            },
            null,
            2,
          ),
        );
      } else {
        io.err(result.message);
        for (const item of result.left) io.out(`  ${item.what}: ${item.why}.`);
        for (const diagnostic of result.diagnostics)
          io.out(`  ${diagnostic.file}${diagnostic.path}  ${diagnostic.severity}  ${diagnostic.message}`);
        io.out("Nothing was written.");
      }
      return 1;
    }
    if (json) {
      const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
      io.out(
        JSON.stringify(
          {
            ok: true,
            errors: 0,
            warnings: warnings.length,
            ...result.report,
            diagnostics: result.diagnostics,
          },
          null,
          2,
        ),
      );
    } else {
      for (const line of reportLines(result.report, result.diagnostics)) io.out(line);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    if (json) io.out(JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2));
    else io.err(error.message);
    return 2;
  }
}
