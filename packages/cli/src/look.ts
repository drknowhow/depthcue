/**
 * The look of a deck folder as the page's `/look.json` serves it. A deck that has an error in one scene still has a
 * brand, and its cover and section slides lose their look the moment the page cannot get it, so the look is built from
 * what the page needs of the folder: a sound deck.json and a sound brand. A scene that does not read, or that fails
 * its own checks, only means that scene names no template here; the checks still say so wherever they are asked.
 */
import {
  BRAND_FILE,
  type Brand,
  checkDeckFiles,
  type Deck,
  type DeckFiles,
  type DeckLook,
  type Diagnostic,
  lookOf,
  MANIFEST_FILE,
  type Scene,
  scenePath,
  type Template,
  templateIdOf,
} from "@depthcue/core";

/**
 * An error that stops the look: one in deck.json or in the brand. The check files a missing scene file under deck.json,
 * at the scene's place in the list, which is a problem with that scene and not with the deck.
 */
const stopsLook = (diagnostic: Diagnostic): boolean =>
  diagnostic.severity === "error" &&
  (diagnostic.file.startsWith("brand/") ||
    (diagnostic.file === MANIFEST_FILE && !diagnostic.path.startsWith("/scenes/")));

/** The look of the deck in `files`, or undefined when deck.json or the brand cannot be read. */
export function lookOfFiles(files: DeckFiles): DeckLook | undefined {
  try {
    if (checkDeckFiles(files).some(stopsLook)) return undefined;
    const deck = JSON.parse(files.text[MANIFEST_FILE] as string) as Deck;
    const scenes: Record<string, Scene> = {};
    for (const id of deck.scenes) {
      try {
        const scene = JSON.parse(files.text[scenePath(id)] ?? "") as Scene;
        if (Array.isArray(scene.blocks)) scenes[id] = scene;
      } catch {
        // A scene that does not read names no template, and the check has already said why.
      }
    }
    if (deck.brand === undefined) return lookOf({ deck, scenes });
    const brand = JSON.parse(files.text[BRAND_FILE] as string) as Brand;
    // Entries, not assignment, so that no id can reach a prototype.
    const templates: Record<string, Template> = Object.fromEntries(
      Object.entries(files.text).flatMap(([path, text]) => {
        const id = templateIdOf(path);
        return id === undefined ? [] : [[id, JSON.parse(text) as Template]];
      }),
    );
    return lookOf({ deck, scenes, brand, templates });
  } catch {
    return undefined;
  }
}
