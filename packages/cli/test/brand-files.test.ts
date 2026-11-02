// The checks brand/files.ts makes on an uploaded file, one at a time, without a deck or a server: the SVG reader, the
// font reader and the name. brand-ops-e2e.test.ts runs them through the route and `depthcue brand add`.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  brandFileExit,
  MAX_FONT_RATIO,
  MAX_SVG_BYTES,
  oneAtATime,
  sniff,
  statedSize,
  storedName,
  strictSvg,
  sweepTemporaries,
  tooLarge,
} from "../src/brand/files.ts";
import { fileHash } from "../src/loader.ts";
import { readSfnt, writeSfnt } from "../src/pptx/sfnt.ts";

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const encode = (text: string) => new TextEncoder().encode(text);
const decks = fileURLToPath(new URL("../../../fixtures/decks", import.meta.url));
const SPACE_GROTESK = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/fonts/SpaceGrotesk-Regular.ttf", import.meta.url))),
);
const WOFF2_FONTS = [
  "tidewell-press/brand/fonts/TidewellText-Bold.woff2",
  "v0-4-brand/brand/fonts/HarborSans-Bold.woff2",
  "v0-4-brand/brand/fonts/HarborSans-Regular.woff2",
].map((path) => new Uint8Array(readFileSync(join(decks, path))));

/** An SVG of `MAX_SVG_BYTES` or just under, the most an upload may be, with `run` repeated where `{}` is. */
function filled(wrapper: string, run: string): Uint8Array {
  const count = Math.floor((MAX_SVG_BYTES - wrapper.length + 2) / run.length);
  return encode(wrapper.replace("{}", run.repeat(count)));
}

describe("strictSvg on CSS made to be slow", () => {
  // A pattern that backtracked took seconds over 64 KB of "url(" and minutes over a megabyte.
  it.each([
    ["a fill", `<svg ${SVG_NS}><rect fill="{}"/></svg>`, "url(", /a url\(\) that cannot be read/],
    [
      "a fill, with space before the parenthesis",
      `<svg ${SVG_NS}><rect fill="{}"/></svg>`,
      "url (",
      /cannot be read/,
    ],
    ["a style sheet", `<svg ${SVG_NS}><style>{}</style></svg>`, "url(", /a style longer than 64 KB/],
    ["a style attribute", `<svg ${SVG_NS}><rect style="{}"/></svg>`, "url(", /a style longer than 64 KB/],
  ])("refuses a megabyte of unclosed url( in %s in under 100 ms", (_, wrapper, run, problem) => {
    const bytes = filled(wrapper, run);
    expect(bytes.length).toBeGreaterThan(MAX_SVG_BYTES - 8);
    expect(bytes.length).toBeLessThanOrEqual(MAX_SVG_BYTES);
    const started = performance.now();
    const checked = strictSvg(bytes);
    expect(performance.now() - started).toBeLessThan(100);
    expect(checked).toEqual({ problem: expect.stringMatching(problem) });
  });

  it("refuses 60 KB of unclosed url( in a style sheet, under the length limit, in under 100 ms", () => {
    const started = performance.now();
    const checked = strictSvg(encode(`<svg ${SVG_NS}><style>${"url(".repeat(15_000)}</style></svg>`));
    expect(performance.now() - started).toBeLessThan(100);
    expect(checked).toEqual({ problem: "a url() that cannot be read" });
  });
});

describe("strictSvg's own checks", () => {
  // Step 4's check, which strictSvg runs last, refuses these too, in its own words; these are strictSvg's.
  it("refuses any event handler attribute, in its own words", () => {
    for (const attribute of ["onmouseover", "onfocusin", "ONCLICK"]) {
      expect(strictSvg(encode(`<svg ${SVG_NS}><rect ${attribute}="x()"/></svg>`))).toEqual({
        problem: `an event handler attribute ("${attribute}"), which runs script`,
      });
    }
  });

  const XHTML = 'xmlns="http://www.w3.org/1999/xhtml"';
  const problemOf = (text: string): string | undefined => {
    const checked = strictSvg(encode(text));
    return "problem" in checked ? checked.problem : undefined;
  };

  it.each([
    [
      "an encoding other than UTF-8, which a browser reads the bytes in",
      `<?xml version="1.0" encoding="ISO-2022-JP"?><svg ${SVG_NS}><g><!-- --></g></svg>`,
      'an encoding of "ISO-2022-JP" declared, where only UTF-8 is read',
    ],
    [
      "the ISO-2022-JP trick, whose escape is a control character",
      `<?xml version="1.0" encoding="ISO-2022-JP"?><svg ${SVG_NS}><g>\x1b$B<!--\x1b(B<script>alert(1)</script>--></g></svg>`,
      "a control character (U+001B)",
    ],
    [
      "an encoding in single quotes",
      `<?xml version='1.0' encoding='Shift_JIS'?><svg ${SVG_NS}/>`,
      'an encoding of "Shift_JIS" declared, where only UTF-8 is read',
    ],
    [
      "a declaration that never closes",
      `<?xml version="1.0" ${"x".repeat(2000)}<svg ${SVG_NS}/>`,
      "an XML declaration that does not close",
    ],
    [
      "a second declaration",
      `<?xml version="1.0"?><svg ${SVG_NS}><?xml version="1.0" encoding="UTF-16"?></svg>`,
      "an XML declaration after the start of the file",
    ],
    ["a form feed", `<svg ${SVG_NS}><g>\f</g></svg>`, "a control character (U+000C)"],
    ["a C1 control", `<svg ${SVG_NS}><g>\u0085</g></svg>`, "a control character (U+0085)"],
    ["a NUL", `<svg ${SVG_NS}><g>\0</g></svg>`, "a control character (U+0000)"],
  ])("refuses %s", (_, text, problem) => {
    expect(problemOf(text)).toBe(problem);
  });

  it.each([
    [
      "an XHTML frame",
      `<svg ${SVG_NS}><frame ${XHTML} src="javascript:alert(document.domain)"/></svg>`,
      "frame",
    ],
    ["an XHTML img", `<svg ${SVG_NS}><img ${XHTML} src="http://evil.example/beacon.png"/></svg>`, "img"],
    ["an XHTML iframe", `<svg ${SVG_NS}><iframe ${XHTML} src="javascript:alert(1)"/></svg>`, "iframe"],
    [
      "an XHTML form",
      `<svg ${SVG_NS}><form ${XHTML} action="javascript:alert(1)"><button>x</button></form></svg>`,
      "form",
    ],
    [
      "XHTML under a prefix",
      `<svg ${SVG_NS} xmlns:h="http://www.w3.org/1999/xhtml"><g><h:img src="http://evil.example/p.png"/></g></svg>`,
      "h:img",
    ],
    [
      "MathML",
      `<svg ${SVG_NS}><math xmlns="http://www.w3.org/1998/Math/MathML" href="javascript:alert(1)"><mi>x</mi></math></svg>`,
      "math",
    ],
    [
      "XInclude",
      `<svg ${SVG_NS} xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="#a"/></svg>`,
      "xi:include",
    ],
    ["no namespace at all", "<svg><rect/></svg>", "svg"],
    ["a root that declares XHTML", `<svg ${XHTML}><p>hi</p></svg>`, "svg"],
    ["the default namespace taken off", `<svg ${SVG_NS}><g xmlns=""><rect/></g></svg>`, "g"],
    ["a prefix no one declared", `<svg ${SVG_NS}><q:rect/></svg>`, "q:rect"],
    [
      "the SVG namespace written with a character reference",
      `<svg xmlns="http://www.w3.org/2000/&#115;vg"><rect/></svg>`,
      "svg",
    ],
    [
      "an editor's own element",
      `<svg ${SVG_NS} xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"><sodipodi:namedview/></svg>`,
      "sodipodi:namedview",
    ],
  ])("refuses %s, an element outside the SVG namespace", (_, text, element) => {
    expect(problemOf(text)).toBe(
      `an element outside the SVG namespace ("${element}"), which a browser may load or run as HTML`,
    );
  });

  it.each(["src", "srcset", "action", "formaction", "data", "poster", "xml:base", "h:src"])(
    'refuses a "%s" attribute, which loads or sends something in HTML',
    (attribute) => {
      expect(problemOf(`<svg ${SVG_NS} xmlns:h="urn:h"><rect ${attribute}="x"/></svg>`)).toBe(
        `a "${attribute}" attribute, which loads or sends something in HTML`,
      );
    },
  );

  it.each([
    [
      "image-set()",
      `<rect style="background-image:image-set('http://evil.example/x.png' 1x)"/>`,
      "an image-set()",
    ],
    ["-webkit-image-set()", `<style>.a{fill:-webkit-IMAGE-SET("x.png" 1x)}</style>`, "an image-set()"],
    ["image()", `<rect style="fill:image('x.png')"/>`, "an image()"],
  ])("refuses a style with %s, which loads a picture by name", (_, inside, what) => {
    expect(problemOf(`<svg ${SVG_NS}>${inside}</svg>`)).toBe(`${what}, which loads a picture by name`);
  });

  it.each([
    ["UTF-8 declared", `<?xml version="1.0" encoding="UTF-8"?><svg ${SVG_NS}/>`],
    ["utf8 declared after a byte order mark", `﻿<?xml version="1.0" encoding="utf8"?><svg ${SVG_NS}/>`],
    ["no encoding declared", `<?xml version="1.0" standalone="no"?><svg ${SVG_NS}/>`],
    ["tabs and line ends", `<svg ${SVG_NS}>\t\r\n<rect/>\n</svg>`],
    [
      "SVG and xlink under prefixes, a comment, CDATA and an instruction",
      `<s:svg xmlns:s="${"http://www.w3.org/2000/svg"}" xmlns:xlink="http://www.w3.org/1999/xlink"><!-- <h:img/> --><s:style><![CDATA[ .a{fill:url(#g)} ]]></s:style><?keep this?><s:use xlink:href="#a"/><s:g xmlns="http://www.w3.org/2000/svg"><rect data-x="1" title="a > b"/></s:g></s:svg>`,
    ],
    ["99 groups deep", `<svg ${SVG_NS}>${"<g>".repeat(99)}${"</g>".repeat(99)}</svg>`],
  ])("takes an SVG with %s", (_, text) => {
    expect(strictSvg(encode(text))).toEqual({ elements: expect.any(Number) });
  });
});

const base128 = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  do {
    out.unshift(rest & 0x7f);
    rest = Math.floor(rest / 128);
  } while (rest > 0);
  return out.map((byte, i) => (i < out.length - 1 ? byte | 0x80 : byte));
};

/**
 * A WOFF2 file of `size` bytes whose one table (an arbitrary tag, not transformed) states `stated` bytes, its header
 * claiming `claimed` bytes of compressed data. Past its table list it is zeros: no check that reads it as a font should
 * get as far as decompressing that.
 */
function woff2(stated: number, size: number, claimed = size): Uint8Array {
  const out = new Uint8Array(size);
  const data = new DataView(out.buffer);
  out.set(encode("wOF2"), 0);
  data.setUint32(4, 0x00010000);
  data.setUint32(8, size);
  data.setUint16(12, 1);
  data.setUint32(16, 12 + 16 + stated);
  data.setUint32(20, claimed);
  out.set([63, ...encode("ZZZZ"), ...base128(stated)], 48);
  return out;
}

/** A WOFF file of `size` bytes with one table stating `stated` bytes once inflated. */
function woff(stated: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const data = new DataView(out.buffer);
  out.set(encode("wOFF"), 0);
  data.setUint32(4, 0x00010000);
  data.setUint32(8, size);
  data.setUint16(12, 1);
  out.set(encode("ZZZZ"), 44);
  data.setUint32(48, 64);
  data.setUint32(52, size - 64);
  data.setUint32(56, stated);
  return out;
}

const fontRefusal = (bytes: Uint8Array): string => {
  const found = sniff("font", bytes);
  if (!("ok" in found)) throw new Error(`expected a refusal, got ${JSON.stringify(found)}`);
  expect(found.error).toBe("not-a-font");
  return found.message;
};

/** The TrueType test font with its tables changed. */
function changed(edit: (tables: Map<string, Uint8Array>) => void): Uint8Array {
  const font = readSfnt(SPACE_GROTESK);
  const tables = new Map(font.tables);
  edit(tables);
  return writeSfnt({ flavor: font.flavor, tables });
}

describe("the font check", () => {
  it("takes real fonts, whose tables state two to four times their file", () => {
    for (const bytes of WOFF2_FONTS) {
      const ratio = (statedSize(bytes) as number) / bytes.length;
      expect(ratio).toBeGreaterThan(1);
      expect(ratio).toBeLessThan(4);
      expect(sniff("font", bytes)).toMatchObject({ format: "woff2", family: expect.stringMatching(/\S/) });
    }
    expect(statedSize(SPACE_GROTESK)).toBeUndefined();
    expect(sniff("font", SPACE_GROTESK)).toMatchObject({ format: "ttf", family: "Space Grotesk" });
  });

  it("refuses a WOFF2 that states tables far past its file, by the file's length and not its header's claim", () => {
    // 717 KB that state 63 MB, the header claiming all 717 KB is compressed data: a hundred times was let through.
    const started = performance.now();
    expect(fontRefusal(woff2(63 * 1024 * 1024, 717 * 1024))).toMatch(
      /^The WOFF2 file states tables 89 times its own size, which no font does\./,
    );
    expect(performance.now() - started).toBeLessThan(50);
    // A header that claims a hundred megabytes of compressed data does not make 60 KB hold 2 MB.
    expect(fontRefusal(woff2(2 * 1024 * 1024, 60_000, 100 * 1024 * 1024))).toMatch(/states tables 34 times/);
  });

  it("refuses from just past twenty times the file, and not at twenty", () => {
    const size = 60_000;
    expect(MAX_FONT_RATIO * size).toBeGreaterThan(1024 * 1024);
    expect(fontRefusal(woff2(MAX_FONT_RATIO * size + 1, size))).toMatch(
      /states tables 20 times its own size/,
    );
    // At twenty times it is unpacked, and fails there: its data is zeros, not brotli.
    expect(fontRefusal(woff2(MAX_FONT_RATIO * size, size))).not.toMatch(/times its own size/);
    // Under a megabyte the ratio is no concern: a small font's tables can state much more than a tiny file.
    expect(fontRefusal(woff2(1024 * 1024, 1024))).not.toMatch(/times its own size/);
  });

  it("refuses a WOFF that states tables far past its file", () => {
    expect(fontRefusal(woff(30 * 1024 * 1024, 100 * 1024))).toMatch(
      /^The WOFF file states tables 307 times its own size/,
    );
  });

  it("refuses a TrueType header with no tables, and a font missing a table a slide needs", () => {
    // Version 1.0 and nothing else: twelve bytes, and no font.
    expect(fontRefusal(Uint8Array.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toMatch(
      /^The font has no name, head, cmap, maxp, hhea, outlines \(glyf and loca, or CFF\) tables/,
    );
    for (const tag of ["name", "head", "cmap", "maxp", "hhea"]) {
      expect(fontRefusal(changed((tables) => tables.delete(tag)))).toMatch(
        new RegExp(`^The font has no ${tag} table,`),
      );
    }
    expect(fontRefusal(changed((tables) => tables.delete("loca")))).toMatch(/no outlines/);
  });

  it("refuses a font that names no family", () => {
    // A name table with no names: format 0, no records, the strings right after.
    const nameless = changed((tables) => tables.set("name", Uint8Array.from([0, 0, 0, 0, 0, 6])));
    expect(fontRefusal(nameless)).toMatch(/^The font names no family/);
  });
});

describe("oneAtATime", () => {
  it("runs each step after the last has finished, with a turn of the event loop between", async () => {
    const order: string[] = [];
    const first = oneAtATime(async () => {
      order.push("first");
      setImmediate(() => order.push("between"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first done");
    });
    const failing = oneAtATime(() => {
      order.push("failing");
      throw new Error("refused");
    });
    const last = oneAtATime(() => order.push("last"));
    await expect(failing).rejects.toThrow("refused");
    await Promise.all([first, last]);
    expect(order).toEqual(["first", "between", "first done", "failing", "last"]);
  });

  it("answers what arrives during a step before the next step starts", async () => {
    const order: string[] = [];
    const steps = [
      oneAtATime(() => {
        order.push("a");
        // A request that comes in while a font is unpacked.
        setImmediate(() => order.push("request"));
      }),
      oneAtATime(() => order.push("b")),
    ];
    await Promise.all(steps);
    expect(order).toEqual(["a", "request", "b"]);
  });
});

describe("names, limits and exit codes", () => {
  it("refuses a name longer than a file system keeps, before it is cleaned", () => {
    expect(storedName(`${"a".repeat(256)}.png`, "png")).toEqual({
      problem: "The name is 260 characters long; a file's name can be up to 255.",
    });
    expect(storedName(`dir/${"a".repeat(251)}.png`, "png")).toEqual({ name: `${"a".repeat(100)}.png` });
  });

  it("says a or an as the kind needs", () => {
    expect(tooLarge("image").message).toMatch(/^An image can be up to 15 MB\./);
    expect(tooLarge("logo").message).toMatch(/^A logo can be up to 15 MB\./);
    expect(tooLarge("font").message).toMatch(/^A font can be up to 32 MB\./);
  });

  it("exits as brand use does: 3 when the deck moved on, 2 when the deck or its folder stops it, else 1", () => {
    expect(brandFileExit("stale")).toBe(3);
    for (const code of ["unreadable-deck", "linked-brand-folder", "write-failed"] as const) {
      expect(brandFileExit(code), code).toBe(2);
    }
    for (const code of [
      "bad-request",
      "bad-name",
      "too-large",
      "not-a-font",
      "unsupported",
      "unsafe-svg",
      "exists",
      "not-found",
      "in-use",
    ] as const) {
      expect(brandFileExit(code), code).toBe(1);
    }
  });
});

describe("fileHash", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const then = new Date("2026-01-01T00:00:00Z");
  /** Writes the text over the file in place, and sets its modified time back to `then`, as a copy that keeps times does. */
  const rewrite = (file: string, text: string) => {
    writeFileSync(file, text);
    utimesSync(file, then, then);
    return statSync(file);
  };

  it("reads a file again that was rewritten in place to the same size, its modified time set back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "depthcue-hash-"));
    try {
      const file = join(dir, "Acme.woff2");
      const first = rewrite(file, "aaaa");
      // Read as if a minute later, when the file has settled, so the hash is kept under the file's times.
      const later = () => Date.now() + 60_000;
      expect(fileHash(file, first, later())).toBe(sha("aaaa"));
      // A later tick of the clock than the first change: only the change time tells the two apart.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = rewrite(file, "bbbb");
      expect([second.size, second.mtimeMs, second.ino]).toEqual([first.size, first.mtimeMs, first.ino]);
      expect(second.ctimeMs).not.toBe(first.ctimeMs);
      expect(fileHash(file, second, later())).toBe(sha("bbbb"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps no hash of a file that changed in the last seconds, which can change again in the same tick", () => {
    const dir = mkdtempSync(join(tmpdir(), "depthcue-hash-"));
    try {
      const file = join(dir, "Acme.woff2");
      rewrite(file, "aaaa");
      expect(fileHash(file)).toBe(sha("aaaa"));
      // At once: on Windows often within the same tick, so every time of the file can read as it did.
      rewrite(file, "bbbb");
      expect(fileHash(file)).toBe(sha("bbbb"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sweepTemporaries", () => {
  it("removes a write's temporary file left at the deck's top, once older than any write takes, and nothing else", () => {
    const deck = mkdtempSync(join(tmpdir(), "depthcue-sweep-"));
    try {
      const old = (name: string) => {
        writeFileSync(join(deck, name), "x");
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        utimesSync(join(deck, name), hourAgo, hourAgo);
      };
      old(".depthcue-brand-123-abcdef.tmp");
      old("notes.tmp");
      old(".depthcue-brand-import");
      writeFileSync(join(deck, ".depthcue-brand-456-fedcba.tmp"), "being written");
      sweepTemporaries(deck);
      expect(existsSync(join(deck, ".depthcue-brand-123-abcdef.tmp"))).toBe(false);
      for (const kept of ["notes.tmp", ".depthcue-brand-import", ".depthcue-brand-456-fedcba.tmp"]) {
        expect(existsSync(join(deck, kept)), kept).toBe(true);
      }
    } finally {
      rmSync(deck, { recursive: true, force: true });
    }
  });
});
