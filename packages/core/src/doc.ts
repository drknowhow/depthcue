import { canonicalJson, sha256Hex } from "./revision.ts";
import type { Deck, Diagnostic, Scene } from "./types.ts";
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
}

const sceneRevisions = new WeakMap<Scene, string>();

export function sceneRevision(scene: Scene): string {
  let hash = sceneRevisions.get(scene);
  if (hash === undefined) {
    hash = sha256Hex(canonicalJson(scene));
    sceneRevisions.set(scene, hash);
  }
  return hash;
}

/**
 * Content hash of the deck and its scenes in listed order: 16 hex characters. Stored nowhere; equal content
 * always gives an equal revision, however the files were formatted. Scene hashes are cached per object, so
 * a change to one scene rehashes only that scene.
 */
export function revisionOf(doc: Doc): string {
  const parts = doc.deck.scenes.map((id) => sceneRevision(doc.scenes[id] as Scene));
  return sha256Hex(`${canonicalJson(doc.deck)}\n${parts.join(",")}`).slice(0, 16);
}

export type LoadResult = { doc: Doc; diagnostics: Diagnostic[] } | { doc: null; diagnostics: Diagnostic[] };

/** Builds a Doc from deck files. `doc` is null when any error was found; warnings travel with a good Doc. */
export function loadDoc(files: DeckFiles): LoadResult {
  const diagnostics = checkDeckFiles(files);
  if (diagnostics.some((d) => d.severity === "error")) return { doc: null, diagnostics };
  const deck = JSON.parse(files.text[MANIFEST_FILE] as string) as Deck;
  const scenes: Record<string, Scene> = {};
  for (const id of deck.scenes) scenes[id] = JSON.parse(files.text[scenePath(id)] as string) as Scene;
  return { doc: { deck, scenes, assets: new Set(files.assets) }, diagnostics };
}

/** The JSON files for a Doc, as written to disk: two-space indent and a trailing newline. */
export function docToFiles(doc: Doc): Record<string, string> {
  const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const files: Record<string, string> = { [MANIFEST_FILE]: text(doc.deck) };
  for (const id of doc.deck.scenes) files[scenePath(id)] = text(doc.scenes[id]);
  return files;
}

/** Full validation of a Doc. A Doc made by this package is already valid; use this on one assembled by hand. */
export function checkDoc(doc: Doc): Diagnostic[] {
  const out = checkManifest(doc.deck);
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
      out.push(...checkScenePart(scene, scenePath(id), id, doc.assets));
    }
  }
  return out;
}

/** Validates only what differs from `before`, relying on `before` being valid. */
export function checkChanges(before: Doc, after: Doc): Diagnostic[] {
  const out = after.deck === before.deck ? [] : checkManifest(after.deck);
  for (const id of after.deck.scenes) {
    const scene = after.scenes[id];
    if (scene !== undefined && scene !== before.scenes[id]) {
      out.push(...checkScenePart(scene, scenePath(id), id, after.assets));
    }
  }
  return out;
}
