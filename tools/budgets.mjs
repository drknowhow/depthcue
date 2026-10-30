import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export function measure(buffer) {
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer, { level: 9 }).length,
    brotli: brotliCompressSync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

/** One row per budget; a missing file is a failure so a renamed output cannot pass silently. */
export function evaluate(budgets, readFile) {
  return budgets.map((budget) => {
    const buffer = readFile(budget.file);
    if (!buffer) {
      return {
        ...budget,
        actual: null,
        ok: false,
        reason: `${budget.file} does not exist; build first, or fix the "file" in budgets.json`,
      };
    }
    const actual = measure(buffer)[budget.metric];
    return { ...budget, actual, ok: actual <= budget.limitBytes };
  });
}

export function report(rows) {
  const kb = (bytes) => (bytes === null ? "missing" : `${(bytes / 1024).toFixed(1)} KB`);
  return rows.map((row) => {
    const status = row.ok ? "ok  " : "FAIL";
    const detail = row.reason ?? `${kb(row.actual)} ${row.metric} of ${kb(row.limitBytes)}`;
    return `${status} ${row.name}: ${detail}`;
  });
}
