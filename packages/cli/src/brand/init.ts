/**
 * `depthcue brand init`: a starter brand in an empty folder. It is brand.json and nothing else: the two palettes of the
 * presets (so there is a place to change a color), a built-in font pair, a footer and a slide number, no logo and no
 * templates of its own, because Depthcue's own are there for every brand. It passes `brand check` as it is.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BRAND_LIMITS, PALETTE_COLORS, PRESETS, type THEMES } from "@depthcue/core";
import type { Io } from "../index.ts";
import { checkBrandSource } from "./check.ts";

/** The id a name makes: lower case letters, digits and dashes, starting with a letter, 2 to 64 characters. */
export function idFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (slug.length === 0) return "brand";
  const lettered = /^[a-z]/.test(slug) ? slug : `brand-${slug}`.slice(0, 64).replace(/-+$/g, "");
  return lettered.length >= 2 ? lettered : "brand";
}

/** "acme-widgets" is "Acme Widgets". */
export function nameFromFolder(dir: string): string {
  const words = basename(resolve(dir))
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.length === 0 ? "Brand" : words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

/** The starter brand.json as an object. */
export function starterBrand(name: string): Record<string, unknown> {
  const palette = (theme: (typeof THEMES)[number]) =>
    Object.fromEntries(PALETTE_COLORS.map((color) => [color, PRESETS[theme][color]]));
  return {
    schemaVersion: "0.4",
    id: idFromName(name),
    name,
    colors: { paper: palette("paper"), ink: palette("ink") },
    fonts: "editorial",
    chrome: { footer: { text: name, place: "start" }, number: { place: "end" }, accent: "top" },
  };
}

/** Makes the folder's brand. Exit codes: 0 done, 2 the folder is not empty or cannot be written. */
export function brandInitCommand(dir: string, name: string | undefined, json: boolean, io: Io): number {
  const fail = (message: string): number => {
    if (json) io.out(JSON.stringify({ ok: false, message }, null, 2));
    else io.err(message);
    return 2;
  };
  const chosen = (name ?? nameFromFolder(dir)).trim();
  if (chosen.length === 0 || chosen.length > BRAND_LIMITS.name) {
    return fail(`--name needs 1 to ${BRAND_LIMITS.name} characters.`);
  }
  const found = statSync(dir, { throwIfNoEntry: false });
  if (found !== undefined && !found.isDirectory()) return fail(`${dir} is a file. Pick a folder.`);
  if (found !== undefined && readdirSync(dir).length > 0) {
    return fail(`${dir} has files in it, so nothing was written. Pick an empty or new folder.`);
  }
  const brand = starterBrand(chosen);
  // The starter is held to the same checks as any brand; this fails the command, not the author, if it ever slips.
  const checked = checkBrandSource({ brand, templates: {}, binaries: new Map() });
  if (checked.diagnostics.length > 0) {
    throw new Error(`The starter brand fails its own checks: ${checked.diagnostics[0]?.message}`);
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "brand.json"), `${JSON.stringify(brand, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    return fail(`Could not write ${dir}: ${(error as Error).message}`);
  }
  if (json) {
    io.out(JSON.stringify({ ok: true, dir, id: brand.id, name: chosen, files: ["brand.json"] }, null, 2));
  } else {
    io.out(`Made the brand "${chosen}" (${String(brand.id)}) in ${dir}`);
    io.out("  brand.json  the paper and ink palettes, the editorial fonts, a footer and a slide number");
    io.out(
      `Add a logo, fonts and templates beside it as you need them, check it with: depthcue brand check ${dir}`,
    );
    io.out(`Put it in a deck with: depthcue brand use ${dir} <deck-folder>`);
  }
  return 0;
}
