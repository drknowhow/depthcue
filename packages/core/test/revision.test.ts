import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { docToFiles, loadDoc, revisionOf } from "../src/index.ts";
import { canonicalJson, sha256Hex } from "../src/revision.ts";
import { demoDoc } from "./helpers.ts";

describe("sha256Hex", () => {
  it("matches the published vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("agrees with node:crypto around block boundaries and on non-ASCII text", () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 1000]) {
      const text = "é☃𝄞x".repeat(Math.ceil(length / 4)).slice(0, length);
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and skips undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"z":1}]},"b":1}',
    );
  });
});

describe("revisionOf", () => {
  it("is 16 hex characters", () => {
    expect(revisionOf(demoDoc())).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not depend on how the files are formatted", () => {
    const doc = demoDoc();
    const compact = Object.fromEntries(
      Object.entries(docToFiles(doc)).map(([path, text]) => [path, JSON.stringify(JSON.parse(text))]),
    );
    const reloaded = loadDoc({ text: compact, assets: doc.assets }).doc;
    expect(reloaded && revisionOf(reloaded)).toBe(revisionOf(doc));
  });

  it("changes with scene order and with content", () => {
    const doc = demoDoc();
    const reordered = { ...doc, deck: { ...doc.deck, scenes: ["demand", "opening", "method"] } };
    expect(revisionOf(reordered)).not.toBe(revisionOf(doc));
    const edited = { ...doc, scenes: { ...doc.scenes, opening: { ...doc.scenes.opening, notes: "x" } } };
    expect(revisionOf(edited as typeof doc)).not.toBe(revisionOf(doc));
  });
});
