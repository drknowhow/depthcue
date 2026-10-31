import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Link, linkPath, readLink, writeLink } from "../src/link.ts";

let root: string;
let folder: string;
const link: Link = { url: "http://127.0.0.1:4173/", token: "secret-one", pid: 4242 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-link-"));
  folder = join(root, "deck");
  mkdirSync(folder);
});

afterEach(() => {
  rmSync(linkPath(folder), { force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("the link file", () => {
  it("is found by whoever asks for the same folder, however it is spelled", () => {
    const remove = writeLink(folder, link);
    expect(readLink(folder)).toEqual(link);
    expect(readLink(join(folder, "..", "deck"))).toEqual(link);
    remove();
  });

  it("is kept in the temporary directory, never in the deck folder where it could be committed", () => {
    writeLink(folder, link);
    expect(linkPath(folder).startsWith(join(tmpdir(), "depthcue-links"))).toBe(true);
    expect(existsSync(join(folder, ".depthcue"))).toBe(false);
    expect(readFileSync(linkPath(folder), "utf8")).toContain("secret-one");
    expect(readdirSync(folder)).toEqual([]);
  });

  it("is named by the folder, so two decks do not share one", () => {
    const other = join(root, "other");
    mkdirSync(other);
    expect(linkPath(other)).not.toBe(linkPath(folder));
    writeLink(folder, link);
    expect(readLink(other)).toBeUndefined();
  });

  it("is readable only by its owner, where the system says so", () => {
    if (process.platform === "win32") return;
    writeLink(folder, link);
    expect(statSync(linkPath(folder)).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(linkPath(folder))).mode & 0o777).toBe(0o700);
  });

  it("is removed by the server that wrote it", () => {
    const remove = writeLink(folder, link);
    remove();
    expect(readLink(folder)).toBeUndefined();
    expect(existsSync(linkPath(folder))).toBe(false);
    remove();
  });

  it("is left alone by a server that has been replaced, so a newer server keeps its link", () => {
    const first = writeLink(folder, link);
    writeLink(folder, { ...link, token: "secret-two", pid: 4343 });
    first();
    expect(readLink(folder)?.token).toBe("secret-two");
  });

  it("reads as nothing when it is missing, damaged, or not what a server writes", () => {
    expect(readLink(folder)).toBeUndefined();
    mkdirSync(dirname(linkPath(folder)), { recursive: true });
    for (const text of [
      "",
      "{",
      "[]",
      "null",
      '{"url":"u","token":"t"}',
      '{"url":1,"token":"t","pid":1}',
      '{"url":"u","token":1,"pid":1}',
    ]) {
      writeFileSync(linkPath(folder), text);
      expect(readLink(folder)).toBeUndefined();
    }
  });

  it("reads as nothing for a folder that is not there", () => {
    expect(() => readLink(join(root, "missing"))).not.toThrow();
    expect(readLink(join(root, "missing"))).toBeUndefined();
  });
});
