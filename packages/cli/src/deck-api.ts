import {
  applyOps,
  type Block,
  type Diagnostic,
  type Doc,
  loadDoc,
  revisionOf,
  type Scene,
  sceneRevision,
} from "@depthcue/core";
import { loadDeckDir } from "./loader.ts";
import { ChangedOnDiskError, saveDeckDir } from "./save.ts";

/** How much a read returns. Concise is for deciding what to do next; detailed is for doing it. */
export type Detail = "concise" | "detailed";

export type OpenResult =
  | { ok: true; doc: Doc; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

/** Reads a deck folder into a Doc. Fails, with every error, when the deck is not valid. */
export function openDeck(folder: string): OpenResult {
  const { doc, diagnostics } = loadDoc(loadDeckDir(folder));
  return doc ? { ok: true, doc, diagnostics } : { ok: false, diagnostics };
}

const blockSummary = (block: Block) => ({
  id: block.id,
  type: block.type,
  ...(block.frame === undefined ? {} : { frame: block.frame }),
});

export function getOutline(doc: Doc, detail: Detail = "concise") {
  return {
    rev: revisionOf(doc),
    id: doc.deck.id,
    title: doc.deck.title,
    theme: doc.deck.theme,
    language: doc.deck.language,
    scenes: doc.deck.scenes.map((id) => {
      const scene = doc.scenes[id] as Scene;
      const pinned = scene.blocks.filter((block) => block.frame !== undefined).length;
      const base = {
        id,
        title: scene.title,
        layout: scene.layout,
        lead: scene.lead ?? "human",
        blocks: scene.blocks.length,
        steps: scene.steps?.length ?? 0,
        ...(pinned > 0 ? { pinned } : {}),
      };
      return detail === "concise"
        ? base
        : {
            ...base,
            rev: sceneRevision(scene).slice(0, 16),
            summary: scene.summary?.text,
            blockList: scene.blocks.map(blockSummary),
            hasNotes: scene.notes !== undefined,
            hasReading: scene.reading !== undefined,
          };
    }),
  };
}

export type SceneResult =
  | { ok: true; rev: string; sceneRev: string; scene: Scene; assets?: string[] }
  | { ok: false; message: string };

/** Levenshtein-free closest match: enough to catch a typo or a wrong case in a scene id. */
function suggest(ids: readonly string[], wanted: string): string | undefined {
  const lower = wanted.toLowerCase();
  return (
    ids.find((id) => id.toLowerCase() === lower) ?? ids.find((id) => id.includes(lower) || lower.includes(id))
  );
}

export function getScene(doc: Doc, id: string, detail: Detail = "concise"): SceneResult {
  const scene = doc.scenes[id];
  if (!scene) {
    const near = suggest(doc.deck.scenes, id);
    return {
      ok: false,
      message: `There is no scene "${id}". ${near ? `Did you mean "${near}"? ` : ""}Scenes are: ${doc.deck.scenes.join(", ")}.`,
    };
  }
  const result: SceneResult = {
    ok: true,
    rev: revisionOf(doc),
    sceneRev: sceneRevision(scene).slice(0, 16),
    scene,
  };
  if (detail === "detailed") result.assets = [...doc.assets].sort();
  return result;
}

export type ApplyOutcome =
  | {
      ok: true;
      prevRev: string;
      rev: string;
      changed: string[];
      removed: string[];
      written: string[];
      diagnostics: Diagnostic[];
    }
  | {
      ok: false;
      code: "unreadable-deck" | "stale-revision" | "bad-op" | "invalid-deck" | "changed-on-disk";
      /** The deck's current revision, when it could be read. */
      rev?: string;
      diagnostics: Diagnostic[];
      /** What to do next, in words an agent can act on. */
      hint: string;
    };

const HINTS = {
  "unreadable-deck":
    "The deck folder has errors that must be fixed by hand first. Run `depthcue check` on it.",
  "bad-op":
    "Nothing was applied. Fix the operations named in the diagnostics and send them again with the same base_rev.",
  "invalid-deck":
    "Every operation applied, but the result is not a valid deck, so nothing was kept. Fix what the diagnostics name and send the operations again with the same base_rev.",
  "changed-on-disk":
    "The deck folder changed while the edit was being applied. Nothing was written. Read the deck again with deck_get, then redo the edit with the new revision.",
} as const;

/**
 * Applies operations to the deck in a folder as one transaction and writes the result atomically. The edit is
 * rejected, with the files untouched, when `baseRev` is not the folder's current revision.
 */
export function applyToFolder(folder: string, ops: unknown, baseRev: string): ApplyOutcome {
  const opened = openDeck(folder);
  if (!opened.ok) {
    return {
      ok: false,
      code: "unreadable-deck",
      diagnostics: opened.diagnostics,
      hint: HINTS["unreadable-deck"],
    };
  }
  const result = applyOps(opened.doc, ops, baseRev);
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      rev: result.rev,
      diagnostics: result.diagnostics,
      hint:
        result.code === "stale-revision"
          ? `The deck is now at revision ${result.rev}, not ${baseRev}. Nothing was applied. Read it with deck_get, then redo the edit with base_rev "${result.rev}".`
          : HINTS[result.code],
    };
  }
  try {
    const written = saveDeckDir(folder, opened.doc, result.doc);
    return {
      ok: true,
      prevRev: result.prevRev,
      rev: result.rev,
      changed: result.changed,
      removed: result.removed,
      written,
      diagnostics: result.diagnostics,
    };
  } catch (error) {
    if (error instanceof ChangedOnDiskError) {
      return {
        ok: false,
        code: "changed-on-disk",
        rev: revisionOf(opened.doc),
        diagnostics: [],
        hint: HINTS["changed-on-disk"],
      };
    }
    throw error;
  }
}
