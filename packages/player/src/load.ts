import type { Deck, DeckLook, Scene } from "@depthcue/core";
import { assetUrl } from "./safe.ts";

/** A deck as the player reads it: the manifest, its scenes in listed order, and where assets resolve from. */
export interface PlayerSource {
  deck: Deck;
  scenes: Scene[];
  assetBase: string;
  /**
   * How the deck looks, worked out beside the deck from its brand. Without it the deck is drawn in its theme, palette
   * and font pair alone, as a deck before schema 0.4 always is.
   */
  look?: DeckLook;
  /** JSON files the page already holds, by deck-relative path. An export embeds the cue maps this way. */
  files?: Readonly<Record<string, unknown>>;
}

/**
 * A JSON file of the deck by its deck-relative path, such as a clip's cue map: the copy the page holds when
 * there is one, otherwise the file beside the deck. Throws when there is neither, so a caller can fall back.
 */
export async function readDeckJson(source: PlayerSource, path: string): Promise<unknown> {
  if (source.files && Object.hasOwn(source.files, path)) return source.files[path];
  const url = assetUrl(source.assetBase, path);
  if (!url) throw new Error(`${path} is not a file the deck can read.`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.json();
}

async function getJson(url: string, signal: AbortSignal | undefined): Promise<unknown> {
  const response = await fetch(url, { cache: "no-cache", ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.json();
}

/**
 * The deck's look from `look.json` beside it, or undefined when the server has none: a folder served as plain files, or
 * a deck with errors. Any other failure throws, so a reload that meets one keeps showing the last good deck.
 */
async function getLook(url: string, signal: AbortSignal | undefined): Promise<DeckLook | undefined> {
  const response = await fetch(url, { cache: "no-cache", ...(signal ? { signal } : {}) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  try {
    const look = (await response.json()) as DeckLook;
    return typeof look === "object" && look !== null && "colors" in look ? look : undefined;
  } catch {
    // A static host that answers every address with its home page is not a server with a look to give.
    return undefined;
  }
}

/**
 * Fetches deck.json, the deck's look and every scene it lists, in parallel. The player trusts the shape because the
 * CLI and the editor validate before a deck is written; it still treats every string as untrusted when it renders.
 */
export async function loadDeck(base: string, signal?: AbortSignal): Promise<PlayerSource> {
  const root = base.replace(/\/+$/, "");
  const [deck, look] = await Promise.all([
    getJson(`${root}/deck.json`, signal) as Promise<Deck>,
    getLook(`${root}/look.json`, signal),
  ]);
  const scenes = (await Promise.all(
    deck.scenes.map((id) => getJson(`${root}/scenes/${encodeURIComponent(id)}.json`, signal)),
  )) as Scene[];
  return { deck, scenes, assetBase: root, ...(look ? { look } : {}) };
}
