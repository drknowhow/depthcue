import { describe, expect, it } from "vitest";
import { child, childrenNamed, descend, find, integer, parseXml, XmlError } from "../src/brand-import/xml.ts";

describe("parseXml", () => {
  it("reads elements, attributes and text, without the prefixes", () => {
    const root = parseXml(
      '<a:theme xmlns:a="urn:a" name="Harbor"><a:one val="1"/><a:two>text</a:two></a:theme>',
    );
    expect(root.name).toBe("theme");
    expect(root.attrs).toEqual({ name: "Harbor" });
    expect(root.children.map((node) => node.name)).toEqual(["one", "two"]);
    expect(child(root, "two")?.text).toBe("text");
    expect(child(root, "one")?.attrs.val).toBe("1");
  });

  it("keeps an attribute in the relationships namespace as r:, whatever prefix the file gave it", () => {
    const ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const root = parseXml(
      `<x xmlns:q="${ns}" xmlns:o="urn:other"><blip q:embed="rId7" o:embed="no" plain="yes"/></x>`,
    );
    expect(child(root, "blip")?.attrs).toEqual({ "r:embed": "rId7", plain: "yes" });
  });

  it("lets a child inherit the namespaces its parent declares", () => {
    const ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const root = parseXml(`<x xmlns:r="${ns}"><y><z r:id="rId2"/></y></x>`);
    expect(descend(root, "y", "z")?.attrs["r:id"]).toBe("rId2");
  });

  it("decodes the five named entities and character references", () => {
    const root = parseXml('<t a="&lt;&amp;&quot;">x &gt; y &#65;&#x42; &apos;</t>');
    expect(root.attrs.a).toBe('<&"');
    expect(root.text).toBe("x > y AB '");
  });

  it("leaves a reference to a code point that is no character as written", () => {
    expect(parseXml("<t>&#xD800;&#99999999;</t>").text).toBe("&#xD800;&#99999999;");
  });

  it("reads CDATA as text, and skips comments and processing instructions", () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><t><![CDATA[a < b]]><!-- d --></t>');
    expect(root.text).toBe("a < b");
  });

  it("skips a byte order mark", () => {
    expect(parseXml("﻿<t/>").name).toBe("t");
  });

  it("reads single-quoted attributes", () => {
    expect(parseXml("<t a='1' b = \"2\"/>").attrs).toEqual({ a: "1", b: "2" });
  });

  it("refuses a DOCTYPE, so no entity can expand", () => {
    const bomb = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><lolz>&lol2;</lolz>';
    expect(() => parseXml(bomb)).toThrow(XmlError);
    expect(() => parseXml(bomb)).toThrow(/DOCTYPE/);
  });

  it("refuses nesting past 100 levels", () => {
    const deep = `${"<a>".repeat(150)}${"</a>".repeat(150)}`;
    expect(() => parseXml(deep)).toThrow(/nest too deep/);
    const fine = `${"<a>".repeat(90)}${"</a>".repeat(90)}`;
    expect(parseXml(fine).name).toBe("a");
  });

  it.each([
    ["an element never closed", "<a><b></a>"],
    ["a closing tag with no opening", "</a>"],
    ["a closing tag of another name", "<a></b>"],
    ["two roots", "<a/><b/>"],
    ["text outside the root", "hello <a/>"],
    ["no root", "<!-- nothing -->"],
    ["markup that is no markup", "<a <b>"],
  ])("throws XmlError for %s", (_, text) => {
    expect(() => parseXml(text)).toThrow(XmlError);
  });

  it("reads a large flat document quickly", () => {
    const body = Array.from({ length: 20000 }, (_, n) => `<i n="${n}" a="b" c="d"/>`).join("");
    const started = Date.now();
    const root = parseXml(`<r>${body}</r>`);
    expect(root.children).toHaveLength(20000);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not hang on a tag with a great many attributes that never ends", () => {
    const started = Date.now();
    expect(() => parseXml(`<a ${'b="1" '.repeat(30000)}`)).toThrow(XmlError);
    expect(() => parseXml(`<a${" ".repeat(50000)}x`)).toThrow(XmlError);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("the tree helpers", () => {
  const root = parseXml('<r><a><b><c n="12"/></b></a><a id="second"/><d n="x"/></r>');

  it("child and childrenNamed read direct children", () => {
    expect(child(root, "a")?.children).toHaveLength(1);
    expect(childrenNamed(root, "a")).toHaveLength(2);
    expect(child(root, "c")).toBeUndefined();
    expect(child(undefined, "a")).toBeUndefined();
    expect(childrenNamed(undefined, "a")).toEqual([]);
  });

  it("descend follows a path, and stops at the first missing name", () => {
    expect(descend(root, "a", "b", "c")?.attrs.n).toBe("12");
    expect(descend(root, "a", "x", "c")).toBeUndefined();
    expect(descend(undefined, "a")).toBeUndefined();
  });

  it("find looks below, in document order", () => {
    expect(find(root, "c")?.attrs.n).toBe("12");
    expect(find(root, "a")?.children).toHaveLength(1);
    expect(find(root, "missing")).toBeUndefined();
    expect(find(undefined, "c")).toBeUndefined();
  });

  it("integer reads a whole number and nothing else", () => {
    expect(integer(descend(root, "a", "b", "c"), "n")).toBe(12);
    expect(integer(child(root, "d"), "n")).toBeUndefined();
    expect(integer(child(root, "d"), "missing")).toBeUndefined();
    expect(integer(undefined, "n")).toBeUndefined();
    expect(integer(parseXml('<t n="-5"/>'), "n")).toBe(-5);
    expect(integer(parseXml('<t n="1.5"/>'), "n")).toBeUndefined();
  });
});
