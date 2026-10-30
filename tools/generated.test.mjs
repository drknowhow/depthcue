import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { staleFiles } from "./generated.mjs";

describe("staleFiles", () => {
  it("is empty when nothing changed", () => {
    expect(staleFiles(new Map([["a", "1"]]), new Map([["a", "1"]]))).toEqual([]);
  });

  it("lists changed, new and removed files in order", () => {
    const before = new Map([
      ["b", "1"],
      ["c", "1"],
      ["same", "1"],
    ]);
    const after = new Map([
      ["a", "1"],
      ["b", "2"],
      ["same", "1"],
    ]);
    expect(staleFiles(before, after)).toEqual(["a", "b", "c"]);
  });
});

describe("generated validators", () => {
  const code = readFileSync(new URL("../packages/core/src/generated/validators.js", import.meta.url), "utf8");

  // Ajv's standalone output reaches for its runtime through require() when a keyword needs a helper, such as
  // code-point string length. In an ES module that fails in the browser and drags Ajv into the bundle.
  it("is self-contained: no require() and no imports", () => {
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/^\s*import\s/m);
  });
});
