import type { ApplyFailure } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { problemOf } from "../src/fields.ts";

const failure = (diagnostics: ApplyFailure["diagnostics"]): ApplyFailure => ({
  ok: false,
  code: "invalid-deck",
  rev: "0000000000000000",
  diagnostics,
});

const diagnostic = (message: string, fix?: string) => ({
  severity: "error" as const,
  code: "x",
  file: "deck.json",
  path: "/title",
  message,
  ...(fix === undefined ? {} : { fix }),
});

describe("problemOf", () => {
  it("says what is wrong and what to change, when the core knows both", () => {
    expect(problemOf(failure([diagnostic("Title is empty.", "Write at least one character.")]))).toBe(
      "Title is empty. Write at least one character.",
    );
  });

  it("says just what is wrong when there is no fix to offer", () => {
    expect(problemOf(failure([diagnostic("Title is empty.")]))).toBe("Title is empty.");
  });

  it("reports the first problem only, so a field shows one clear line", () => {
    expect(problemOf(failure([diagnostic("First."), diagnostic("Second.")]))).toBe("First.");
  });

  it("still says something when the core gave no reason", () => {
    expect(problemOf(failure([]))).toBe("That change was refused.");
  });
});
