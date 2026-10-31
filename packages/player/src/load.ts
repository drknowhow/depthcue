import type { Deck, Scene } from "@depthcue/core";
import { assetUrl } from "./safe.ts";

/** A deck as the player reads it: the manifest, its scenes in listed order, and where assets resolve from. */
export interface PlayerSource {
  deck: Deck;
  scenes: Scene[];
  assetBase: string;
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
 * Fetches deck.json and every scene it lists, in parallel. The player trusts the shape because the CLI and
 * the editor validate before a deck is written; it still treats every string as untrusted when it renders.
 */
export async function loadDeck(base: string, signal?: AbortSignal): Promise<PlayerSource> {
  const root = base.replace(/\/+$/, "");
  const deck = (await getJson(`${root}/deck.json`, signal)) as Deck;
  const scenes = (await Promise.all(
    deck.scenes.map((id) => getJson(`${root}/scenes/${encodeURIComponent(id)}.json`, signal)),
  )) as Scene[];
  return { deck, scenes, assetBase: root };
}
