import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluate, measure, report } from "./budgets.mjs";

const budget = (limitBytes, file = "a.js") => ({ name: "core", file, metric: "gzip", limitBytes });

describe("budgets", () => {
  it("passes a file under its limit and reports its size", () => {
    const rows = evaluate([budget(10_000)], () => Buffer.from("x".repeat(500)));
    expect(rows[0].ok).toBe(true);
    expect(report(rows)[0]).toMatch(/^ok\s+core:/);
  });

  it("fails a file over its limit", () => {
    const noisy = randomBytes(4000);
    expect(measure(noisy).gzip).toBeGreaterThan(1000);
    expect(evaluate([budget(1000)], () => noisy)[0].ok).toBe(false);
  });

  it("fails when the budgeted file is missing and says what to fix", () => {
    const rows = evaluate([budget(1000, "gone.js")], () => null);
    expect(rows[0].ok).toBe(false);
    expect(report(rows)[0]).toContain("budgets.json");
  });
});
