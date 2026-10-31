import { assetRefs } from "./assets.ts";
import { explain } from "./diagnostics.ts";
import { validateDeck, validateScene } from "./generated/validators.js";
import { checkReferences } from "./references.ts";
import { deckSchema, sceneSchema } from "./schema.ts";
import type { Diagnostic, Scene } from "./types.ts";

export const MANIFEST_FILE = "deck.json";
export const scenePath = (id: string): string => `scenes/${id}.json`;

/** The files of a deck folder, as the loader found them. JSON files are text; assets are only listed. */
export interface DeckFiles {
  text: Readonly<Record<string, string>>;
  assets: Iterable<string>;
}

export function checkManifest(data: unknown, file = MANIFEST_FILE): Diagnostic[] {
  return validateDeck(data) ? [] : explain(validateDeck.errors, data, deckSchema, file);
}

export function checkScene(data: unknown, file: string): Diagnostic[] {
  return validateScene(data) ? [] : explain(validateScene.errors, data, sceneSchema, file);
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
 * structurally sound scene) its internal references and that its assets exist.
 */
export function checkScenePart(
  data: unknown,
  file: string,
  expectedId: string,
  assets: ReadonlySet<string>,
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
  out.push(...checkReferences(data as Scene, file));
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

/** Structure of every file, plus the cross-file facts: scene files exist, asset files exist, nothing is orphaned. */
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
  const manifestErrors = checkManifest(manifest.data);
  out.push(...manifestErrors);

  const listed = new Set<string>();
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
    out.push(...checkScenePart(scene.data, file, id, assets));
  });

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
