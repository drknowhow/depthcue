import { checkContent } from "./advice.ts";
import { assetRefs } from "./assets.ts";
import {
  BRAND_FILE,
  type BrandPart,
  checkBrandLock,
  checkSceneBrand,
  checkSceneForm,
  isTemplateFile,
  kitOf,
  TEMPLATES_DIR,
  templateIdOf,
  unusedBrand,
} from "./brand.ts";
import { type BrandData, readBrand } from "./brandcheck.ts";
import { type ChromeDeck, checkChromeDeck } from "./chrome.ts";
import { checkData } from "./data.ts";
import { explain } from "./diagnostics.ts";
import { checkFrames } from "./frames.ts";
import { checkLinkAssets, checkLinks, checkSceneLinks } from "./links.ts";
import { checkReferences } from "./references.ts";
import { deckSchema, sceneSchema } from "./schema.ts";
import { schemaValidator } from "./schemacheck.ts";
import { checkPalette, checkTones, styleOf } from "./style.ts";
import type { Brand, Deck, Diagnostic, Scene } from "./types.ts";
import { checkDeckVersion, checkSceneVersion, checkText } from "./versions.ts";

export const MANIFEST_FILE = "deck.json";
const validateDeck = /* @__PURE__ */ schemaValidator(deckSchema);
const validateScene = /* @__PURE__ */ schemaValidator(sceneSchema);
export const scenePath = (id: string): string => `scenes/${id}.json`;

/**
 * The files of a deck folder, as the loader found them. JSON files are text: deck.json, the scenes, and the brand's
 * brand.json and templates. Assets are only listed, and so are the brand's other files, its fonts, logos and images.
 */
export interface DeckFiles {
  /**
   * The JSON files' text by path, and for each brand file its sha256 (64 hex characters) under its own path, such as
   * `brand/fonts/Acme.woff2`. That is how the hashes travel with the files to the editor, whose Doc then has the
   * server's revision. A brand file without one counts toward no revision.
   *
   * A hash is never JSON to parse or text to write. Every reader takes only the paths it knows by pattern, which no
   * brand file's matches: `checkDeckFiles` and `loadDoc` read deck.json, scenes/, brand/brand.json and
   * brand/templates/*.json; `docToFiles` writes only those; the editor's save refuses any other path; and an export
   * copies brand files from the folder, not from here.
   */
  text: Readonly<Record<string, string>>;
  assets: Iterable<string>;
  /** Deck-relative paths of the files in the brand folder that are not JSON, such as `brand/fonts/Acme.woff2`. */
  brandFiles?: Iterable<string>;
}

/**
 * Everything checkable about deck.json alone: its structure, then that it declares its version and its contrast. Given
 * its brand, the contrast is of the brand's colors with the deck's on top, and a locked brand refuses the deck's own.
 */
export function checkManifest(data: unknown, file = MANIFEST_FILE, brand?: Brand): Diagnostic[] {
  if (!validateDeck(data)) return explain(validateDeck.errors, data, deckSchema, file);
  const deck = data as Deck;
  return [
    ...checkDeckVersion(deck, file),
    ...checkLinks(deck, file),
    ...checkBrandLock(deck, brand, file),
    ...checkPalette(deck, file, brand),
  ];
}

/**
 * A scene's structure, that it has a layout or a template and not both, and the length of its text as the audience
 * sees it, which the schema cannot count.
 */
export function checkScene(data: unknown, file: string): Diagnostic[] {
  const shape = validateScene(data) ? [] : explain(validateScene.errors, data, sceneSchema, file);
  const form = data !== null && typeof data === "object" ? checkSceneForm(data as Partial<Scene>, file) : [];
  return [...shape, ...form, ...checkText(data, file)];
}

function parse(text: string, file: string): { data?: unknown; diagnostic?: Diagnostic } {
  try {
    return { data: JSON.parse(text) };
  } catch (error) {
    return {
      diagnostic: {
        severity: "error",
        code: "json-parse",
        file,
        path: "",
        message: `Not valid JSON: ${(error as Error).message}`,
        fix: "Fix the syntax; every key and string needs double quotes and no trailing commas.",
      },
    };
  }
}

/**
 * Everything checkable about one scene: structure, that its id matches the listing, then (only for a
 * structurally sound scene) its internal references, its version, its tables and charts, and that its assets exist.
 * Given the deck, a valid one, it also checks the contrast of the tones its text uses against the deck's colors. Given
 * the deck's brand part, a sound one, it checks the template, slots and styles the scene names: an empty part is a deck
 * without a brand, whose scenes may name Depthcue's own.
 */
export function checkScenePart(
  data: unknown,
  file: string,
  expectedId: string,
  assets: ReadonlySet<string>,
  deck?: Deck,
  part?: BrandPart,
): Diagnostic[] {
  const out = checkScene(data, file);
  const sceneId = (data as { id?: unknown } | null)?.id;
  if (typeof sceneId === "string" && sceneId !== expectedId) {
    out.push({
      severity: "error",
      code: "scene-id-mismatch",
      file,
      path: "/id",
      message: `The file is listed as "${expectedId}" but its id is "${sceneId}".`,
      fix: `Make the id "${expectedId}", or rename the file and the manifest entry together.`,
    });
  }
  if (out.some((d) => d.code !== "scene-id-mismatch")) return out;
  const kit = part && kitOf(part);
  out.push(
    ...checkReferences(data as Scene, file),
    ...checkFrames(data as Scene, file),
    ...checkSceneVersion(data as Scene, file),
    ...(deck ? checkSceneLinks(data as Scene, deck, file) : []),
    ...checkData(data as Scene, file),
    ...(deck ? checkTones(data as Scene, styleOf(deck, part?.brand), file, kit) : []),
    ...(kit ? checkSceneBrand(data as Scene, kit, file) : []),
    ...checkContent(data as Scene, file),
  );
  for (const ref of assetRefs(data as Scene)) {
    if (!assets.has(ref.asset)) {
      out.push({
        severity: "error",
        code: "missing-asset",
        file,
        path: ref.path,
        message: `${ref.asset} does not exist.`,
        fix: "Add the file to the deck folder, or point at an existing asset.",
      });
    }
  }
  return out;
}

/** A file in the templates folder whose name is not a template id. */
const badTemplateName = (file: string): Diagnostic => ({
  severity: "error",
  code: "bad-template-name",
  file,
  path: "",
  message: `"${file.slice(TEMPLATES_DIR.length + 1, -".json".length)}" is not a template id, so this file holds no template.`,
  fix: "Rename it to the template's id: lowercase letters, digits and hyphens, a letter first, 2 to 64 characters, then .json.",
});

/**
 * The brand's JSON files of a deck folder, parsed, with what kept any of them from parsing. Templates are collected
 * as entries, so no id can reach a prototype however the file is named.
 */
function brandData(files: DeckFiles): { data: BrandData; problems: Diagnostic[] } {
  const templates: Array<[string, unknown]> = [];
  const problems: Diagnostic[] = [];
  let brand: unknown;
  for (const [file, text] of Object.entries(files.text)) {
    if (file !== BRAND_FILE && !isTemplateFile(file)) continue;
    const id = templateIdOf(file);
    if (file !== BRAND_FILE && id === undefined) {
      problems.push(badTemplateName(file));
      continue;
    }
    const read = parse(text, file);
    if (read.diagnostic) problems.push(read.diagnostic);
    else if (id === undefined) brand = read.data;
    else templates.push([id, read.data]);
  }
  const data = { templates: Object.fromEntries(templates) };
  return { data: brand === undefined ? data : { brand, ...data }, problems };
}

/** brand.json parsed, or undefined when it is missing or not JSON: only its id is wanted, for a fix line. */
const brandIn = (files: DeckFiles): unknown => {
  const text = files.text[BRAND_FILE];
  return text === undefined ? undefined : parse(text, BRAND_FILE).data;
};

/**
 * Structure of every file, plus the cross-file facts: scene files exist, asset files exist, nothing is orphaned, the
 * brand deck.json names is there and sound, and every template, slot and style a scene names is one the deck has.
 */
export function checkDeckFiles(files: DeckFiles): Diagnostic[] {
  const out: Diagnostic[] = [];
  const assets: ReadonlySet<string> = new Set(files.assets);
  const manifestText = files.text[MANIFEST_FILE];
  if (manifestText === undefined) {
    return [
      {
        severity: "error",
        code: "missing-file",
        file: MANIFEST_FILE,
        path: "",
        message: "The deck has no deck.json.",
        fix: "Create deck.json at the top of the deck folder.",
      },
    ];
  }

  const manifest = parse(manifestText, MANIFEST_FILE);
  if (manifest.diagnostic) return [manifest.diagnostic];
  // The brand is read only against a sound deck.json, which says whether the deck has one.
  let part: BrandPart | undefined;
  let brandProblems: Diagnostic[] = [];
  if (validateDeck(manifest.data)) {
    if ((manifest.data as Deck).brand === undefined) {
      // Brand files deck.json does not name are left unread, with a warning, and the scenes see Depthcue's own kit.
      part = {};
      const paths = Object.keys(files.text).filter((file) => file === BRAND_FILE || isTemplateFile(file));
      const first = paths.includes(BRAND_FILE) ? BRAND_FILE : paths[0];
      if (first !== undefined) brandProblems = [unusedBrand(first, brandIn(files), "warning")];
    } else {
      const { data, problems } = brandData(files);
      if (problems.length > 0) brandProblems = problems;
      else {
        const read = readBrand(manifest.data as Deck, data, new Set(files.brandFiles ?? []));
        part = read.part;
        brandProblems = read.diagnostics;
      }
    }
  }
  const manifestErrors = checkManifest(manifest.data, MANIFEST_FILE, part?.brand);
  out.push(...manifestErrors, ...brandProblems);
  // The tones of the scenes are checked against the deck's colors only when those are sound.
  const deck = manifestErrors.length === 0 ? (manifest.data as Deck) : undefined;
  if (deck) out.push(...checkLinkAssets(deck, assets, MANIFEST_FILE));

  const listed = new Set<string>();
  const slides: ChromeDeck["slides"][number][] = [];
  const ids = Array.isArray((manifest.data as { scenes?: unknown })?.scenes)
    ? ((manifest.data as { scenes: unknown[] }).scenes.filter((id) => typeof id === "string") as string[])
    : [];
  ids.forEach((id, index) => {
    listed.add(scenePath(id));
    const file = scenePath(id);
    const text = files.text[file];
    if (text === undefined) {
      out.push({
        severity: "error",
        code: "missing-file",
        file: MANIFEST_FILE,
        path: `/scenes/${index}`,
        message: `Scene "${id}" is listed but ${file} does not exist.`,
        fix: `Create ${file}, or remove "${id}" from "scenes".`,
      });
      return;
    }
    const scene = parse(text, file);
    if (scene.diagnostic) {
      out.push(scene.diagnostic);
      return;
    }
    out.push(...checkScenePart(scene.data, file, id, assets, deck, deck ? part : undefined));
    const found = scene.data as Partial<Scene> | null;
    if (found && typeof found === "object" && typeof found.title === "string")
      slides.push({ id, title: found.title, template: found.template, chrome: found.chrome });
  });
  if (deck && slides.length === ids.length) {
    out.push(
      ...checkChromeDeck(
        part?.brand?.chrome,
        { date: deck.date, numbering: deck.numbering, slides },
        MANIFEST_FILE,
      ),
    );
  }

  for (const file of Object.keys(files.text)) {
    if (file.startsWith("scenes/") && file.endsWith(".json") && !listed.has(file)) {
      out.push({
        severity: "warning",
        code: "orphan-scene-file",
        file,
        path: "",
        message: "This scene file is not listed in deck.json.",
        fix: `Add its id to "scenes" in deck.json, or delete the file.`,
      });
    }
  }
  return out;
}
