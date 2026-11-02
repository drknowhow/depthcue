/** What `brand use` and `new --brand` say: lines for a person, or data for a program (`--json`). */
import type { Io } from "../index.ts";
import { USE_EXIT, type UseResult } from "./use.ts";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Prints the result of a use and returns the exit code. `deck` is the folder, for the commands it suggests. */
export function printUse(result: UseResult, deck: string, json: boolean, io: Io): number {
  if (json) {
    io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : USE_EXIT[result.code];
  }
  if (result.ok) {
    const { brand, replaced } = result;
    if (result.upToDate) {
      io.out(
        `Nothing to do: ${deck} already has the brand "${brand.name}" (${brand.id}), exactly as the folder has it.`,
      );
    } else {
      io.out(
        replaced === null
          ? `Brand "${brand.name}" (${brand.id}) is now the brand of ${deck}.`
          : `Brand "${brand.name}" (${brand.id}) replaced "${replaced.name}" (${replaced.id}) in ${deck}.`,
      );
      io.out(`Revision ${result.prevRev} -> ${result.rev}`);
    }
    for (const path of result.written) io.out(`  wrote ${path}`);
    for (const path of result.copied) io.out(`  copied ${path}`);
    for (const path of result.removed)
      io.out(`  removed ${path} (copied with the earlier brand, which this one does not have)`);
    for (const path of result.kept)
      io.out(`  kept ${path} (copied with the earlier brand and changed since)`);
    if (result.unchanged.length > 0)
      io.out(`  ${plural(result.unchanged.length, "file")} already there with the same bytes`);
    for (const file of result.overwrote) io.out(`  replaced ${file.path} although it ${file.why} (--force)`);
    for (const found of result.diagnostics) {
      io.out(`  ${found.file}${found.path}  ${found.severity}  ${found.message}`);
    }
    return 0;
  }
  io.err(result.message);
  for (const file of result.files ?? []) io.out(`  ${file.path}  ${file.why}`);
  if (result.files !== undefined) io.out("Run it again with --force to replace them. Nothing was written.");
  for (const found of result.diagnostics) {
    io.out(`  ${found.file}${found.path}  ${found.severity}  ${found.message}`);
    if (found.fix) io.out(`    fix: ${found.fix}`);
  }
  if (result.scenes !== undefined) {
    for (const scene of result.scenes) {
      const move = scene.move;
      io.out(`  scene "${scene.scene}" uses the template "${scene.template}".`);
      if (move === null) {
        io.out("    The brand has no template to move it to.");
        continue;
      }
      io.out(
        `    Move it to "${move.template}" with depthcue apply ${deck} <ops.json> --base-rev ${result.rev ?? "<rev>"}, ops.json being:`,
      );
      io.out(`    ${JSON.stringify(move.ops)}`);
      if (move.unplaced.length > 0) {
        io.out(`    Left without a slot there, to decide before applying: ${move.unplaced.join(", ")}.`);
      }
    }
    io.out("Move the scenes first and run this again. Nothing was written.");
  }
  return USE_EXIT[result.code];
}
