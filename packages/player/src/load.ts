import type { Deck, Scene } from "@depthcue/core";

/** A deck as the player reads it: the manifest, its scenes in listed order, and where assets resolve from. */
export interface PlayerSource {
  deck: Deck;
  scenes: Scene[];
  assetBase: string;
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
