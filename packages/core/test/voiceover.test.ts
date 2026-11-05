import { describe, expect, it } from "vitest";
import { splitMarks } from "../src/voiceover.ts";

describe("splitMarks", () => {
  it("gives the text as spoken and the words before each mark", () => {
    expect(splitMarks("First point. {step} Second point. {step} Done.")).toEqual({
      spoken: "First point. Second point. Done.",
      marks: [2, 4],
    });
  });

  it("has no marks in text without any", () => {
    expect(splitMarks("Just words.")).toEqual({ spoken: "Just words.", marks: [] });
  });

  it("counts a mark at the start as 0 and one at the end as the number of words", () => {
    expect(splitMarks("{step} One two {step}")).toEqual({ spoken: "One two", marks: [0, 2] });
  });

  it("keeps two marks in a row apart", () => {
    expect(splitMarks("Go {step}{step} on")).toEqual({ spoken: "Go on", marks: [1, 1] });
  });

  it("does not take a mark out of the middle of a word", () => {
    expect(splitMarks("ab{step}cd")).toEqual({ spoken: "ab cd", marks: [1] });
  });
});
