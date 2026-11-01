import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FONT_PAIRS } from "@depthcue/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const fontsDir = join(root, "brand", "fonts");

interface FontFile {
  file: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  bytes: number;
  sha256: string;
}
interface Manifest {
  families: Record<string, { license: string; licenseFile: string; reservedName: string | false }>;
  pairs: Record<string, { display: string; body: string; data: string }>;
  files: FontFile[];
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

  it("gives each family one file for each weight and style, each under 60 KB", () => {
    const seen = new Set<string>();
    for (const file of manifest.files) {
      const key = `${file.family}/${file.weight}/${file.style}`;
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

/** The first family of a `font-family` list, without its quotes. */
const firstFamily = (stack: string) => /^\s*"?([^",]+)"?/.exec(stack)?.[1]?.trim();
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
      // editorial is the default, so tokens.css has its stacks and player.css has no rule for it.
      const source = pair === "editorial" ? tokens.slice(0, tokens.indexOf("}")) : rule(pair);
      expect(source, `no rule for ${pair}`).not.toBe("");
      expect(firstFamily(declared(source, "--dc-font-display") ?? ""), `${pair} display`).toBe(roles.display);
      expect(firstFamily(declared(source, "--dc-font-ui") ?? ""), `${pair} body`).toBe(roles.body);
    }
  });

  it("set data text in the one mono face every pair names", () => {
    const mono = new Set(Object.values(manifest.pairs).map((roles) => roles.data));
    expect([...mono]).toEqual([firstFamily(declared(tokens, "--dc-font-mono") ?? "")]);
    for (const pair of FONT_PAIRS) expect(rule(pair)).not.toContain("--dc-font-mono");
  });

  it("set headings in a weight the display font has a file for, so none is made up by the browser", () => {
    for (const [pair, roles] of Object.entries(manifest.pairs)) {
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

  it("names every file, once, in all.css, and each url sits beside the stylesheet", () => {
    const all = urls(readFileSync(join(out, "all.css"), "utf8"));
    expect([...all].sort()).toEqual(manifest.files.map((file) => file.file).sort());
    expect(all.every((url) => /^[A-Za-z0-9._-]+\.woff2$/.test(url as string))).toBe(true);
  });
});
