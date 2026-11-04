import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GROUP_NAMES, GROUPS, selection } from "./test-groups.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const named = Object.values(GROUPS).flat();

describe("test groups", () => {
  it("names only test files that exist", () => {
    for (const file of named) {
      expect(file).toMatch(/\.test\.(ts|mjs)$/);
      expect(existsSync(`${root}/${file}`), file).toBe(true);
    }
  });

  it("puts no file in two groups", () => {
    expect(new Set(named).size).toBe(named.length);
  });

  it("leaves out of rest exactly the files the other groups run", () => {
    expect(selection("rest")).toEqual(named.map((file) => `--exclude=${file}`));
    expect(GROUP_NAMES.at(-1)).toBe("rest");
  });

  it("refuses a group it does not have", () => {
    expect(() => selection("nope")).toThrow(/no test group "nope"/);
  });
});
