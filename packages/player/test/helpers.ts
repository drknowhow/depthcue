import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Deck, Scene } from "@depthcue/core";
import type { PlayerSource } from "../src/load.ts";

// happy-dom replaces the global URL, so the path is built from dirname rather than from import.meta.url.
export const demoDir = resolve(import.meta.dirname, "../../../fixtures/decks/demo");

const read = (path: string) => JSON.parse(readFileSync(join(demoDir, path), "utf8"));

/** The demo deck as the player receives it, scenes in deck order. */
export function demoSource(): PlayerSource {
  const deck = read("deck.json") as Deck;
  const files = new Set(readdirSync(join(demoDir, "scenes")));
  const scenes = deck.scenes.map((id) => {
    if (!files.has(`${id}.json`)) throw new Error(`the demo deck lists ${id} but has no such scene`);
    return read(`scenes/${id}.json`) as Scene;
  });
  return { deck, scenes, assetBase: "." };
}

export function sceneWith(overrides: Record<string, unknown>): Scene {
  return {
    schemaVersion: "0.1",
    id: "test-scene",
    title: "Test scene",
    layout: "title",
    blocks: [{ id: "test-heading", type: "text", role: "heading", text: "Hello" }],
    ...overrides,
  } as Scene;
}
