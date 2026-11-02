import { BRAND_FILE, type BrandPart, kitOf, templateIdOf, templatePath } from "./brand.ts";
import { readBrand } from "./brandcheck.ts";
import { canonicalJson, sha256Hex } from "./revision.ts";
import { checkTones, colorsKey, styleOf } from "./style.ts";
import type { Brand, Deck, Diagnostic, Scene, Template } from "./types.ts";
import {
  checkDeckFiles,
  checkManifest,
  checkScenePart,
  type DeckFiles,
  MANIFEST_FILE,
  scenePath,
} from "./validate.ts";

/**
 * A deck in memory. Always valid: it only comes from `loadDoc` or from a transaction that passed validation.
 * Treat it as immutable. Operations return a new Doc that shares every scene they did not touch.
 */
export interface Doc {
  readonly deck: Deck;
  /** Keyed by scene id; exactly the ids listed in `deck.scenes`. */
  readonly scenes: Readonly<Record<string, Scene>>;
  /** Asset paths present in the deck folder. Not part of the revision. */
  readonly assets: ReadonlySet<string>;
  /** `brand/brand.json`, when deck.json names a brand. Part of the revision. */
  readonly brand?: Brand | undefined;
  /** The brand's templates, by id, from `brand/templates/`: there exactly when `brand` is. Part of the revision. */
  readonly templates?: Readonly<Record<string, Template>> | undefined;
  /** Paths of the brand folder's other files, its fonts, logos and images, such as `brand/fonts/Acme.woff2`. */
  readonly brandFiles?: ReadonlySet<string> | undefined;
  /**
   * The sha256 of each of `brandFiles`, by path, as 64 hex characters. Part of the revision, so a font replaced on disk
   * makes the next save stale. Deck files carry each in `text`, under the file's own path (see `DeckFiles`).
   */
  readonly brandHashes?: Readonly<Record<string, string>> | undefined;
}

/** What `loadDoc` read for a set of brand files, so a draft recovered against them gets the same hashes. */
const hashesOfFiles = new WeakMap<ReadonlySet<string>, Readonly<Record<string, string>>>();

/** The hashes `loadDoc` read with this set of brand files, the one a loaded Doc carries. */
export const brandHashesOf = (
  files: ReadonlySet<string> | undefined,
): Readonly<Record<string, string>> | undefined => files && hashesOfFiles.get(files);

/** `doc` with the brand file at `path` (`brand/...`) added or replaced with its `hash`, or removed with null. */
export function withBrandFile(doc: Doc, path: string, hash: string | null): Doc {
  const files = new Set(doc.brandFiles);
  const hashes: Record<string, string> = { ...doc.brandHashes };
  if (hash === null) {
    files.delete(path);
    delete hashes[path];
  } else {
    files.add(path);
    hashes[path] = hash;
  }
  return { ...doc, brandFiles: files, brandHashes: hashes };
}

/**
 * A revision with brand files' hashes folded in. None leaves it as it is, so a deck without brand files keeps the
 * revision it had before they counted, and a revision stored then can be carried over by folding them in.
 */
export const withBrandHashes = (rev: string, hashes: Readonly<Record<string, string>> | undefined): string =>
  hashes && Object.keys(hashes).length > 0 ? sha256Hex(`${rev}\n${canonicalJson(hashes)}`).slice(0, 16) : rev;

/**
 * The brand files' hashes that count: a deck's that has a brand. Files in a brand folder that deck.json does not name
 * change nothing a deck shows, so they are no edit, as its templates are none.
 */
export const countedHashes = (doc: Pick<Doc, "brand" | "brandHashes">): Doc["brandHashes"] =>
  doc.brand === undefined ? undefined : doc.brandHashes;

const sceneRevisions = new WeakMap<Scene, string>();

export function sceneRevision(scene: Scene): string {
  let hash = sceneRevisions.get(scene);
  if (hash === undefined) {
    hash = sha256Hex(canonicalJson(scene));
    sceneRevisions.set(scene, hash);
  }
  return hash;
}

/** The brand part of a revision: brand.json, then each template in id order. */
const brandRevision = (doc: Doc): string =>
  sha256Hex(
    canonicalJson({
      brand: doc.brand,
      templates: Object.keys(doc.templates ?? {})
        .sort()
        .map((id) => doc.templates?.[id]),
    }),
  );

/**
 * Content hash of the deck and its scenes in listed order: 16 hex characters. Stored nowhere; equal content
 * always gives an equal revision, however the files were formatted. Scene hashes are cached per object, so
 * a change to one scene rehashes only that scene. A branded deck's brand.json and templates count too, and the brand
 * folder's files by their hashes; a deck without a brand or brand files hashes exactly as it did before brands.
 */
export function revisionOf(doc: Doc): string {
  const parts = doc.deck.scenes.map((id) => sceneRevision(doc.scenes[id] as Scene));
  const brand = doc.brand === undefined && doc.templates === undefined ? "" : `\n${brandRevision(doc)}`;
  return withBrandHashes(
    sha256Hex(`${canonicalJson(doc.deck)}\n${parts.join(",")}${brand}`).slice(0, 16),
    countedHashes(doc),
  );
}

/** The brand of a Doc, as the scene checks take it. */
export const brandPartOf = (doc: Doc): BrandPart =>
  doc.brand === undefined ? {} : { brand: doc.brand, templates: doc.templates ?? {} };

export type LoadResult = { doc: Doc; diagnostics: Diagnostic[] } | { doc: null; diagnostics: Diagnostic[] };

/** Builds a Doc from deck files. `doc` is null when any error was found; warnings travel with a good Doc. */
export function loadDoc(files: DeckFiles): LoadResult {
  const diagnostics = checkDeckFiles(files);
  if (diagnostics.some((d) => d.severity === "error")) return { doc: null, diagnostics };
  const deck = JSON.parse(files.text[MANIFEST_FILE] as string) as Deck;
  const scenes: Record<string, Scene> = {};
  for (const id of deck.scenes) scenes[id] = JSON.parse(files.text[scenePath(id)] as string) as Scene;
  const assets = new Set(files.assets);
  const brandFiles = new Set(files.brandFiles ?? []);
  const hashes: Record<string, string> = Object.fromEntries(
    [...brandFiles].flatMap((path) =>
      Object.hasOwn(files.text, path) ? [[path, files.text[path] as string]] : [],
    ),
  );
  hashesOfFiles.set(brandFiles, hashes);
  // Kept even without a brand, so that a brand made later can name the fonts and logos already in the folder.
  const binaries =
    brandFiles.size > 0
      ? { brandFiles, ...(Object.keys(hashes).length > 0 ? { brandHashes: hashes } : {}) }
      : {};
  if (deck.brand === undefined) return { doc: { deck, scenes, assets, ...binaries }, diagnostics };
  const brand = JSON.parse(files.text[BRAND_FILE] as string) as Brand;
  // Entries, not assignment, so that no id can reach a prototype.
  const templates: Record<string, Template> = Object.fromEntries(
    Object.entries(files.text).flatMap(([path, text]) => {
      const id = templateIdOf(path);
      return id === undefined ? [] : [[id, JSON.parse(text) as Template]];
    }),
  );
  return { doc: { deck, scenes, assets, brand, templates, ...binaries }, diagnostics };
}

/** The JSON files for a Doc, as written to disk: two-space indent and a trailing newline. */
export function docToFiles(doc: Doc): Record<string, string> {
  const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const files: Record<string, string> = { [MANIFEST_FILE]: text(doc.deck) };
  for (const id of doc.deck.scenes) files[scenePath(id)] = text(doc.scenes[id]);
  if (doc.brand !== undefined) files[BRAND_FILE] = text(doc.brand);
  for (const [id, template] of Object.entries(doc.templates ?? {})) files[templatePath(id)] = text(template);
  return files;
}

/** Full validation of a Doc. A Doc made by this package is already valid; use this on one assembled by hand. */
export function checkDoc(doc: Doc): Diagnostic[] {
  const read =
    doc.brand === undefined && doc.templates === undefined && doc.deck.brand === undefined
      ? { part: {}, diagnostics: [] }
      : readBrand(
          doc.deck,
          doc.brand === undefined
            ? { templates: doc.templates ?? {} }
            : { brand: doc.brand, templates: doc.templates ?? {} },
          doc.brandFiles ?? new Set(),
        );
  const out = checkManifest(doc.deck, MANIFEST_FILE, read.part?.brand);
  const deck = out.length === 0 ? doc.deck : undefined;
  out.push(...read.diagnostics);
  for (const id of doc.deck.scenes) {
    const scene = doc.scenes[id];
    if (scene === undefined) {
      out.push({
        severity: "error",
        code: "missing-file",
        file: MANIFEST_FILE,
        path: `/scenes/${doc.deck.scenes.indexOf(id)}`,
        message: `Scene "${id}" is listed but has no content.`,
        fix: `Add the scene, or remove "${id}" from "scenes".`,
      });
    } else {
      out.push(...checkScenePart(scene, scenePath(id), id, doc.assets, deck, deck ? read.part : undefined));
    }
  }
  return out;
}

/**
 * Validates only what differs from `before`, relying on `before` being valid. A change to the deck's colors is checked
 * against the tones of every scene, since a scene that did not change may use a tone that no longer has the contrast.
 * A change to the brand, its templates, or a branded deck's colors checks the whole deck again: any scene may use a
 * template or style that changed, and the brand's colors are checked against the deck's.
 */
export function checkChanges(before: Doc, after: Doc): Diagnostic[] {
  if (
    after.brand !== before.brand ||
    after.templates !== before.templates ||
    after.deck.brand !== before.deck.brand ||
    (after.brand !== undefined && colorsKey(before.deck, before.brand) !== colorsKey(after.deck, after.brand))
  ) {
    return checkDoc(after);
  }
  const part = brandPartOf(after);
  const out = after.deck === before.deck ? [] : checkManifest(after.deck, MANIFEST_FILE, after.brand);
  const deck = out.some((d) => d.severity === "error") ? undefined : after.deck;
  const recolored =
    deck !== undefined && after.deck !== before.deck && colorsKey(before.deck) !== colorsKey(deck);
  for (const id of after.deck.scenes) {
    const scene = after.scenes[id];
    if (scene !== undefined && scene !== before.scenes[id]) {
      out.push(...checkScenePart(scene, scenePath(id), id, after.assets, deck, deck ? part : undefined));
    } else if (scene !== undefined && deck !== undefined && recolored) {
      out.push(...checkTones(scene, styleOf(deck, after.brand), scenePath(id), kitOf(part)));
    }
  }
  return out;
}
