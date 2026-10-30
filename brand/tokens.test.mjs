import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast } from "../tools/contrast.mjs";
import { buildCss } from "../tools/tokens.mjs";

const tokens = JSON.parse(readFileSync(new URL("./tokens.json", import.meta.url), "utf8"));
const theme = (name) =>
  Object.fromEntries(Object.entries(tokens.color.theme[name]).map(([key, token]) => [key, token.$value]));

describe.each(["paper", "ink"])("%s theme contrast", (name) => {
  const c = theme(name);

  it.each(["text", "muted", "action", "evidence"])("%s on bg is at least 4.5:1", (key) => {
    expect(contrast(c[key], c.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("text on surface is at least 4.5:1", () => {
    expect(contrast(c.text, c.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("text on the state fill is at least 4.5:1", () => {
    expect(contrast(c["on-state"], c.state)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("tokens.css", () => {
  const css = buildCss(tokens);

  it("defines both themes and defaults to paper", () => {
    expect(css).toContain(':root,\n[data-theme="paper"]');
    expect(css).toContain('[data-theme="ink"]');
  });

  it("quotes font families that need it and joins cubic beziers", () => {
    expect(css).toContain('--dc-font-ui: "Space Grotesk", system-ui, sans-serif;');
    expect(css).toContain("--dc-motion-easing-standard: cubic-bezier(0.2, 0, 0, 1);");
  });
});
