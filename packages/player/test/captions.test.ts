import { describe, expect, it } from "vitest";
import { lineAt, linesFromText, linesFromWords, readMarks, readWords } from "../src/captions.ts";

const word = (text: string, start: number, end: number) => ({ text, start, end });

describe("readWords", () => {
  it("reads the file voice build writes", () => {
    expect(readWords({ format: "depthcue-words/1", words: [word("Hi", 0, 0.2)] })).toEqual([
      word("Hi", 0, 0.2),
    ]);
  });

  it("refuses another format, missing times and junk", () => {
    expect(readWords({ format: "other/1", words: [] })).toBeUndefined();
    expect(readWords({ format: "depthcue-words/1", words: [{ text: "Hi", start: 0 }] })).toBeUndefined();
    expect(readWords({ format: "depthcue-words/1", words: [word("Hi", Number.NaN, 1)] })).toBeUndefined();
    expect(readWords(null)).toBeUndefined();
    expect(readWords("words")).toBeUndefined();
  });
});

describe("linesFromWords", () => {
  it("starts a new caption after a pause", () => {
    const lines = linesFromWords([word("One", 0, 0.3), word("two", 0.3, 0.6), word("Three", 1.5, 1.9)]);
    expect(lines).toEqual([
      { text: "One two", start: 0, end: 0.6 },
      { text: "Three", start: 1.5, end: 1.9 },
    ]);
  });

  it("breaks a long run of words into captions of nine", () => {
    const words = Array.from({ length: 20 }, (_, i) => word(`w${i}`, i * 0.3, i * 0.3 + 0.3));
    expect(linesFromWords(words).map((line) => line.text.split(" ").length)).toEqual([9, 9, 2]);
  });

  it("uses the script's words and punctuation, and breaks at its sentences, when the counts match", () => {
    const words = ["Hello", "there", "friend", "How", "are", "you"].map((text, i) =>
      word(text, i * 0.3, i * 0.3 + 0.3),
    );
    const lines = linesFromWords(words, "Hello there, friend. How are you?");
    expect(lines.map((line) => line.text)).toEqual(["Hello there, friend.", "How are you?"]);
  });

  it("breaks at a comma only once a few words are in", () => {
    const words = ["Yes", "so", "it", "is", "really", "good"].map((text, i) =>
      word(text, i * 0.2, i * 0.2 + 0.2),
    );
    const lines = linesFromWords(words, "Yes, so it is, really good");
    expect(lines.map((line) => line.text)).toEqual(["Yes, so it is,", "really good"]);
  });

  it("keeps the spoken words when the script has a different number of them", () => {
    const words = ["Forty", "two"].map((text, i) => word(text, i * 0.3, i * 0.3 + 0.3));
    expect(linesFromWords(words, "42.")[0]?.text).toBe("Forty two");
  });

  it("gives nothing for no words", () => {
    expect(linesFromWords([])).toEqual([]);
  });
});

describe("linesFromText", () => {
  it("splits sentences and spreads them over the recording by length", () => {
    const lines = linesFromText("Short one. A much longer second sentence follows.", 10);
    expect(lines.map((line) => line.text)).toEqual(["Short one.", "A much longer second sentence follows."]);
    expect(lines[0]?.start).toBe(0);
    expect(lines[1]?.end).toBeCloseTo(10);
    expect(lines[0]?.end).toBeCloseTo(lines[1]?.start as number);
  });

  it("has nothing to show before the length is known", () => {
    expect(linesFromText("Hello there.", Number.NaN)).toEqual([]);
    expect(linesFromText("Hello there.", 0)).toEqual([]);
  });
});

describe("lineAt", () => {
  const lines = [
    { text: "first", start: 1, end: 2 },
    { text: "second", start: 3, end: 4 },
  ];

  it("shows nothing before the first caption", () => {
    expect(lineAt(lines, 0.2)).toBeUndefined();
  });

  it("shows the caption that has begun, and keeps it a moment after it ends", () => {
    expect(lineAt(lines, 1.5)?.text).toBe("first");
    expect(lineAt(lines, 2.4)?.text).toBe("first");
    expect(lineAt(lines, 3.1)?.text).toBe("second");
  });

  it("drops a caption that has been up long past its end", () => {
    expect(lineAt(lines, 2.9)).toBeUndefined();
    expect(lineAt(lines, 9)).toBeUndefined();
  });
});

describe("readMarks", () => {
  it("reads the seconds the slide moves on", () => {
    expect(readMarks({ marks: [1.2, 3] })).toEqual([1.2, 3]);
  });

  it("has none for a file without marks or with bad ones", () => {
    expect(readMarks({})).toEqual([]);
    expect(readMarks(null)).toEqual([]);
    expect(readMarks({ marks: "1" })).toEqual([]);
    expect(readMarks({ marks: [1, "2"] })).toEqual([]);
    expect(readMarks({ marks: [-1] })).toEqual([]);
  });
});
