// The checks brand/files.ts makes on an uploaded file, one at a time, without a deck or a server: the SVG reader, the
// font reader and the name. brand-ops-e2e.test.ts runs them through the route and `depthcue brand add`.
import { describe, expect, it } from "vitest";
import { MAX_SVG_BYTES, strictSvg } from "../src/brand/files.ts";

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const encode = (text: string) => new TextEncoder().encode(text);

/** An SVG of `MAX_SVG_BYTES` or just under, the most an upload may be, with `run` repeated where `{}` is. */
function filled(wrapper: string, run: string): Uint8Array {
  const count = Math.floor((MAX_SVG_BYTES - wrapper.length + 2) / run.length);
  return encode(wrapper.replace("{}", run.repeat(count)));
}

describe("strictSvg on CSS made to be slow", () => {
  // A pattern that backtracked took seconds over 64 KB of "url(" and minutes over a megabyte.
  it.each([
    ["a fill", `<svg ${SVG_NS}><rect fill="{}"/></svg>`, "url(", /a url\(\) that cannot be read/],
    [
      "a fill, with space before the parenthesis",
      `<svg ${SVG_NS}><rect fill="{}"/></svg>`,
      "url (",
      /cannot be read/,
    ],
    ["a style sheet", `<svg ${SVG_NS}><style>{}</style></svg>`, "url(", /a style longer than 64 KB/],
    ["a style attribute", `<svg ${SVG_NS}><rect style="{}"/></svg>`, "url(", /a style longer than 64 KB/],
  ])("refuses a megabyte of unclosed url( in %s in under 100 ms", (_, wrapper, run, problem) => {
    const bytes = filled(wrapper, run);
    expect(bytes.length).toBeGreaterThan(MAX_SVG_BYTES - 8);
    expect(bytes.length).toBeLessThanOrEqual(MAX_SVG_BYTES);
    const started = performance.now();
    const checked = strictSvg(bytes);
    expect(performance.now() - started).toBeLessThan(100);
    expect(checked).toEqual({ problem: expect.stringMatching(problem) });
  });

  it("refuses 60 KB of unclosed url( in a style sheet, under the length limit, in under 100 ms", () => {
    const started = performance.now();
    const checked = strictSvg(encode(`<svg ${SVG_NS}><style>${"url(".repeat(15_000)}</style></svg>`));
    expect(performance.now() - started).toBeLessThan(100);
    expect(checked).toEqual({ problem: "a url() that cannot be read" });
  });
});
