import { describe, expect, it } from "vitest";
import { assetUrl, safeUrl } from "../src/safe.ts";

describe("safeUrl", () => {
  it("follows http and https only", () => {
    expect(safeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeUrl("http://example.com/")).toBe("http://example.com/");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "//example.com/relative",
    "not a url",
    "",
  ])("refuses %j", (value) => {
    expect(safeUrl(value)).toBeUndefined();
  });
});

describe("assetUrl", () => {
  it("joins a deck-relative asset path to the base", () => {
    expect(assetUrl(".", "assets/method.svg")).toBe("./assets/method.svg");
    expect(assetUrl("/decks/q3/", "assets/img/a.png")).toBe("/decks/q3/assets/img/a.png");
  });

  it.each([
    "method.svg",
    "assets/../deck.json",
    "assets/..%2fdeck.json",
    "assets/a/../../deck.json",
    "../assets/a.png",
    "/assets/a.png",
    "assets//a.png",
    "assets/",
    "assets/a b.png",
    "https://example.com/assets/a.png",
    "assets/a.png?x=1",
    "",
  ])("refuses %j", (value) => {
    expect(assetUrl(".", value)).toBeUndefined();
  });
});
