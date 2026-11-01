import { readdirSync, readFileSync } from "node:fs";
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

describe("core's validators", () => {
  const core = new URL("../packages/core/", import.meta.url);

  // Core checks files with src/schemacheck.ts, which reads the schema objects at run time. Ajv's compiled code for the
  // same schemas cost the editor's script more than all the rest of core added to it, so Ajv is for tests only.
  it("are not compiled: no generated module, and no Ajv in core's source or dependencies", () => {
    expect(readdirSync(new URL("src/", core))).not.toContain("generated");
    for (const name of readdirSync(new URL("src/", core)).filter((file) => file.endsWith(".ts"))) {
      expect(readFileSync(new URL(`src/${name}`, core), "utf8"), name).not.toMatch(/from "ajv/);
    }
    const manifest = JSON.parse(readFileSync(new URL("package.json", core), "utf8"));
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("ajv");
  });
});
