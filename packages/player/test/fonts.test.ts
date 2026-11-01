import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { FONT_PAIRS } from "@depthcue/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const fontsDir = join(root, "brand", "fonts");

interface FontFile {
  file: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  /** The characters a file covers, when it is one of several for the weight, as IBM splits its fonts. */
  range?: string;
  unicodeRange?: string;
  bytes: number;
  sha256: string;
  source: { sourceSha256: string };
}
interface Family {
  license: string;
  licenseFile: string;
  reservedName: string | false;
  route: "subset" | "renamed-subset" | "vendor-unmodified";
  modified: boolean;
  originalName?: string;
}
interface Manifest {
  families: Record<string, Family>;
  pairs: Record<string, { display: string; body: string; data: string }>;
  files: FontFile[];
}

/** The strings of a woff2's name table, by name id. The table is not transformed in a woff2, so it reads as it is. */
function woff2Names(path: string): Map<number, string[]> {
  const bytes = readFileSync(path);
  if (bytes.toString("latin1", 0, 4) !== "wOF2") throw new Error(`${path} is not a woff2`);
  const tables = bytes.readUInt16BE(12);
  const compressed = bytes.readUInt32BE(20);
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = bytes.readUInt8(at++);
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const NAME = 5;
  const GLYF = 10;
  const LOCA = 11;
  let before = 0;
  let nameAt = -1;
  let nameLength = 0;
  for (let i = 0; i < tables; i++) {
    const flags = bytes.readUInt8(at++);
    const index = flags & 0x3f;
    if (index === 63) at += 4;
    const version = flags >> 6;
    const original = base128();
    // glyf and loca are transformed unless version 3; every other table only when its version is not 0.
    const transformed = index === GLYF || index === LOCA ? version !== 3 : version !== 0;
    const stored = transformed ? base128() : original;
    if (index === NAME) {
      nameAt = before;
      nameLength = original;
    }
    before += stored;
  }
  if (nameAt < 0) throw new Error(`${path} has no name table`);
  const data = brotliDecompressSync(bytes.subarray(at, at + compressed));
  const table = data.subarray(nameAt, nameAt + nameLength);
  const count = table.readUInt16BE(2);
  const strings = table.readUInt16BE(4);
  const out = new Map<number, string[]>();
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    const platform = table.readUInt16BE(record);
    const id = table.readUInt16BE(record + 6);
    const length = table.readUInt16BE(record + 8);
    const offset = table.readUInt16BE(record + 10);
    const raw = table.subarray(strings + offset, strings + offset + length);
    const text = platform === 1 ? raw.toString("latin1") : Buffer.from(raw).swap16().toString("utf16le");
    out.set(id, [...(out.get(id) ?? []), text]);
  }
  return out;
}
const manifest = JSON.parse(readFileSync(join(fontsDir, "manifest.json"), "utf8")) as Manifest;
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("brand/fonts/manifest.json", () => {
  it("lists every woff2 beside it, with the size and sha256 it has, and no other", () => {
    const listed = manifest.files.map((file) => file.file).sort();
    const present = readdirSync(fontsDir)
      .filter((name) => name.endsWith(".woff2"))
      .sort();
    expect(present).toEqual(listed);
    for (const file of manifest.files) {
      const path = join(fontsDir, file.file);
      expect(statSync(path).size, `${file.file} size`).toBe(file.bytes);
      expect(sha256(path), `${file.file} sha256`).toBe(file.sha256);
    }
  });

  it("gives each family one file for each weight, style and range of characters, each under 60 KB", () => {
    const seen = new Set<string>();
    for (const file of manifest.files) {
      const key = `${file.family}/${file.weight}/${file.style}/${file.range ?? "all"}`;
      expect(seen.has(key), `${key} twice`).toBe(false);
      seen.add(key);
      expect(file.bytes, file.file).toBeLessThan(60 * 1024);
      expect(
        manifest.families[file.family],
        `${file.file} names a family the manifest does not list`,
      ).toBeDefined();
    }
  });

  it("has an Open Font License beside each family, which names the license it is under", () => {
    for (const [family, info] of Object.entries(manifest.families)) {
      expect(info.license, family).toBe("OFL-1.1");
      const text = readFileSync(join(fontsDir, info.licenseFile), "utf8");
      expect(text, `${info.licenseFile} should be the OFL`).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
      expect(
        manifest.files.some((file) => file.family === family),
        `${family} has no file`,
      ).toBe(true);
    }
  });

  it("has the mono face in a real 400 and a real 600, so bold data text and the editor's chrome are not synthesized", () => {
    const weights = new Set(
      manifest.files.filter((file) => file.family === "IBM Plex Mono").map((f) => f.weight),
    );
    expect([...weights].sort()).toEqual([400, 600]);
  });

  it("makes each font pair of the four the deck format names, from families it holds, with a regular of each", () => {
    expect(Object.keys(manifest.pairs).sort()).toEqual([...FONT_PAIRS].sort());
    for (const [pair, roles] of Object.entries(manifest.pairs)) {
      for (const [role, family] of Object.entries(roles)) {
        expect(
          manifest.files.some(
            (file) => file.family === family && file.weight === 400 && file.style === "normal",
          ),
          `${pair} ${role} (${family}) has no regular`,
        ).toBe(true);
      }
    }
  });
});

describe("fonts whose license reserves their name", () => {
  const filesOf = (family: string) => manifest.files.filter((file) => file.family === family);
  const NAMES = [1, 3, 4, 6, 16, 17, 21, 22];

  it("says for every family which route it took, and whether what ships is a Modified Version", () => {
    for (const [family, info] of Object.entries(manifest.families)) {
      expect(["subset", "renamed-subset", "vendor-unmodified"], family).toContain(info.route);
      // A file copied from the vendor is the Original Version; anything this repo made from one is Modified.
      expect(info.modified, `${family} modified`).toBe(info.route !== "vendor-unmodified");
      if (info.route === "renamed-subset") expect(info.originalName, `${family} original name`).toBeTruthy();
      if (info.route === "subset") expect(info.reservedName, `${family} reserves no name`).toBe(false);
    }
  });

  it("ships each such font either as the vendor's own file or under another name", () => {
    const reserving = Object.entries(manifest.families).filter(([, info]) => info.reservedName);
    expect(reserving.map(([family]) => family).sort()).toEqual([
      "Depthcue Classic Sans",
      "Depthcue Classic Serif",
      "IBM Plex Mono",
      "IBM Plex Sans",
    ]);
    for (const [family, info] of reserving) {
      const reserved = String(info.reservedName).toLowerCase();
      for (const file of filesOf(family)) {
        const names = woff2Names(join(fontsDir, file.file));
        if (info.route === "vendor-unmodified") {
          // The bytes are the vendor's: the hash of this file is the hash of the one in the release.
          expect(file.sha256, `${file.file} is not IBM's file as released`).toBe(file.source.sourceSha256);
          expect(names.get(1)?.[0], `${file.file} family`).toContain(family);
          continue;
        }
        expect(info.route, family).toBe("renamed-subset");
        expect(family.toLowerCase(), `${family} is the reserved name`).not.toContain(reserved);
        expect(file.file.toLowerCase(), `${file.file} is named for the reserved name`).not.toContain(
          reserved,
        );
        // The name the font gives itself is the name the stylesheet gives it, and none of its names is the reserved one.
        expect(names.get(1), `${file.file} family name`).toContain(family);
        for (const id of NAMES)
          for (const text of names.get(id) ?? [])
            expect(text.toLowerCase(), `${file.file} name ${id}`).not.toContain(reserved);
        // The Copyright Holder's notices stay, as the license asks.
        expect(names.get(0)?.[0], `${file.file} copyright`).toMatch(/Adobe/);
        expect(names.get(13)?.[0], `${file.file} license`).toMatch(/SIL Open Font License/);
        expect(names.get(14)?.[0], `${file.file} license url`).toBeTruthy();
      }
    }
  });

  it("has the OFL beside each such family, with the reserved name in its copyright line", () => {
    for (const [family, info] of Object.entries(manifest.families)) {
      if (!info.reservedName) continue;
      const first = readFileSync(join(fontsDir, info.licenseFile), "utf8").split(/\r?\n/)[0];
      expect(first, `${family}: ${info.licenseFile}`).toContain(info.reservedName);
    }
  });
});

/**
 * The stack a pair rule declares, without the brand-face variable a stack starts with: `var(--dc-face-display,)` is
 * nothing when a deck has no brand, and the family of the face when it has one, so what a pair is drawn in is what follows.
 */
const withoutBrand = (stack: string) => stack.replace(/^\s*var\(--dc-face-[a-z]+,\)\s*/, "");
/** The first family of a `font-family` list, without its quotes. */
const firstFamily = (stack: string) => /^\s*"?([^",]+)"?/.exec(withoutBrand(stack))?.[1]?.trim();
const declared = (css: string, property: string) => new RegExp(`${property}:\\s*([^;]+);`).exec(css)?.[1];

describe("the font stacks of player.css", () => {
  const player = readFileSync(join(root, "packages", "player", "src", "player.css"), "utf8");
  const tokens = readFileSync(join(root, "brand", "tokens.css"), "utf8");
  const rule = (pair: string) =>
    new RegExp(`\\[data-fonts="${pair}"\\]\\s*\\{([^}]*)\\}`).exec(player)?.[1] ?? "";
  const hasWeight = (family: string, weight: number) =>
    manifest.files.some(
      (file) => file.family === family && file.weight === weight && file.style === "normal",
    );

  it("answer to the manifest: each pair's display and body fonts are the ones it names", () => {
    for (const [pair, roles] of Object.entries(manifest.pairs)) {
      const source = rule(pair);
      expect(source, `no rule for ${pair}`).not.toBe("");
      expect(firstFamily(declared(source, "--dc-font-display") ?? ""), `${pair} display`).toBe(roles.display);
      expect(firstFamily(declared(source, "--dc-font-ui") ?? ""), `${pair} body`).toBe(roles.body);
    }
  });

  it("repeat the editorial stacks of tokens.css, which a deck with a brand needs because it always names its pair", () => {
    const defaults = tokens.slice(0, tokens.indexOf("}"));
    for (const property of ["--dc-font-display", "--dc-font-ui"]) {
      expect(withoutBrand(declared(rule("editorial"), property) ?? ""), property).toBe(
        declared(defaults, property),
      );
    }
  });

  it("put a brand's face in front of every pair's display and body stack, and of the mono one, and nowhere else", () => {
    for (const pair of FONT_PAIRS) {
      expect(declared(rule(pair), "--dc-font-display"), `${pair} display`).toMatch(
        /^var\(--dc-face-display,\)\s/,
      );
      expect(declared(rule(pair), "--dc-font-ui"), `${pair} body`).toMatch(/^var\(--dc-face-body,\)\s/);
    }
    const any = /\[data-fonts\]\s*\{([^}]*)\}/.exec(player)?.[1] ?? "";
    expect(declared(any, "--dc-font-mono")).toMatch(/^var\(--dc-face-mono,\)\s/);
  });

  it("set data text in the one mono face every pair names, in the stack tokens.css has", () => {
    const mono = new Set(Object.values(manifest.pairs).map((roles) => roles.data));
    expect([...mono]).toEqual([firstFamily(declared(tokens, "--dc-font-mono") ?? "")]);
    for (const pair of FONT_PAIRS) expect(rule(pair)).not.toContain("--dc-font-mono");
    const any = /\[data-fonts\]\s*\{([^}]*)\}/.exec(player)?.[1] ?? "";
    expect(withoutBrand(declared(any, "--dc-font-mono") ?? "")).toBe(declared(tokens, "--dc-font-mono"));
  });

  it("set headings in a weight the display font has a file for, so none is made up by the browser", () => {
    for (const [pair, roles] of Object.entries(manifest.pairs)) {
      // editorial names no weight: headings take the 400 the stylesheet falls back to.
      const weight = pair === "editorial" ? 400 : Number(declared(rule(pair), "--dc-display-weight"));
      expect(hasWeight(roles.display, weight), `${pair}: ${roles.display} has no ${weight}`).toBe(true);
    }
  });
});

describe("scripts/build-fonts.mjs", () => {
  const out = mkdtempSync(join(tmpdir(), "depthcue-fonts-"));
  beforeAll(() => {
    execFileSync(process.execPath, [join(root, "packages", "player", "scripts", "build-fonts.mjs"), out], {
      stdio: "pipe",
    });
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));
  const urls = (css: string) => [...css.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1]);

  it("writes every font file as the manifest has it, and a stylesheet for each pair and for all of them", () => {
    expect(readdirSync(out).sort()).toEqual(
      [
        ...manifest.files.map((file) => file.file),
        "all.css",
        ...Object.keys(manifest.pairs).map((p) => `${p}.css`),
      ].sort(),
    );
    for (const file of manifest.files) expect(sha256(join(out, file.file)), file.file).toBe(file.sha256);
  });

  it("makes each pair's stylesheet name the faces of its own families and nothing else", () => {
    for (const [pair, roles] of Object.entries(manifest.pairs)) {
      const css = readFileSync(join(out, `${pair}.css`), "utf8");
      const families = new Set(Object.values(roles));
      const want = manifest.files.filter((file) => families.has(file.family)).map((file) => file.file);
      expect(urls(css), pair).toEqual(want);
      for (const file of manifest.files.filter((entry) => families.has(entry.family))) {
        expect(css).toContain(
          `font-family: "${file.family}";\n  font-style: ${file.style};\n  font-weight: ${file.weight};`,
        );
      }
    }
  });

  it("gives a file that covers only some characters the unicode-range IBM gives it, and no other file one", () => {
    const all = readFileSync(join(out, "all.css"), "utf8");
    const ranged = manifest.files.filter((file) => file.unicodeRange);
    expect(ranged.length).toBeGreaterThan(0);
    expect(all.match(/unicode-range:/g)?.length).toBe(ranged.length);
    for (const file of ranged)
      expect(all).toContain(`url("${file.file}") format("woff2");\n  unicode-range: ${file.unicodeRange};`);
  });

  it("names every file, once, in all.css, and each url sits beside the stylesheet", () => {
    const all = urls(readFileSync(join(out, "all.css"), "utf8"));
    expect([...all].sort()).toEqual(manifest.files.map((file) => file.file).sort());
    expect(all.every((url) => /^[A-Za-z0-9._-]+\.woff2$/.test(url as string))).toBe(true);
  });
});
