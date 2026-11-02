/**
 * Review: what the agent changed since a person last looked. `review.json`, beside `deck.json`, holds the deck as
 * it was when it was last reviewed, and the ids of the changes the agent made since. The changes themselves are
 * never stored: they are the difference between that copy and the deck as it is now, worked out each time, one
 * change per property of the deck, a scene or a block. Accepting a change copies it into the reviewed deck.
 * Reverting one runs ordinary operations on the current deck, so the result is a new revision and nothing is
 * rewritten. Like the comments, none of this is part of the deck: it changes no revision, and an export, the
 * player and the presenter never see it.
 */
import {
  type ApplyFailure,
  type ApplySuccess,
  applyOps,
  BRAND_KEYS,
  DECK_KEYS,
  type DeckChanges,
  type Op,
  SCENE_KEYS,
  type SceneChanges,
} from "./apply.ts";
import { assetsOf } from "./assets.ts";
import type { BrandPart } from "./brand.ts";
import { checkBrandFile, checkTemplateFile } from "./brandcheck.ts";
import { closest } from "./diagnostics.ts";
import { type Doc, revisionOf } from "./doc.ts";
import { canonicalJson, sha256Hex } from "./revision.ts";
import type { Block, Brand, Deck, Diagnostic, Scene, Template } from "./types.ts";
import { checkManifest, checkScenePart, scenePath } from "./validate.ts";
import { readsMarkup, upgradeScene } from "./versions.ts";

/** Where the review of a deck is kept: next to `deck.json`, and not under `scenes/` or `assets/`. */
export const REVIEW_FILE = "review.json";
export const REVIEW_FORMAT = "depthcue-review/1";

/** The contents of `review.json`. */
export interface Review {
  format: typeof REVIEW_FORMAT;
  /** The revision of the reviewed deck below, so a file edited by hand is noticed. */
  rev: string;
  /** The deck as it was when it was last reviewed. */
  deck: Deck;
  scenes: Record<string, Scene>;
  /**
   * The brand and its templates as they were, for a branded deck: the scenes of the reviewed deck are checked against
   * them, and a change to either is a change of its own (`deck/brand`, `deck/template:<id>`), accepted or reverted like
   * a scene's. The brand's font, logo and picture files are not in the review: a change to one is not listed, and a
   * revert does not bring one back.
   */
  brand?: Brand;
  templates?: Record<string, Template>;
  /** Ids of the changes the agent made and nobody has accepted or reverted, sorted. */
  agent: string[];
}

export type ChangeScope = "deck" | "scene" | "block";

/**
 * What happened to the thing the change names. For a field, `added` and `removed` mean it was set or cleared. For a
 * scene or a block they mean it came or went. `moved` is a change of order, and names the list as its field.
 */
export type ChangeKind = "added" | "removed" | "changed" | "moved";

/**
 * One difference between two decks, as the drawer and `depthcue diff` show it. The `id` is the path to the thing and
 * is the same whichever deck is compared with which, so it can be named later to accept or revert it:
 * `deck/title`, `deck/scenes`, `scene:<id>`, `scene:<id>/title`, `scene:<id>/blocks`, `scene:<id>/block:<id>` and
 * `scene:<id>/block:<id>/<field>`. A field is a top-level property, and its value is the whole of it. A scene that was
 * added or removed is one change, not one per block, and so is a block whose type changed (field `type`).
 *
 * The brand's files are changes of the deck, not of a scene: `deck/brand` is `brand.json` as a whole (field `brand`,
 * its value the brand without its `$schema` and `schemaVersion`), and `deck/template:<id>` is one template file (field
 * `template:<id>`, its value the template). A deck that changed to a brand with another id is one `deck/brand` change,
 * and writing it writes the new brand's templates too, since the old brand's went with it; they are listed one by one as
 * well, as what changed from the old brand's.
 */
export interface Difference {
  id: string;
  scope: ChangeScope;
  kind: ChangeKind;
  scene?: string;
  block?: string;
  field?: string;
  /** In the reviewed deck. Left out when it was not there. */
  before?: unknown;
  /** In the current deck. Left out when it is not there. */
  after?: unknown;
}

/** `agent` when the change was made through the agent's tools, `outside` when someone edited the files by hand. */
export type Author = "agent" | "outside";

export interface Change extends Difference {
  by: Author;
}

const record = (value: object): Record<string, unknown> => value as Record<string, unknown>;
const present = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key) && value[key] !== undefined;
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

function make(
  id: string,
  scope: ChangeScope,
  kind: ChangeKind,
  where: { scene?: string; block?: string; field?: string },
  values: { before?: unknown; after?: unknown } = {},
): Difference {
  return { id, scope, kind, ...where, ...values };
}

interface Where {
  scope: ChangeScope;
  scene?: string;
  block?: string;
}

function fieldDiffs(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: Iterable<string>,
  where: Where,
  prefix: string,
): Difference[] {
  const out: Difference[] = [];
  for (const field of fields) {
    const was = present(before, field);
    const is = present(after, field);
    if (!was && !is) continue;
    if (was && is && same(before[field], after[field])) continue;
    out.push(
      make(
        `${prefix}/${field}`,
        where.scope,
        !was ? "added" : !is ? "removed" : "changed",
        {
          ...(where.scene === undefined ? {} : { scene: where.scene }),
          ...(where.block === undefined ? {} : { block: where.block }),
          field,
        },
        { ...(was ? { before: before[field] } : {}), ...(is ? { after: after[field] } : {}) },
      ),
    );
  }
  return out;
}

/** The order the ids that are in both lists have in each, when the two differ. Coming and going is not reordering. */
function reordered(
  before: readonly string[],
  after: readonly string[],
): { before: string[]; after: string[] } | undefined {
  const inAfter = new Set(after);
  const inBefore = new Set(before);
  const was = before.filter((id) => inAfter.has(id));
  const is = after.filter((id) => inBefore.has(id));
  return was.some((id, i) => id !== is[i]) ? { before: was, after: is } : undefined;
}

function blockDiffs(sceneId: string, was: Block, now: Block): Difference[] {
  const prefix = `scene:${sceneId}/block:${now.id}`;
  if (was.type !== now.type) {
    return [
      make(
        `${prefix}/type`,
        "block",
        "changed",
        { scene: sceneId, block: now.id, field: "type" },
        { before: was.type, after: now.type },
      ),
    ];
  }
  const before = record(was);
  const after = record(now);
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => field !== "id" && field !== "type")
    .sort();
  return fieldDiffs(before, after, fields, { scope: "block", scene: sceneId, block: now.id }, prefix);
}

function sceneDiffs(was: Scene, now: Scene): Difference[] {
  const prefix = `scene:${now.id}`;
  const out = fieldDiffs(record(was), record(now), SCENE_KEYS, { scope: "scene", scene: now.id }, prefix);
  const order = reordered(
    was.blocks.map((block) => block.id),
    now.blocks.map((block) => block.id),
  );
  if (order) out.push(make(`${prefix}/blocks`, "scene", "moved", { scene: now.id, field: "blocks" }, order));
  const earlier = new Map(was.blocks.map((block) => [block.id, block]));
  for (const block of now.blocks) {
    const old = earlier.get(block.id);
    if (old) out.push(...blockDiffs(now.id, old, block));
    else
      out.push(
        make(
          `${prefix}/block:${block.id}`,
          "block",
          "added",
          { scene: now.id, block: block.id },
          { after: block },
        ),
      );
  }
  const kept = new Set(now.blocks.map((block) => block.id));
  for (const block of was.blocks) {
    if (kept.has(block.id)) continue;
    out.push(
      make(
        `${prefix}/block:${block.id}`,
        "block",
        "removed",
        { scene: now.id, block: block.id },
        { before: block },
      ),
    );
  }
  return out;
}

/**
 * `scene` in the form `other` reads text in. Text below 0.3 is literal and from 0.3 is markup, so when only one side
 * of a comparison was upgraded, the older one is compared, and its values copied, upgraded too: an upgrade alone is
 * no change, and a value copied from the older side keeps its meaning on the newer one.
 */
const inStep = (scene: Scene, other: Scene | undefined): Scene =>
  other !== undefined && readsMarkup(other) && !readsMarkup(scene) ? upgradeScene(scene) : scene;

/** `doc` with each scene put in the form the same scene of `like` reads text in. */
const alignedTo = (doc: Doc, like: Doc): Doc => ({
  ...doc,
  scenes: Object.fromEntries(
    Object.entries(doc.scenes).map(([id, scene]) => [id, inStep(scene, like.scenes[id])]),
  ),
});

/** The field a deck-level change of the brand's files names: `brand` for brand.json, `template:<id>` for a template. */
const BRAND_FIELD = "brand";
const TEMPLATE_FIELD = "template:";
const isBrandField = (field: string | undefined): boolean =>
  field === BRAND_FIELD || field?.startsWith(TEMPLATE_FIELD) === true;

/** A brand or a template as it is reviewed: without what an operation cannot write, which is no one's change. */
function reviewed(value: Brand | Template): Record<string, unknown> {
  const { $schema: _schema, schemaVersion: _version, ...rest } = record(value);
  return rest;
}

/** One of the brand's files as one change: what it was and what it is, or nothing when it is the same. */
function fileDiff(
  field: string,
  was: Brand | Template | undefined,
  is: Brand | Template | undefined,
): Difference[] {
  if (was === undefined ? is === undefined : is !== undefined && same(reviewed(was), reviewed(is))) return [];
  return [
    make(
      `deck/${field}`,
      "deck",
      was === undefined ? "added" : is === undefined ? "removed" : "changed",
      { field },
      {
        ...(was === undefined ? {} : { before: reviewed(was) }),
        ...(is === undefined ? {} : { after: reviewed(is) }),
      },
    ),
  ];
}

/**
 * The changes to the deck's brand: `brand.json` as one, and each template as one. With no brand now, each template it
 * had is removed with it, and writing the brand's removal writes theirs.
 */
function brandDiffs(base: Doc, current: Doc): Difference[] {
  const out = fileDiff(BRAND_FIELD, base.brand, current.brand);
  const before: Readonly<Record<string, Template>> = base.brand === undefined ? {} : (base.templates ?? {});
  const after: Readonly<Record<string, Template>> =
    current.brand === undefined ? {} : (current.templates ?? {});
  const gone = Object.keys(before).filter((id) => !Object.hasOwn(after, id));
  for (const id of [...Object.keys(after).sort(), ...gone.sort()])
    out.push(...fileDiff(`${TEMPLATE_FIELD}${id}`, ownEntry(before, id), ownEntry(after, id)));
  return out;
}
/**
 * What differs between two decks, in a fixed order: the deck's own properties, the scene order, the brand and its
 * templates, then each scene of `current` in its order, with its properties, its block order and its blocks, and last
 * the scenes that are gone. A scene that one side upgraded to 0.3 is compared by meaning, so the escaping an upgrade does
 * is no change.
 */
export function diffDocs(base: Doc, current: Doc): Difference[] {
  const out = fieldDiffs(record(base.deck), record(current.deck), DECK_KEYS, { scope: "deck" }, "deck");
  const order = reordered(base.deck.scenes, current.deck.scenes);
  if (order) out.push(make("deck/scenes", "deck", "moved", { field: "scenes" }, order));
  out.push(...brandDiffs(base, current));
  for (const id of current.deck.scenes) {
    const now = current.scenes[id] as Scene;
    const was = base.scenes[id];
    if (was) out.push(...sceneDiffs(inStep(was, now), inStep(now, was)));
    else out.push(make(`scene:${id}`, "scene", "added", { scene: id }, { after: now }));
  }
  for (const id of base.deck.scenes) {
    if (current.scenes[id] === undefined) {
      out.push(make(`scene:${id}`, "scene", "removed", { scene: id }, { before: base.scenes[id] }));
    }
  }
  return out;
}

/** A sentence for a change, the same wherever it is shown: `Title of scene "method" changed`. */
export function describeChange(change: Difference): string {
  const scene = `scene "${change.scene}"`;
  const block = `block "${change.block}"`;
  let what: string;
  if (change.scope === "deck") {
    if (change.field === "scenes") what = "scene order";
    else if (change.field === BRAND_FIELD) what = "brand";
    else if (change.field?.startsWith(TEMPLATE_FIELD))
      what = `template "${change.field.slice(TEMPLATE_FIELD.length)}"`;
    else what = `deck ${change.field}`;
  } else if (change.scope === "scene") {
    if (change.field === undefined) what = scene;
    else what = change.field === "blocks" ? `block order in ${scene}` : `${change.field} of ${scene}`;
  } else if (change.field === undefined) what = `${block} in ${scene}`;
  else what = `${change.field} of ${block} in ${scene}`;
  const verb = change.kind === "moved" ? "changed" : change.kind;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} ${verb}`;
}

function precedingIn(list: readonly string[], index: number, kept: readonly string[]): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const id = list[i] as string;
    if (kept.includes(id)) return id;
  }
  return null;
}

/** The values of the longest increasing run in `sequence`: the part that can stay where it is. */
function longestRun(sequence: readonly number[]): Set<number> {
  const length = sequence.map(() => 1);
  const previous = sequence.map(() => -1);
  let best = -1;
  for (let i = 0; i < sequence.length; i++) {
    for (let j = 0; j < i; j++) {
      if (
        (sequence[j] as number) < (sequence[i] as number) &&
        (length[j] as number) + 1 > (length[i] as number)
      ) {
        length[i] = (length[j] as number) + 1;
        previous[i] = j;
      }
    }
    if (best < 0 || (length[i] as number) > (length[best] as number)) best = i;
  }
  const run = new Set<number>();
  for (let at = best; at >= 0; at = previous[at] as number) run.add(sequence[at] as number);
  return run;
}

/**
 * The fewest moves that put the ids `current` and `target` share in the order `target` has: whatever is outside the
 * longest run already in order is placed after its predecessor, going through `target` from the start.
 */
export function moves(
  current: readonly string[],
  target: readonly string[],
): Array<{ id: string; after: string | null }> {
  const inTarget = new Set(target);
  const inCurrent = new Set(current);
  const have = current.filter((id) => inTarget.has(id));
  const want = target.filter((id) => inCurrent.has(id));
  const rank = new Map(want.map((id, i) => [id, i]));
  const stay = longestRun(have.map((id) => rank.get(id) as number));
  const out: Array<{ id: string; after: string | null }> = [];
  for (const [i, id] of want.entries()) {
    if (!stay.has(i)) out.push({ id, after: i === 0 ? null : (want[i - 1] as string) });
  }
  return out;
}

const into = <T>(map: Map<string, T>, key: string, start: () => T): T => {
  let value = map.get(key);
  if (value === undefined) {
    value = start();
    map.set(key, value);
  }
  return value;
};

/** `record[id]` when the record has it of its own, so an id like "constructor" is not read off the prototype. */
const ownEntry = <T>(record: Readonly<Record<string, T>> | undefined, id: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, id) ? record[id] : undefined;

/** The `brand.set` that writes the properties of `next` that `prev` does not have as they are, all of them for a new brand. */
function brandSet(prev: Brand | undefined, next: Brand): Record<string, unknown> {
  // An id is written once, when the brand is made, and never changes.
  const set: Record<string, unknown> = prev === undefined ? { id: next.id } : {};
  const before = record(prev ?? {});
  const after = record(next);
  for (const key of BRAND_KEYS) {
    if (key !== "id" && !same(before[key], after[key])) set[key] = after[key] ?? null;
  }
  return set;
}

/** The `style.set` operations that turn the styles of `prev` into those of `next`. */
function styleOps(prev: Brand | undefined, next: Brand): Op[] {
  const was = prev?.styles;
  const is = next.styles;
  return [...new Set([...Object.keys(was ?? {}), ...Object.keys(is ?? {})])].sort().flatMap((id): Op[] => {
    const style = ownEntry(is, id);
    if (style === undefined) return [{ op: "style.set", id, style: null }];
    return same(ownEntry(was, id), style) ? [] : [{ op: "style.set", id, style }];
  });
}

/**
 * The operations that put the brand's files as `to` has them, for the chosen changes of `deck/brand` and
 * `deck/template:<id>`: the brand first, with its styles, then each template. A brand made new, or taken over by one with
 * another id, brings all of its templates, since the folder a brand is made in is empty: the changes of templates that
 * come with it are writes of what is there already, and the old brand's are gone.
 */
function brandOps(from: Doc, to: Doc, brand: Difference | undefined, templates: readonly Difference[]): Op[] {
  const next = to.brand;
  const prev = from.brand;
  // The templates go with the brand, so there is nothing more to write.
  if (brand && next === undefined) return [{ op: "brand.set", set: null }];
  const brought = brand !== undefined && next !== undefined && (prev === undefined || prev.id !== next.id);
  const ops: Op[] = prev !== undefined && brought ? [{ op: "brand.set", set: null }] : [];
  if (brand && next !== undefined) {
    const kept = brought ? undefined : prev;
    const set = brandSet(kept, next);
    if (Object.keys(set).length > 0) ops.push({ op: "brand.set", set } as Op);
    ops.push(...styleOps(kept, next));
  }
  const ids = brought
    ? Object.keys(to.templates ?? {})
    : templates.map((change) => (change.field as string).slice(TEMPLATE_FIELD.length));
  for (const id of ids) ops.push({ op: "template.set", id, template: ownEntry(to.templates, id) ?? null });
  return ops;
}
/**
 * Operations that turn `from` into `to` for the chosen differences, which were found by comparing the two. The brand's
 * files come first, so the scenes that follow find the templates and styles they name. A scene that `to` has at 0.3 and
 * `from` below is upgraded next, so the markup copied into it reads as markup. Properties are set next, then things
 * removed, things added where they stand in `to` and the order last. They are meant to run as one transaction, which is
 * checked as a whole, so a step in between may be one that would not be valid alone.
 */
function buildOps(from: Doc, to: Doc, picked: readonly Difference[]): Op[] {
  // Blocks copied from `to` come in the form `from` reads text in, as the picked values do.
  const target = alignedTo(to, from);
  const upgrade = new Set<string>();
  const deckSet: Record<string, unknown> = {};
  const sceneSet = new Map<string, Record<string, unknown>>();
  const blockSet = new Map<string, Map<string, Record<string, unknown>>>();
  const sceneAdd = new Set<string>();
  const sceneRemove = new Set<string>();
  const blockAdd = new Map<string, Set<string>>();
  const blockRemove = new Map<string, Set<string>>();
  const blockOrder = new Set<string>();
  let sceneOrder = false;
  let brandChange: Difference | undefined;
  const templateChanges: Difference[] = [];

  for (const change of picked) {
    if (change.scope === "deck" && isBrandField(change.field)) {
      if (change.field === BRAND_FIELD) brandChange = change;
      else templateChanges.push(change);
      continue;
    }
    const value = change.kind === "removed" ? null : change.after;
    const field = change.field as string;
    const scene = change.scene as string;
    const block = change.block as string;
    const [was, will] = [from.scenes[scene], to.scenes[scene]];
    if (was && will && readsMarkup(will) && !readsMarkup(was)) upgrade.add(scene);
    if (change.scope === "deck") {
      if (field === "scenes") sceneOrder = true;
      else deckSet[field] = value;
    } else if (change.scope === "scene") {
      if (change.field === undefined) (change.kind === "added" ? sceneAdd : sceneRemove).add(scene);
      else if (field === "blocks") blockOrder.add(scene);
      else into<Record<string, unknown>>(sceneSet, scene, () => ({}))[field] = value;
    } else if (change.field === undefined) {
      into(change.kind === "added" ? blockAdd : blockRemove, scene, () => new Set()).add(block);
    } else if (field === "type") {
      // A block cannot change its type, so the block goes and comes back as it is in `to`.
      into(blockAdd, scene, () => new Set()).add(block);
      into(blockRemove, scene, () => new Set()).add(block);
    } else {
      into<Record<string, unknown>>(
        into(blockSet, scene, () => new Map<string, Record<string, unknown>>()),
        block,
        () => ({}),
      )[field] = value;
    }
  }

  const ops: Op[] = [
    ...brandOps(from, to, brandChange, templateChanges),
    ...[...upgrade].map((id): Op => ({ op: "scene.upgrade", id })),
  ];
  if (Object.keys(deckSet).length > 0) ops.push({ op: "deck.set", set: deckSet as DeckChanges });
  for (const [id, set] of sceneSet) ops.push({ op: "scene.set", id, set: set as SceneChanges });
  for (const [scene, blocks] of blockSet) {
    for (const [id, set] of blocks) ops.push({ op: "block.set", scene, id, set });
  }
  for (const [scene, ids] of blockRemove) {
    for (const id of ids) ops.push({ op: "block.remove", scene, id });
  }
  for (const id of sceneRemove) ops.push({ op: "scene.remove", id });

  const scenes = from.deck.scenes.filter((id) => !sceneRemove.has(id));
  for (const [index, id] of to.deck.scenes.entries()) {
    if (!sceneAdd.has(id)) continue;
    const after = precedingIn(to.deck.scenes, index, scenes);
    scenes.splice(after === null ? 0 : scenes.indexOf(after) + 1, 0, id);
    ops.push({ op: "scene.add", scene: to.scenes[id] as Scene, after });
  }

  for (const scene of new Set([...blockAdd.keys(), ...blockRemove.keys(), ...blockOrder])) {
    const gone = blockRemove.get(scene);
    const blocks = (from.scenes[scene] as Scene).blocks
      .map((block) => block.id)
      .filter((id) => !gone?.has(id));
    const wanted = (target.scenes[scene] as Scene).blocks;
    const ids = wanted.map((block) => block.id);
    for (const [index, block] of wanted.entries()) {
      if (!blockAdd.get(scene)?.has(block.id)) continue;
      const after = precedingIn(ids, index, blocks);
      blocks.splice(after === null ? 0 : blocks.indexOf(after) + 1, 0, block.id);
      ops.push({ op: "block.add", scene, block, after });
    }
    if (blockOrder.has(scene)) {
      for (const move of moves(blocks, ids)) ops.push({ op: "block.move", scene, ...move });
    }
  }
  if (sceneOrder) {
    for (const move of moves(scenes, to.deck.scenes)) ops.push({ op: "scene.move", ...move });
  }
  return ops;
}

/**
 * The reviewed deck as a `Doc`. Its assets are the deck folder's, and the ones it names that were since deleted. Given
 * the brand folder's files, it has those too, for a reviewed deck with a brand.
 */
export function baselineOf(
  review: Review,
  assets: ReadonlySet<string>,
  brandFiles?: ReadonlySet<string>,
): Doc {
  const named = Object.values(review.scenes).flatMap(assetsOf);
  return {
    deck: review.deck,
    scenes: review.scenes,
    assets: new Set([...assets, ...named]),
    ...(review.brand === undefined ? {} : { brand: review.brand, templates: review.templates ?? {} }),
    ...(brandFiles === undefined ? {} : { brandFiles }),
  };
}

/** A review whose reviewed deck is `doc`, with nothing for the agent to answer for yet. */
export function startReview(doc: Doc, agent: readonly string[] = []): Review {
  return {
    format: REVIEW_FORMAT,
    rev: revisionOf(doc),
    deck: doc.deck,
    scenes: Object.fromEntries(doc.deck.scenes.map((id) => [id, doc.scenes[id] as Scene])),
    ...(doc.brand === undefined ? {} : { brand: doc.brand, templates: { ...doc.templates } }),
    agent: [...agent],
  };
}

/** The changes since the review, each marked with who made it. */
export function reviewChanges(review: Review, current: Doc): Change[] {
  const agent = new Set(review.agent);
  return diffDocs(baselineOf(review, current.assets), current).map(
    (change): Change => ({ ...change, by: agent.has(change.id) ? "agent" : "outside" }),
  );
}

/** Only the ids that are still changes: a change that was accepted, reverted or undone by hand is forgotten. */
function prune(review: Review, current: Doc): Review {
  const live = new Set(diffDocs(baselineOf(review, current.assets), current).map((change) => change.id));
  return { ...review, agent: [...new Set(review.agent.filter((id) => live.has(id)))].sort() };
}

export interface ReviewFailure {
  ok: false;
  /** `unknown-change`: an id is not a change now. `bad-op` and `invalid-deck` are the codes of `applyOps`. */
  code: "unknown-change" | "bad-op" | "invalid-deck";
  diagnostics: Diagnostic[];
  /** The ids named that are not changes, for `unknown-change`. */
  unknown: string[];
}

const failed = (result: ApplyFailure): ReviewFailure => ({
  ok: false,
  code: result.code === "invalid-deck" ? "invalid-deck" : "bad-op",
  diagnostics: result.diagnostics,
  unknown: [],
});
function choose(have: readonly Difference[], ids: readonly string[]): string[] | ReviewFailure {
  const known = have.map((change) => change.id);
  const unknown = [...new Set(ids)].filter((id) => !known.includes(id));
  if (unknown.length === 0) return known.filter((id) => ids.includes(id));
  return {
    ok: false,
    code: "unknown-change",
    unknown,
    diagnostics: unknown.map((id) => {
      const guess = closest(id, known);
      return {
        severity: "error",
        code: "unknown-change",
        file: "changes",
        path: `/${id}`,
        message: `There is no change "${id}".`,
        fix: `${guess ? `Did you mean "${guess}"? ` : ""}Read the changes again: one that was accepted, reverted or edited back is no longer listed.`,
      };
    }),
  };
}

export interface Accepted {
  ok: true;
  review: Review;
  accepted: string[];
}

/**
 * Marks changes as reviewed: copies them from the current deck into the reviewed one, and nothing else. `"all"`
 * makes the reviewed deck the current one. The reviewed deck stays a valid deck, so a change that cannot be copied
 * on its own, such as a block that points at one that is new, is refused with the reason, and nothing is accepted.
 */
export function acceptChanges(
  review: Review,
  current: Doc,
  ids: readonly string[] | "all",
): Accepted | ReviewFailure {
  const base = baselineOf(review, current.assets, current.brandFiles);
  const have = diffDocs(base, current);
  if (ids === "all") return { ok: true, review: startReview(current), accepted: have.map((c) => c.id) };
  const chosen = choose(have, ids);
  if (!Array.isArray(chosen)) return chosen;
  if (chosen.length === 0) return { ok: true, review, accepted: [] };
  const wanted = new Set(chosen);
  const result = applyOps(
    base,
    buildOps(
      base,
      current,
      have.filter((change) => wanted.has(change.id)),
    ),
    revisionOf(base),
  );
  if (!result.ok) return failed(result);
  return {
    ok: true,
    review: prune({ ...startReview(result.doc), agent: review.agent }, current),
    accepted: chosen,
  };
}

export interface Reverted extends ApplySuccess {
  reverted: string[];
  /** The review, without the changes that are gone. The reviewed deck is the same. */
  review: Review;
}

const unchanged = (doc: Doc): ApplySuccess => ({
  ok: true,
  doc,
  rev: revisionOf(doc),
  prevRev: revisionOf(doc),
  changed: [],
  removed: [],
  deckChanged: false,
  brandChanged: false,
  diagnostics: [],
});

/**
 * Puts changes back as they were when the deck was reviewed, by running operations on the current deck. The result
 * is a new revision on top of the current one; no revision is rewritten. All of it or none: a change that would
 * leave an invalid deck, such as one that brings back a block whose image file is gone, is refused with the reason.
 */
export function revertChanges(
  review: Review,
  current: Doc,
  ids: readonly string[] | "all",
): Reverted | ReviewFailure {
  const plan = revertOps(review, current, ids);
  if (!plan.ok) return plan;
  if (plan.ops.length === 0) return { ...unchanged(current), reverted: [], review: prune(review, current) };
  const result = applyOps(current, plan.ops, revisionOf(current));
  if (!result.ok) return failed(result);
  return { ...result, reverted: plan.reverted, review: prune(review, result.doc) };
}

export interface RevertPlan {
  ok: true;
  /** One transaction: valid as a whole, though a step in between may not be valid alone. */
  ops: Op[];
  reverted: string[];
}

/**
 * The operations `revertChanges` would run, for a caller that has a document of its own to run them on, such as the
 * editor's session, where they become one undo step. They are not checked against the deck: the caller's `apply` does
 * that, and refuses with the reason when the result would not be a valid deck.
 */
export function revertOps(
  review: Review,
  current: Doc,
  ids: readonly string[] | "all",
): RevertPlan | ReviewFailure {
  const base = baselineOf(review, current.assets, current.brandFiles);
  const have = diffDocs(base, current);
  const chosen = ids === "all" ? have.map((change) => change.id) : choose(have, ids);
  if (!Array.isArray(chosen)) return chosen;
  const wanted = new Set(chosen);
  const ops = buildOps(
    current,
    base,
    diffDocs(current, base).filter((change) => wanted.has(change.id)),
  );
  return { ok: true, ops, reverted: chosen };
}

/**
 * A person's edit, which is theirs to have made and not the agent's to answer for: whatever they changed is copied
 * into the reviewed deck too. A change inside something the agent added has no place there to go, and stays with the
 * thing it is in. `keep` names changes that are not folded and are marked as the agent's again: the editor sends the
 * ones a person reverted and then undid, which come back as the agent's and not as the person's own.
 */
export function foldEdit(review: Review, before: Doc, after: Doc, keep: readonly string[] = []): Review {
  let base = baselineOf(review, after.assets, after.brandFiles);
  const kept = new Set(keep);
  for (const { id } of diffDocs(before, after)) {
    if (kept.has(id)) continue;
    const have = diffDocs(base, after);
    const picked = have.filter((change) => change.id === id);
    if (picked.length === 0) continue;
    const result = applyOps(base, buildOps(base, after, picked), revisionOf(base));
    if (result.ok) base = result.doc;
  }
  return prune({ ...startReview(base), agent: [...review.agent, ...kept] }, after);
}

/**
 * The agent's edit, `before` to `after`: every change it made or touched is marked as the agent's, and the changes
 * it did not touch keep whoever's they were.
 */
export function recordAgentEdit(review: Review, before: Doc, after: Doc): Review {
  const base = baselineOf(review, after.assets);
  // A scene the agent only upgraded holds the same changes as before, in the newer form: they stay whose they were.
  const earlier = new Map(
    diffDocs(base, alignedTo(before, after)).map((change) => [change.id, canonicalJson(change)]),
  );
  const agent = new Set(review.agent);
  for (const change of diffDocs(base, after)) {
    if (earlier.get(change.id) !== canonicalJson(change)) agent.add(change.id);
  }
  return prune({ ...review, agent: [...agent] }, after);
}

/** 16 hex characters of the file's content, to tell whether it changed between a read and a write. */
export const reviewRevision = (review: Review): string => sha256Hex(canonicalJson(review)).slice(0, 16);

/** The file as written to disk: two-space indent and a trailing newline. */
export const reviewToText = (review: Review): string => `${JSON.stringify(review, null, 2)}\n`;

export type ReadReview = { ok: true; review: Review | undefined } | { ok: false; diagnostics: Diagnostic[] };

const error = (path: string, code: string, message: string, fix: string): Diagnostic => ({
  severity: "error",
  code,
  file: REVIEW_FILE,
  path,
  message,
  fix,
});

const refuse = (path: string, code: string, message: string, fix: string): ReadReview => ({
  ok: false,
  diagnostics: [error(path, code, message, fix)],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const START_OVER = "Delete review.json to start a new review from the deck as it is.";

/**
 * Reads `review.json` as text. A missing file is a deck nobody has started to review. A file that is not valid, that
 * holds a deck that is not valid, or whose revision is not the one of the deck it holds, is refused whole: it would
 * be the baseline of every change, and nothing is guessed from a baseline that cannot be trusted.
 */
export function readReview(text: string | undefined): ReadReview {
  if (text === undefined) return { ok: true, review: undefined };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return refuse("", "json-parse", `Not valid JSON: ${(error as Error).message}`, START_OVER);
  }
  if (!isRecord(data) || data.format !== REVIEW_FORMAT) {
    return refuse("/format", "bad-format", `This is not a "${REVIEW_FORMAT}" file.`, START_OVER);
  }
  if (typeof data.rev !== "string" || !isRecord(data.deck) || !isRecord(data.scenes)) {
    return refuse("", "bad-shape", 'It needs a "rev", a "deck" and "scenes".', START_OVER);
  }
  if (!Array.isArray(data.agent) || data.agent.some((id) => typeof id !== "string")) {
    return refuse("/agent", "bad-shape", '"agent" must be a list of change ids.', START_OVER);
  }
  const at = (prefix: string, found: Diagnostic[]): Diagnostic[] =>
    found.map((d) => ({ ...d, file: REVIEW_FILE, path: `${prefix}${d.path}` }));
  if (data.brand !== undefined && !isRecord(data.templates)) {
    return refuse("/templates", "bad-shape", 'A review with a "brand" needs its "templates".', START_OVER);
  }
  const templates = (data.templates ?? {}) as Record<string, unknown>;
  const problems =
    data.brand === undefined
      ? []
      : [
          ...at("/brand", checkBrandFile(data.brand)),
          ...Object.entries(templates).flatMap(([id, template]) =>
            at(`/templates/${id}`, checkTemplateFile(template, id)),
          ),
        ];
  if (problems.length > 0) return { ok: false, diagnostics: problems };
  const part: BrandPart =
    data.brand === undefined
      ? {}
      : { brand: data.brand as unknown as Brand, templates: templates as Record<string, Template> };
  problems.push(...at("/deck", checkManifest(data.deck, "deck.json", part.brand)));
  if (problems.length > 0) return { ok: false, diagnostics: problems };

  const deck = data.deck as unknown as Deck;
  const scenes = data.scenes as Record<string, Scene>;
  const assets = new Set(Object.values(scenes).flatMap((scene) => (isRecord(scene) ? assetsOf(scene) : [])));
  for (const id of Object.keys(scenes)) {
    if (!deck.scenes.includes(id)) {
      problems.push(
        error(
          `/scenes/${id}`,
          "unlisted-scene",
          `Scene "${id}" is in the review but not in the deck's scene list.`,
          START_OVER,
        ),
      );
    }
  }
  for (const id of deck.scenes) {
    const scene = scenes[id];
    if (scene === undefined) {
      problems.push(
        error(`/scenes/${id}`, "missing-scene", `Scene "${id}" is listed but has no content.`, START_OVER),
      );
    } else
      problems.push(...at(`/scenes/${id}`, checkScenePart(scene, scenePath(id), id, assets, deck, part)));
  }
  if (problems.some((d) => d.severity === "error")) return { ok: false, diagnostics: problems };

  const review = data as unknown as Review;
  if (revisionOf({ deck, scenes, assets, ...part }) !== review.rev) {
    return refuse(
      "/rev",
      "rev-mismatch",
      "The deck in the review does not have the revision the file says, so it was changed by hand.",
      START_OVER,
    );
  }
  return { ok: true, review };
}
