import { closest, explain } from "./diagnostics.ts";
import { checkChanges, type Doc, revisionOf, sceneRevision } from "./doc.ts";
import type { Frame } from "./frames.ts";
import { validateOps } from "./generated/validators.js";
import { escapeText } from "./inline.ts";
import { canonicalJson } from "./revision.ts";
import { ID_PATTERN, opsSchema, SCHEMA_VERSION } from "./schema.ts";
import type { Block, Deck, Diagnostic, Scene } from "./types.ts";
import { scenePath } from "./validate.ts";
import { blockNeeds, raiseDeck, raiseScene, readsMarkup, upgradeScene } from "./versions.ts";

/** Properties to write; a null value deletes an optional property. */
type Nullable<T> = { [K in keyof T]?: T[K] | null };

export type DeckChanges = Nullable<
  Pick<Deck, "title" | "language" | "theme" | "palette" | "fonts" | "modules">
>;
export type SceneChanges = Nullable<
  Pick<Scene, "title" | "layout" | "lead" | "summary" | "sources" | "reading" | "steps" | "notes">
>;
/** Any block property except `id` and `type`; the result is checked against the block's own shape. */
export type BlockChanges = Record<string, unknown>;
/** A scene to add. `schemaVersion` may be left out. */
export type NewScene = Omit<Scene, "schemaVersion"> & { schemaVersion?: Scene["schemaVersion"] };

/** `after` is a sibling id, or null for the start. Left out on an add, it means the end. */
export type Op =
  | { op: "deck.set"; set: DeckChanges }
  | { op: "scene.add"; scene: NewScene; after?: string | null }
  | { op: "scene.remove"; id: string }
  | { op: "scene.move"; id: string; after: string | null }
  | { op: "scene.set"; id: string; set: SceneChanges }
  /** Rewrites a scene below 0.3 as 0.3, escaping its text so that it keeps its meaning. A 0.3 scene stays as it is. */
  | { op: "scene.upgrade"; id: string }
  | { op: "block.add"; scene: string; block: Block; after?: string | null }
  | { op: "block.remove"; scene: string; id: string }
  | { op: "block.move"; scene: string; id: string; after: string | null }
  | { op: "block.set"; scene: string; id: string; set: BlockChanges }
  | { op: "block.frame"; scene: string; id: string; frame: Frame }
  | { op: "block.unframe"; scene: string; id: string };

export type ApplyFailureCode =
  /** `baseRev` is not the document's current revision. Read it again and redo the edit. */
  | "stale-revision"
  /** An operation is malformed or names something that does not exist. Nothing was applied. */
  | "bad-op"
  /** Every operation applied, but the result is not a valid deck. Nothing was kept. */
  | "invalid-deck";

export interface ApplyFailure {
  ok: false;
  code: ApplyFailureCode;
  /** The document's current revision. */
  rev: string;
  diagnostics: Diagnostic[];
}

export interface ApplySuccess {
  ok: true;
  doc: Doc;
  rev: string;
  prevRev: string;
  /** Scenes whose content differs from before, added ones included, in deck order. */
  changed: string[];
  removed: string[];
  /** True when deck.json content changed: title, language, theme, palette, fonts, modules or scene order. */
  deckChanged: boolean;
  diagnostics: Diagnostic[];
}

export type ApplyResult = ApplySuccess | ApplyFailure;

interface Work {
  deck: Deck;
  scenes: Record<string, Scene>;
}

const ID_RE = new RegExp(ID_PATTERN);
/** The properties `deck.set` and `scene.set` may write. Review compares exactly these, so the two cannot drift. */
export const DECK_KEYS = ["title", "language", "theme", "palette", "fonts", "modules"] as const;
export const SCENE_KEYS = [
  "title",
  "layout",
  "lead",
  "summary",
  "sources",
  "reading",
  "steps",
  "notes",
] as const;

const REDIRECTS: Record<string, string> = {
  id: "Ids never change. Add a new item and remove the old one in the same operations.",
  schemaVersion: "The schema version is set by the tool.",
  scenes: "Use scene.add, scene.remove and scene.move.",
  blocks: "Use block.add, block.remove, block.move and block.set.",
  type: "A block's type never changes. Add a new block and remove the old one.",
};

function problem(index: number, path: string, code: string, message: string, fix?: string): Diagnostic {
  return {
    severity: "error",
    code,
    file: "ops",
    path: `/${index}${path}`,
    message,
    ...(fix === undefined ? {} : { fix }),
  };
}

const has = (record: object, key: string): boolean => Object.hasOwn(record, key);

function unknownId(
  index: number,
  path: string,
  id: string,
  what: string,
  ids: readonly string[],
): Diagnostic {
  const guess = closest(id, ids);
  const list = ids.length ? `Existing ${what}s: ${ids.join(", ")}.` : `There are no ${what}s.`;
  return problem(
    index,
    path,
    `unknown-${what}`,
    `There is no ${what} "${id}".`,
    guess ? `Did you mean "${guess}"? ${list}` : list,
  );
}

/** A copy of `target` with `set` applied; a null value deletes the property. */
function patch<T extends object>(target: T, set: Record<string, unknown>): T {
  const next = { ...target } as Record<string, unknown>;
  for (const [key, value] of Object.entries(set)) {
    if (value === null) delete next[key];
    else Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return next as T;
}

function checkKeys(
  index: number,
  set: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): Diagnostic | undefined {
  for (const key of Object.keys(set)) {
    if (allowed.includes(key)) continue;
    const guess = closest(key, allowed);
    return problem(
      index,
      `/set/${key}`,
      "forbidden-property",
      `"${key}" cannot be changed with ${where}.`,
      REDIRECTS[key] ?? (guess ? `Did you mean "${guess}"?` : `Allowed here: ${allowed.join(", ")}.`),
    );
  }
  return undefined;
}

type Items<T extends { id: string }> = readonly T[];

/** `items` with `item` placed after the sibling `after`, at the start for null, or at the end for undefined. */
function place<T extends { id: string }>(
  index: number,
  what: string,
  items: Items<T>,
  item: T,
  after: string | null | undefined,
): T[] | Diagnostic {
  if (after === undefined) return [...items, item];
  if (after === null) return [item, ...items];
  const at = items.findIndex((entry) => entry.id === after);
  if (at < 0)
    return unknownId(
      index,
      "/after",
      after,
      what,
      items.map((entry) => entry.id),
    );
  return [...items.slice(0, at + 1), item, ...items.slice(at + 1)];
}

function relocate<T extends { id: string }>(
  index: number,
  what: string,
  items: Items<T>,
  id: string,
  after: string | null,
): T[] | Diagnostic {
  const item = items.find((entry) => entry.id === id);
  if (!item)
    return unknownId(
      index,
      "/id",
      id,
      what,
      items.map((entry) => entry.id),
    );
  if (after === id) {
    return problem(
      index,
      "/after",
      "bad-position",
      `Cannot place "${id}" after itself.`,
      "Name a different sibling.",
    );
  }
  return place(
    index,
    what,
    items.filter((entry) => entry !== item),
    item,
    after,
  );
}

const isProblem = (value: unknown): value is Diagnostic =>
  typeof value === "object" && value !== null && "severity" in value;

function sceneOf(work: Work, index: number, id: string): Scene | Diagnostic {
  return has(work.scenes, id)
    ? (work.scenes[id] as Scene)
    : unknownId(index, "/scene", id, "scene", work.deck.scenes);
}

/** The scene and block an operation names, or what is wrong with naming them. */
function blockOf(
  work: Work,
  index: number,
  sceneId: string,
  id: string,
): { scene: Scene; block: Block } | Diagnostic {
  const scene = sceneOf(work, index, sceneId);
  if (isProblem(scene)) return scene;
  const block = scene.blocks.find((candidate) => candidate.id === id);
  if (block) return { scene, block };
  return unknownId(
    index,
    "/id",
    id,
    "block",
    scene.blocks.map((candidate) => candidate.id),
  );
}

/** Puts `next` where `block` was in the scene. */
function rewrite(work: Work, scene: Scene, block: Block, next: Block) {
  work.scenes[scene.id] = {
    ...scene,
    blocks: scene.blocks.map((candidate) => (candidate === block ? next : candidate)),
  };
}

function step(work: Work, op: Op, index: number): Diagnostic | undefined {
  switch (op.op) {
    case "deck.set": {
      const bad = checkKeys(index, op.set, DECK_KEYS, "deck.set");
      if (bad) return bad;
      work.deck = patch(work.deck, op.set);
      return undefined;
    }
    case "scene.add": {
      const scene = op.scene as unknown as Record<string, unknown>;
      if (typeof scene.id !== "string" || !ID_RE.test(scene.id)) {
        return problem(
          index,
          "/scene/id",
          typeof scene.id === "string" ? "bad-format" : "missing-property",
          typeof scene.id === "string" ? `"${scene.id}" is not a valid scene id.` : 'The scene has no "id".',
          "Ids use lowercase letters, digits and hyphens, start with a letter, and are 2 to 64 characters long.",
        );
      }
      if (has(work.scenes, scene.id)) {
        return problem(
          index,
          "/scene/id",
          "duplicate-id",
          `Scene "${scene.id}" already exists.`,
          "Pick another id.",
        );
      }
      const ids = place(
        index,
        "scene",
        work.deck.scenes.map((id) => ({ id })),
        { id: scene.id },
        op.after,
      );
      if (isProblem(ids)) return ids;
      // A scene that says an older version and has newer parts is raised now, so later operations see 0.3.
      work.scenes[scene.id] = raiseScene({ schemaVersion: SCHEMA_VERSION, ...op.scene } as Scene);
      work.deck = { ...work.deck, scenes: ids.map((entry) => entry.id) };
      return undefined;
    }
    case "scene.remove": {
      if (!has(work.scenes, op.id)) return unknownId(index, "/id", op.id, "scene", work.deck.scenes);
      delete work.scenes[op.id];
      work.deck = { ...work.deck, scenes: work.deck.scenes.filter((id) => id !== op.id) };
      return undefined;
    }
    case "scene.move": {
      const ids = relocate(
        index,
        "scene",
        work.deck.scenes.map((id) => ({ id })),
        op.id,
        op.after,
      );
      if (isProblem(ids)) return ids;
      work.deck = { ...work.deck, scenes: ids.map((entry) => entry.id) };
      return undefined;
    }
    case "scene.set": {
      if (!has(work.scenes, op.id)) return unknownId(index, "/id", op.id, "scene", work.deck.scenes);
      const bad = checkKeys(index, op.set, SCENE_KEYS, "scene.set");
      if (bad) return bad;
      work.scenes[op.id] = patch(work.scenes[op.id] as Scene, op.set);
      return undefined;
    }
    case "scene.upgrade": {
      if (!has(work.scenes, op.id)) return unknownId(index, "/id", op.id, "scene", work.deck.scenes);
      work.scenes[op.id] = upgradeScene(work.scenes[op.id] as Scene);
      return undefined;
    }
    case "block.add": {
      const found = sceneOf(work, index, op.scene);
      if (isProblem(found)) return found;
      const block = op.block as unknown as Record<string, unknown>;
      if (typeof block.id !== "string") {
        return problem(
          index,
          "/block/id",
          "missing-property",
          'The block has no "id".',
          'Add an "id" to the block.',
        );
      }
      // A block with a 0.3 part upgrades its scene first, so the block's own text is read as markup.
      const scene = needsUpgrade(found, op.block) ? upgradeScene(found) : found;
      const blocks = place(index, "block", scene.blocks, op.block, op.after);
      if (isProblem(blocks)) return blocks;
      work.scenes[op.scene] = { ...scene, blocks };
      return undefined;
    }
    case "block.remove": {
      const scene = sceneOf(work, index, op.scene);
      if (isProblem(scene)) return scene;
      if (!scene.blocks.some((block) => block.id === op.id)) {
        return unknownId(
          index,
          "/id",
          op.id,
          "block",
          scene.blocks.map((block) => block.id),
        );
      }
      work.scenes[op.scene] = { ...scene, blocks: scene.blocks.filter((block) => block.id !== op.id) };
      return undefined;
    }
    case "block.move": {
      const scene = sceneOf(work, index, op.scene);
      if (isProblem(scene)) return scene;
      const blocks = relocate(index, "block", scene.blocks, op.id, op.after);
      if (isProblem(blocks)) return blocks;
      work.scenes[op.scene] = { ...scene, blocks };
      return undefined;
    }
    case "block.set": {
      const named = blockOf(work, index, op.scene, op.id);
      if (isProblem(named)) return named;
      for (const key of ["id", "type"]) {
        if (has(op.set, key)) {
          return problem(
            index,
            `/set/${key}`,
            "forbidden-property",
            `"${key}" cannot be changed with block.set.`,
            REDIRECTS[key],
          );
        }
      }
      const next = patch(named.block, op.set);
      if (needsUpgrade(named.scene, next)) {
        // The scene is upgraded before the change is made, so text the change writes is read as markup.
        const at = named.scene.blocks.indexOf(named.block);
        const upgraded = upgradeScene(named.scene);
        const old = upgraded.blocks[at] as Block;
        rewrite(work, upgraded, old, patch(old, op.set));
      } else rewrite(work, named.scene, named.block, next);
      return undefined;
    }
    case "block.frame":
    case "block.unframe": {
      const named = blockOf(work, index, op.scene, op.id);
      if (isProblem(named)) return named;
      rewrite(
        work,
        named.scene,
        named.block,
        patch(named.block, { frame: op.op === "block.frame" ? op.frame : null }),
      );
      return undefined;
    }
  }
}

/** True when `block` has a 0.3 part and `scene` is older, so the scene must be upgraded to hold it. */
const needsUpgrade = (scene: Scene, block: Block): boolean =>
  !readsMarkup(scene) && blockNeeds(block) === "0.3";

/**
 * Text that an operation wrote into a scene below 0.3 and that would read differently as markup, as a warning: the
 * scene shows it exactly as written, which is seldom what an agent that wrote `**` meant.
 */
function literalWarnings(before: Scene | undefined, after: Scene): Diagnostic[] {
  if (readsMarkup(after)) return [];
  const out: Diagnostic[] = [];
  const old = new Map((before?.blocks ?? []).map((block) => [block.id, block]));
  after.blocks.forEach((block, i) => {
    if (block.type !== "text") return;
    const was = old.get(block.id);
    if (was?.type === "text" && was.text === block.text) return;
    if (escapeText(block.text, { lists: block.role === "body" }) === block.text) return;
    out.push({
      severity: "warning",
      code: "text-is-literal",
      file: scenePath(after.id),
      path: `/blocks/${i}/text`,
      message: `Scene "${after.id}" is at schema ${after.schemaVersion}, so this text shows exactly as written: markup in it is not read.`,
      fix: `To use markup, run scene.upgrade on "${after.id}" first, then write the text again. Leave it if the characters are meant.`,
    });
  });
  return out;
}

function fail(code: ApplyFailureCode, rev: string, diagnostics: Diagnostic[]): ApplyFailure {
  return { ok: false, code, rev, diagnostics };
}

/**
 * Applies operations as one transaction: all of them, or none. `baseRev` must be the document's current
 * revision; a stale one is rejected and never merged, because the caller decided against old content.
 * Checking happens on the final state, so one transaction may pass through a state that would be invalid,
 * such as removing a block and the evidence entry that points at it. `ops` is untyped on purpose: it is the
 * boundary where agent JSON arrives, and it is checked against the operations schema here.
 */
export function applyOps(doc: Doc, ops: unknown, baseRev: string): ApplyResult {
  const prevRev = revisionOf(doc);
  if (baseRev !== prevRev) {
    return fail("stale-revision", prevRev, [
      {
        severity: "error",
        code: "stale-revision",
        file: "ops",
        path: "",
        message: `The deck is at revision ${prevRev}, not ${baseRev}. It changed after you read it.`,
        fix: "Read the deck again, then redo the edit against the new revision.",
      },
    ]);
  }
  if (!validateOps(ops)) {
    return fail("bad-op", prevRev, explain(validateOps.errors, ops, opsSchema, "ops"));
  }

  const work: Work = { deck: doc.deck, scenes: { ...doc.scenes } };
  for (const [index, op] of (ops as Op[]).entries()) {
    const bad = step(work, op, index);
    if (bad) return fail("bad-op", prevRev, [bad]);
  }

  // A file says the version its content needs, as the tool writes the version of a new scene: 0.2 for a frame.
  for (const [id, scene] of Object.entries(work.scenes)) {
    if (scene !== doc.scenes[id]) work.scenes[id] = raiseScene(scene);
  }
  if (work.deck !== doc.deck) work.deck = raiseDeck(work.deck);

  const next: Doc = { deck: work.deck, scenes: work.scenes, assets: doc.assets };
  const diagnostics = checkChanges(doc, next);
  if (diagnostics.some((d) => d.severity === "error")) return fail("invalid-deck", prevRev, diagnostics);
  for (const id of next.deck.scenes) {
    const scene = next.scenes[id] as Scene;
    if (scene !== doc.scenes[id]) diagnostics.push(...literalWarnings(doc.scenes[id], scene));
  }

  const changed = next.deck.scenes.filter((id) => {
    const before = doc.scenes[id];
    return before === undefined || sceneRevision(before) !== sceneRevision(next.scenes[id] as Scene);
  });
  return {
    ok: true,
    doc: next,
    rev: revisionOf(next),
    prevRev,
    changed,
    removed: doc.deck.scenes.filter((id) => !has(next.scenes, id)),
    deckChanged: canonicalJson(doc.deck) !== canonicalJson(next.deck),
    diagnostics,
  };
}
