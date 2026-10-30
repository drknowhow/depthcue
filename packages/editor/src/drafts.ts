import type { DraftStore } from "@depthcue/core";

/**
 * A draft in localStorage under one key. The storage is looked up on every call, because reading it can throw
 * (blocked site data, private windows) and the autosave reports that instead of stopping the editor.
 */
export function browserDraftStore(key: string, storage: () => Storage = () => localStorage): DraftStore {
  return {
    read: () => storage().getItem(key),
    write: (text) => storage().setItem(key, text),
    clear: () => storage().removeItem(key),
  };
}

export const draftKey = (deckId: string): string => `depthcue:draft:${deckId}`;
