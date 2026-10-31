import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sceneText } from "./build-demo.mjs";
import { transcript } from "./demo-transcript.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("demo video", () => {
  it("has a scene that matches the tokens, transcript and demand scene it is built from", () => {
    expect(
      read("docs/demo/demo.json") === sceneText(),
      "docs/demo/demo.json is out of date. Run `pnpm demo:scene` and commit the result.",
    ).toBe(true);
  });

  it("quotes what the built CLI prints", () => {
    const recorded = JSON.parse(read("docs/demo/transcript.json"));
    const { ops, before, applied, appliedCode, stale, staleCode } = transcript();
    expect(
      { ops, before, applied, appliedCode, stale, staleCode },
      "The CLI no longer prints what docs/demo/transcript.json records. Run `pnpm demo:capture`, then `pnpm demo:scene` and `pnpm demo:render`.",
    ).toEqual({
      ops: recorded.ops,
      before: recorded.before,
      applied: recorded.applied,
      appliedCode: recorded.appliedCode,
      stale: recorded.stale,
      staleCode: recorded.staleCode,
    });
  });

  it("shows the stale edit being rejected, not applied", () => {
    const recorded = JSON.parse(read("docs/demo/transcript.json"));
    expect(recorded.appliedCode).toBe(0);
    expect(recorded.staleCode).toBe(3);
    expect(recorded.stale).toContain("stale-revision");
  });

  it("has a video rendered from the committed scene", () => {
    expect(
      existsSync(new URL("../docs/demo/demo.mp4", import.meta.url)),
      "docs/demo/demo.mp4 is missing.",
    ).toBe(true);
    expect(statSync(new URL("../docs/demo/demo.mp4", import.meta.url)).size).toBeGreaterThan(100_000);
    const sum = createHash("sha256").update(read("docs/demo/demo.json")).digest("hex");
    expect(
      read("docs/demo/demo.sha256").trim() === sum,
      "docs/demo/demo.json changed after docs/demo/demo.mp4 was rendered. Run `pnpm demo:render`.",
    ).toBe(true);
  });
});
