/**
 * `depthcue brand check`: the checks of a brand and of each of its templates, reported the way `depthcue check`
 * reports a deck. A brand folder is checked as a deck would check it, on both presets. A deck folder is checked as
 * `depthcue check` does, and the report keeps what is about its brand.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  type BrandData,
  type BrandPart,
  BUILT_IN_TEMPLATES,
  blockStylesOf,
  brandFilePath,
  checkTemplate,
  type Deck,
  type Diagnostic,
  type Look,
  loadDoc,
  readBrand,
  styleOf,
  THEMES,
} from "@depthcue/core";
import type { Io } from "../index.ts";
import { report, summary } from "../index.ts";
import { loadDeckDir } from "../loader.ts";
import { BrandFolderError, readBrandFolder } from "./source.ts";

const COUNT = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.filter((d) => d.severity === "error").length;

/**
 * Depthcue's own templates under this brand's palettes and styles, as warnings: they are not the brand's files, so a
 * color that fails there is not an error in the brand, but a deck that uses the template would show it. A template the
 * brand replaces by id, and all of them when the brand hides them, are left out.
 */
export function builtInWarnings(part: BrandPart, brandFiles: ReadonlySet<string>): Diagnostic[] {
  const brand = part.brand;
  if (brand === undefined || brand.hideBuiltIn?.includes("templates")) return [];
  const styles = blockStylesOf(part);
  const looks: Look[] = THEMES.map((theme) => ({ theme, colors: styleOf({ theme }, brand).colors }));
  const out: Diagnostic[] = [];
  for (const [id, template] of Object.entries(BUILT_IN_TEMPLATES)) {
    if (Object.hasOwn(part.templates ?? {}, id)) continue;
    for (const found of checkTemplate(template, styles, looks, brandFiles, "brand.json")) {
      out.push({
        ...found,
        severity: "warning",
        file: "brand.json",
        path: "",
        code: `built-in-${found.code}`,
        message: `Depthcue's own template "${id}"${found.path} under this brand: ${found.message}`,
      });
    }
  }
  return out;
}

const withoutBrandDir = (file: string): string =>
  file.startsWith("brand/") ? file.slice("brand/".length) : file;

/**
 * Every finding about a brand folder: its files, its templates, and its colors on both presets, then Depthcue's own
 * templates under it as warnings. Files are named from the brand folder, as `brand.json` and `templates/cover.json`.
 */
export function checkBrandSource(source: {
  brand: unknown;
  templates: Readonly<Record<string, unknown>>;
  binaries: ReadonlyMap<string, unknown>;
}): { diagnostics: Diagnostic[]; part?: BrandPart } {
  const files = new Set([...source.binaries.keys()].map(brandFilePath));
  const data: BrandData = { brand: source.brand, templates: source.templates };
  const named = (source.brand as { id?: unknown } | null | undefined)?.id;
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const add = (found: Diagnostic): void => {
    const key = JSON.stringify([found.severity, found.file, found.path, found.code, found.message]);
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push({ ...found, file: withoutBrandDir(found.file) });
  };
  let part: BrandPart | undefined;
  // A deck on each preset: the brand's colors are checked on every preset it gives a palette for and on the deck's.
  for (const theme of THEMES) {
    const deck = {
      schemaVersion: "0.4",
      id: "brand-check",
      title: "Brand check",
      language: "en",
      theme,
      brand: typeof named === "string" ? named : "brand",
      scenes: [],
    } as unknown as Deck;
    const read = readBrand(deck, data, files);
    for (const found of read.diagnostics) add(found);
    part ??= read.part;
  }
  if (part?.brand !== undefined && !diagnostics.some((found) => found.severity === "error")) {
    for (const found of builtInWarnings(part, files)) add(found);
  }
  return part === undefined ? { diagnostics } : { diagnostics, part };
}

const isAboutBrand = (found: Diagnostic): boolean =>
  found.file.startsWith("brand/") || found.path === "/brand" || /brand/.test(found.code);

const exists = (path: string): boolean => statSync(path, { throwIfNoEntry: false }) !== undefined;

/** Checks a brand folder or a deck folder and prints the report. */
export function brandCheckCommand(target: string, json: boolean, io: Io): number {
  try {
    if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      io.err(`${target} is not a folder.`);
      return 2;
    }
    if (exists(join(target, "deck.json"))) {
      const files = loadDeckDir(target);
      const { doc, diagnostics } = loadDoc(files);
      const found = diagnostics.filter(isAboutBrand);
      if (doc?.brand !== undefined) {
        found.push(
          ...builtInWarnings(
            { brand: doc.brand, templates: doc.templates ?? {} },
            doc.brandFiles ?? new Set(),
          ),
        );
      }
      const brand = doc?.brand ?? undefined;
      report(io, found, json, { kind: "deck", brand: brand ? { id: brand.id, name: brand.name } : null });
      if (!json) {
        if (doc !== null && brand === undefined) io.out("The deck has no brand.");
        io.out(summary(found));
      }
      return COUNT(found) === 0 ? 0 : 1;
    }
    const source = readBrandFolder(target);
    const { diagnostics, part } = checkBrandSource(source);
    const brand = part?.brand;
    report(io, diagnostics, json, {
      kind: "brand",
      brand: brand ? { id: brand.id, name: brand.name } : null,
    });
    if (!json) io.out(summary(diagnostics));
    return COUNT(diagnostics) === 0 ? 0 : 1;
  } catch (error) {
    if (!(error instanceof BrandFolderError)) throw error;
    if (json) io.out(JSON.stringify({ ok: false, message: error.message }, null, 2));
    else io.err(error.message);
    return 2;
  }
}
