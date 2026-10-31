import { describe, expect, it } from "vitest";
import { PATTERN_HINTS } from "../src/diagnostics.ts";
import { deckSchema, opsSchema, sceneSchema } from "../src/schema.ts";

/** Every `pattern` keyword reachable from a schema object. */
function patternsIn(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) patternsIn(item, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "pattern" && typeof value === "string") found.add(value);
      else patternsIn(value, found);
    }
  }
  return found;
}

describe("pattern hints", () => {
  it("has a hint for every pattern a schema uses, so a bad value always says what to write", () => {
    const used = [
      ...new Set([...patternsIn(deckSchema), ...patternsIn(sceneSchema), ...patternsIn(opsSchema)]),
    ];
    expect(used.length).toBeGreaterThan(3);
    const missing = used.filter((pattern) => !PATTERN_HINTS[pattern]);
    expect(missing, `Add these to PATTERN_HINTS in diagnostics.ts: ${missing.join(", ")}`).toEqual([]);
  });
});
