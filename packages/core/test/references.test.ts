import { describe, expect, it } from "vitest";
import { checkReferences, type Scene } from "../src/index.ts";
import { demoDoc } from "./helpers.ts";

const base = demoDoc().scenes.demand as Scene;
const check = (changes: Partial<Scene>) => checkReferences({ ...base, ...changes }, "scenes/demand.json");

describe("checkReferences", () => {
  it("passes the demo scene", () => {
    expect(check({})).toEqual([]);
  });

  it("reports an id reused across summary, block, source and step", () => {
    const found = check({ steps: [{ id: "chart-demand", reveal: ["claim-shift"] }] });
    expect(found[0]).toMatchObject({
      code: "duplicate-id",
      path: "/steps/0/id",
      message: '"chart-demand" is already used by the block at /blocks/0/id.',
    });
  });

  it("suggests the near miss for evidence that names no block", () => {
    const found = check({ summary: { id: "claim-shift", text: "x", evidenceIds: ["chart-demnd"] } });
    expect(found[0]).toMatchObject({ code: "unknown-reference", path: "/summary/evidenceIds/0" });
    expect(found[0]?.fix).toContain('Did you mean "chart-demand"?');
  });

  it("reports a block that cites a source the scene does not list", () => {
    const [block] = base.blocks;
    const found = check({
      blocks: [{ ...(block as object), sourceIds: ["source-other"] } as Scene["blocks"][0]],
    });
    expect(found[0]).toMatchObject({ code: "unknown-reference", path: "/blocks/0/sourceIds/0" });
    expect(found[0]?.fix).toBe("Use one of: source-report.");
  });

  it("lets a step reveal the summary or a block, and rejects anything else", () => {
    expect(check({ steps: [{ id: "all", reveal: ["claim-shift", "chart-demand"] }] })).toEqual([]);
    const found = check({ steps: [{ id: "all", reveal: ["nothing-here"] }] });
    expect(found[0]).toMatchObject({ code: "unknown-reference", path: "/steps/0/reveal/0" });
  });

  it("says when there is nothing to reference", () => {
    const { sources: _drop, ...noSources } = base;
    const found = checkReferences(noSources as Scene, "scenes/demand.json");
    expect(found[0]?.fix).toBe("This scene has no source yet.");
  });
});
