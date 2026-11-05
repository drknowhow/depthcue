import {
  applyOps,
  type Block,
  brandPartOf,
  type Diagnostic,
  type Doc,
  editDrafts,
  kitOf,
  loadDoc,
  revisionOf,
  type Scene,
  sceneRevision,
  slotMax,
} from "@depthcue/core";
import { appendAudit } from "./audit-file.ts";
import { largeImageDiagnostics } from "./images.ts";
import { loadDeckDir } from "./loader.ts";
import { recordAgentWrite } from "./review-file.ts";
import { ChangedOnDiskError, RefusedSaveError, saveDeckDir } from "./save.ts";

/** How much a read returns. Concise is for deciding what to do next; detailed is for doing it. */
export type Detail = "concise" | "detailed";

export type OpenResult =
  | { ok: true; doc: Doc; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };

/** Reads a deck folder into a Doc. Fails, with every error, when the deck is not valid. */
export function openDeck(folder: string): OpenResult {
  const { doc, diagnostics } = loadDoc(loadDeckDir(folder));
  // A file's size is a fact about the folder, not the JSON, so it is checked here and not in core's validate.
  return doc
    ? { ok: true, doc, diagnostics: [...diagnostics, ...largeImageDiagnostics(folder, doc)] }
    : { ok: false, diagnostics };
}

const blockSummary = (block: Block) => ({
  id: block.id,
  type: block.type,
  ...(block.slot === undefined ? {} : { slot: block.slot }),
  ...(block.style === undefined ? {} : { style: block.style }),
  ...(block.frame === undefined ? {} : { frame: block.frame }),
});

/**
 * The templates and component styles a scene of the deck may name, its brand's and Depthcue's own, as an agent needs
 * them to choose. The concise answer is the templates by id and name and the styles by id, which is what a read to decide
 * what to do next needs: with Depthcue's own, the slots and hints alone are several thousand characters.
 * The detailed answer has each template with its slots, what each is for, what it takes and what goes there, and each
 * style with its name and the kinds of block it is for. A brand's own are marked `brand`. A claim slot takes no blocks,
 * so it lists no `accepts`: the scene's `summary` goes there.
 */
function kitSummary(doc: Doc, detail: Detail) {
  const kit = kitOf(brandPartOf(doc));
  const own = (set: object | undefined, id: string) =>
    set !== undefined && Object.hasOwn(set, id) ? { brand: true } : {};
  if (detail === "concise") {
    return {
      templates: Object.entries(kit.templates).map(([id, template]) => ({
        id,
        name: template.name,
        ...own(doc.templates, id),
      })),
      styles: Object.keys(kit.styles),
    };
  }
  return {
    templates: Object.entries(kit.templates).map(([id, template]) => ({
      id,
      name: template.name,
      description: template.description,
      ...own(doc.templates, id),
      slots: template.slots.map((slot) => ({
        id: slot.id,
        role: slot.role,
        ...(slot.accepts ? { accepts: slot.accepts } : {}),
        hint: slot.hint,
        ...(slotMax(slot) > 1 ? { max: slotMax(slot) } : {}),
        ...(slot.required ? { required: true } : {}),
        ...(slot.style === undefined ? {} : { style: slot.style }),
      })),
    })),
    styles: Object.entries(kit.styles).map(([id, style]) => ({
      id,
      name: style.name,
      for: style.for,
      ...own(doc.brand?.styles, id),
    })),
  };
}

export function getOutline(doc: Doc, detail: Detail = "concise") {
  return {
    rev: revisionOf(doc),
    id: doc.deck.id,
    title: doc.deck.title,
    theme: doc.deck.theme,
    language: doc.deck.language,
    ...(doc.brand === undefined
      ? {}
      : { brand: { id: doc.brand.id, name: doc.brand.name, ...(doc.brand.lock ? { locked: true } : {}) } }),
    ...kitSummary(doc, detail),
    scenes: doc.deck.scenes.map((id) => {
      const scene = doc.scenes[id] as Scene;
      const pinned = scene.blocks.filter((block) => block.frame !== undefined).length;
      const base = {
        id,
        title: scene.title,
        ...(scene.template === undefined ? { layout: scene.layout } : { template: scene.template }),
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
      code:
        | "unreadable-deck"
        | "stale-revision"
        | "bad-op"
        | "invalid-deck"
        | "changed-on-disk"
        | "refused-save";
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
  "refused-save":
    "Nothing was written: something in the deck folder stops the save, as the diagnostics say. It needs a person to change the folder; sending the operations again will not help.",
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
    // This is the agent's way in, so what it changed is recorded for the person to review.
    const recorded = recordAgentWrite(folder, opened.doc, result.doc);
    appendAudit(folder, editDrafts("agent", opened.doc, result.doc));
    return {
      ok: true,
      prevRev: result.prevRev,
      rev: result.rev,
      changed: result.changed,
      removed: result.removed,
      written,
      diagnostics: [...result.diagnostics, ...recorded],
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
    if (error instanceof RefusedSaveError) {
      return {
        ok: false,
        code: "refused-save",
        rev: revisionOf(opened.doc),
        diagnostics: error.diagnostics,
        hint: HINTS["refused-save"],
      };
    }
    throw error;
  }
}
