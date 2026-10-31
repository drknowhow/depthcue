import { describe, expect, it } from "vitest";
import { declaredBlocks, load, readDocument, renderBlocks, splice } from "./report.mjs";

const document = readDocument();
const regenerate = "Run: node tools/trial/report.mjs";

describe("docs/TRIAL.md", () => {
  it(`matches the result files in docs/trial. ${regenerate}`, () => {
    expect(splice(document, renderBlocks(load()))).toBe(document);
  });

  it("declares every table the report generates, and no other", () => {
    expect(declaredBlocks(document).sort()).toEqual(Object.keys(renderBlocks(load())).sort());
  });

  it("changes when a result changes, so a table cannot be edited around its data", () => {
    const data = load();
    data.bench.results.depthcue.coldOpenMs.p50 += 1000;
    expect(splice(document, renderBlocks(data))).not.toBe(document);
  });

  it("refuses a document that is missing a table's markers", () => {
    expect(() => splice("# nothing here", { speed: "x" })).toThrow(/trial:begin speed/);
  });
});
