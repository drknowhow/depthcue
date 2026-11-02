import { BUILT_IN_STYLES, BUILT_IN_TEMPLATES } from "./builtins.ts";
import { closest, explain } from "./diagnostics.ts";
import { checkChanges, type Doc, revisionOf, sceneRevision } from "./doc.ts";
import type { Frame } from "./frames.ts";
import { escapeText } from "./inline.ts";
import { own } from "./own.ts";
import { canonicalJson } from "./revision.ts";
import { ID_PATTERN, opsSchema, SCHEMA_VERSION } from "./schema.ts";
import { schemaValidator } from "./schemacheck.ts";
import type { Block, BlockStyle, Brand, Deck, Diagnostic, Scene, Template, TemplateSlot } from "./types.ts";
import { scenePath } from "./validate.ts";
import { blockNeeds, raiseDeck, raiseScene, readsMarkup, upgradeScene, versionAtLeast } from "./versions.ts";

const validateOps = /* @__PURE__ */ schemaValidator(opsSchema);

/** Properties to write; a null value deletes an optional property. */
type Nullable<T> = { [K in keyof T]?: T[K] | null };

export type DeckChanges = Nullable<
  Pick<Deck, "title" | "language" | "theme" | "palette" | "fonts" | "modules">
>;
export type SceneChanges = Nullable<
  Pick<
    Scene,
    "title" | "layout" | "template" | "lead" | "summary" | "sources" | "reading" | "steps" | "notes"
  >
>;
/** What `brand.set` may write. The id is given once, when the brand is made, and never changes. */
export type BrandChanges = Nullable<Omit<Brand, "schemaVersion" | "styles" | "$schema">>;
/** A template to write. Its `id` and `schemaVersion` may be left out: the operation's id and 0.4. */
export type NewTemplate = Omit<Template, "schemaVersion" | "id"> &
  Partial<Pick<Template, "schemaVersion" | "id">>;
/** Any block property except `id` and `type`; the result is checked against the block's own shape. */
export type BlockChanges = Record<string, unknown>;
/** A scene to add. `schemaVersion` may be left out. */
export type NewScene = Omit<Scene, "schemaVersion"> & { schemaVersion?: Scene["schemaVersion"] };
/** Fields of a style, a template or a slot to change; the result is checked whole, as the whole-object form is. */
export type StyleChanges = Nullable<BlockStyle>;
export type TemplateChanges = Nullable<Omit<Template, "schemaVersion" | "id">>;
export type SlotChanges = Nullable<Omit<TemplateSlot, "id">>;

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
  | { op: "block.unframe"; scene: string; id: string }
  /** Makes the deck's brand, with `id` and `name`, or changes it. Null takes the brand off the deck. */
  | { op: "brand.set"; set: BrandChanges | null }
  /** Writes a component style of the brand's, or removes it with null. Or, with `set`, changes some of its fields. */
  | { op: "style.set"; id: string; style?: BlockStyle | null; set?: StyleChanges }
  /** Writes a template of the brand's, or removes it with null. Or, with `set`, changes some of its fields. */
  | { op: "template.set"; id: string; template?: NewTemplate | null; set?: TemplateChanges }
  /** Adds a slot to a template of the brand's. */
  | { op: "slot.add"; template: string; slot: TemplateSlot; after?: string | null }
  /** Changes some fields of a slot. Its id changes only with slot.rename. */
  | { op: "slot.set"; template: string; id: string; set: SlotChanges }
  /** Renames a slot, and moves the blocks in it, in every scene on the template, to the new name. */
  | { op: "slot.rename"; template: string; id: string; to: string }
  /**
   * Removes a slot. Refused while a block is in it, unless `to` says where the blocks go: another slot, or null for out
   * of the slots, pinned where the slot was (a pinned block keeps its frame).
   */
  | { op: "slot.remove"; template: string; id: string; to?: string | null };

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
  /** True when deck.json content changed: title, language, theme, palette, fonts, brand, modules or scene order. */
  deckChanged: boolean;
  /** True when brand.json or a template changed, was made or was removed. */
  brandChanged: boolean;
  diagnostics: Diagnostic[];
}

export type ApplyResult = ApplySuccess | ApplyFailure;

interface Work {
  deck: Deck;
  scenes: Record<string, Scene>;
  brand: Brand | undefined;
  templates: Record<string, Template> | undefined;
}

const ID_RE = new RegExp(ID_PATTERN);
/** The properties `deck.set` and `scene.set` may write. Review compares exactly these, so the two cannot drift. */
export const DECK_KEYS = ["title", "language", "theme", "palette", "fonts", "modules"] as const;
export const SCENE_KEYS = [
  "title",
  "layout",
  "template",
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
  brand: 'Use brand.set: it writes brand/brand.json and the deck\'s "brand" together.',
  styles: "Use style.set, one style at a time.",
};
/** The properties `brand.set` may write. */
export const BRAND_KEYS = [
  "id",
  "name",
  "colors",
  "fonts",
  "logos",
  "chrome",
  "lock",
  "hideBuiltIn",
] as const;

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

/** The first of `keys` that `set` writes, refused: what an operation's `set` may never change. */
function forbid(
  index: number,
  set: object,
  keys: readonly string[],
  name: string,
  fix?: string,
): Diagnostic | undefined {
  const key = keys.find((candidate) => has(set, candidate));
  return key === undefined
    ? undefined
    : problem(
        index,
        `/set/${key}`,
        "forbidden-property",
        `"${key}" cannot be changed with ${name}.`,
        fix ?? own(REDIRECTS, key),
      );
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
      own(REDIRECTS, key) ?? (guess ? `Did you mean "${guess}"?` : `Allowed here: ${allowed.join(", ")}.`),
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

const noBrand = (index: number, name: string): Diagnostic =>
  problem(
    index,
    "",
    "no-brand",
    `The deck has no brand, and ${name} writes into one.`,
    'Make the brand first, in the same operations: {"op": "brand.set", "set": {"id": "acme", "name": "Acme"}}.',
  );

function setBrand(work: Work, op: Extract<Op, { op: "brand.set" }>, index: number): Diagnostic | undefined {
  if (op.set === null) {
    if (work.brand === undefined) return noBrand(index, "brand.set null");
    work.brand = undefined;
    work.templates = undefined;
    work.deck = patch(work.deck, { brand: null });
    return undefined;
  }
  const bad = checkKeys(index, op.set, BRAND_KEYS, "brand.set");
  if (bad) return bad;
  if (work.brand === undefined) {
    for (const key of ["id", "name"] as const) {
      if (typeof op.set[key] === "string") continue;
      return problem(
        index,
        "/set",
        "missing-property",
        `A new brand needs "${key}".`,
        'Give it an id and a name: {"op": "brand.set", "set": {"id": "acme", "name": "Acme"}}.',
      );
    }
    work.brand = patch({ schemaVersion: "0.4" } as Brand, op.set);
    work.templates = {};
    work.deck = { ...work.deck, brand: work.brand.id };
    return undefined;
  }
  if (has(op.set, "id") && op.set.id !== work.brand.id) {
    return problem(
      index,
      "/set/id",
      "forbidden-property",
      `The brand's id is "${work.brand.id}", and an id never changes.`,
      "Take the brand off with brand.set null, then make a new one with the new id.",
    );
  }
  work.brand = patch(work.brand, op.set);
  return undefined;
}

/**
 * A change to one of Depthcue's own templates or styles, refused with how to make it: copy it into the brand, where a
 * template or style with its id takes its place, and change the copy.
 */
const builtIn = (index: number, path: string, what: string, id: string, value: unknown): Diagnostic =>
  problem(
    index,
    path,
    `built-in-${what}`,
    `"${id}" is Depthcue's own ${what}, which cannot be changed.`,
    `Copy it into the brand first, then change the copy: {"op": "${what}.set", "id": "${id}", "${what}": ${JSON.stringify(value)}}.`,
  );

/** The brand's own entry `id` that a `set` changes, or why there is none: no brand, a built-in, or no such id. */
function ownEntry<T>(
  work: Work,
  index: number,
  what: "template" | "style",
  id: string,
  path: string,
  name: string,
): T | Diagnostic {
  if (work.brand === undefined) return noBrand(index, name);
  const mine = (what === "style" ? work.brand.styles : work.templates) as Record<string, T> | undefined;
  const found = own(mine, id);
  if (found) return found;
  const theirs = own<unknown>(what === "style" ? BUILT_IN_STYLES : BUILT_IN_TEMPLATES, id);
  return theirs
    ? builtIn(index, path, what, id, theirs)
    : unknownId(index, path, id, what, Object.keys(mine ?? {}));
}

/** That an operation gives exactly one of `whole`, the whole thing or null, and `set`, the fields to change. */
function either(index: number, op: object, whole: string): Diagnostic | undefined {
  const given = Number(has(op, whole)) + Number(has(op, "set"));
  return given === 1
    ? undefined
    : problem(
        index,
        "",
        given ? "forbidden-property" : "missing-property",
        `Give "${whole}" to write the whole ${whole}, or "set" to change some of its fields: one of the two.`,
      );
}

function setStyle(work: Work, op: Extract<Op, { op: "style.set" }>, index: number): Diagnostic | undefined {
  if (work.brand === undefined) return noBrand(index, "style.set");
  const bad = either(index, op, "style");
  if (bad) return bad;
  let style = op.style as BlockStyle | null;
  if (op.set) {
    const was = ownEntry<BlockStyle>(work, index, "style", op.id, "/id", "style.set");
    if (isProblem(was)) return was;
    style = patch(was, op.set);
  }
  // A computed key in a literal defines the property, so no id can reach a prototype.
  const styles: Record<string, BlockStyle> =
    style === null ? { ...work.brand.styles } : { ...work.brand.styles, [op.id]: style };
  if (style === null) {
    if (!has(styles, op.id)) return unknownId(index, "/id", op.id, "style", Object.keys(styles));
    delete styles[op.id];
  }
  work.brand = patch(work.brand, { styles: Object.keys(styles).length > 0 ? styles : null });
  return undefined;
}

function setTemplate(
  work: Work,
  op: Extract<Op, { op: "template.set" }>,
  index: number,
): Diagnostic | undefined {
  if (work.brand === undefined) return noBrand(index, "template.set");
  const bad = either(index, op, "template");
  if (bad) return bad;
  let templates: Record<string, Template> = { ...work.templates };
  if (op.set) {
    const was = ownEntry<Template>(work, index, "template", op.id, "/id", "template.set");
    if (isProblem(was)) return was;
    const fixed = forbid(index, op.set, ["id", "schemaVersion"], "template.set");
    if (fixed) return fixed;
    templates = { ...templates, [op.id]: patch(was, op.set) };
  } else if (op.template === null) {
    if (!has(templates, op.id)) return unknownId(index, "/id", op.id, "template", Object.keys(templates));
    delete templates[op.id];
  } else {
    const given = op.template as Record<string, unknown>;
    if (has(given, "id") && given.id !== op.id) {
      return problem(
        index,
        "/template/id",
        "template-id-mismatch",
        `The template says the id "${String(given.id)}", but the operation writes "${op.id}".`,
        `Leave "id" out of the template, or make it "${op.id}".`,
      );
    }
    // A computed key in a literal defines the property, so no id can reach a prototype.
    templates = { ...templates, [op.id]: { schemaVersion: "0.4", id: op.id, ...op.template } as Template };
  }
  work.templates = templates;
  return undefined;
}

/** The template a slot operation names and where its slot `id` is in it, or why there is none. */
function slotOf(
  work: Work,
  index: number,
  op: { op: string; template: string; id: string },
): { template: Template; at: number } | Diagnostic {
  const template = ownEntry<Template>(work, index, "template", op.template, "/template", op.op);
  if (isProblem(template)) return template;
  const at = template.slots.findIndex((slot) => slot.id === op.id);
  if (at >= 0) return { template, at };
  return unknownId(
    index,
    "/id",
    op.id,
    "slot",
    template.slots.map((slot) => slot.id),
  );
}

const withSlots = (work: Work, template: Template, slots: TemplateSlot[]) => {
  work.templates = { ...work.templates, [template.id]: { ...template, slots } };
};

/**
 * Each block in the slot `from` of a scene on `template`, as `block "<id>" of scene "<id>"`, and rewritten by `next`
 * when it is given. A scene with none stays as it is.
 */
function blocksIn(work: Work, template: string, from: string, next?: (block: Block) => Block): string[] {
  const found: string[] = [];
  for (const id of work.deck.scenes) {
    const scene = work.scenes[id] as Scene;
    if (scene.template !== template) continue;
    const before = found.length;
    const blocks = scene.blocks.map((block) => {
      if (block.slot !== from) return block;
      found.push(`block "${block.id}" of scene "${id}"`);
      return next ? next(block) : block;
    });
    if (next && found.length > before) work.scenes[id] = { ...scene, blocks };
  }
  return found;
}

function step(work: Work, op: Op, index: number): Diagnostic | undefined {
  switch (op.op) {
    case "brand.set":
      return setBrand(work, op, index);
    case "style.set":
      return setStyle(work, op, index);
    case "template.set":
      return setTemplate(work, op, index);
    case "slot.add": {
      const template = ownEntry<Template>(work, index, "template", op.template, "/template", op.op);
      if (isProblem(template)) return template;
      const slots = place(index, "slot", template.slots, op.slot, op.after);
      if (isProblem(slots)) return slots;
      withSlots(work, template, slots);
      return undefined;
    }
    case "slot.set": {
      const found = slotOf(work, index, op);
      if (isProblem(found)) return found;
      const bad = forbid(index, op.set, ["id"], "slot.set", "Use slot.rename.");
      if (bad) return bad;
      withSlots(
        work,
        found.template,
        found.template.slots.map((slot, i) => (i === found.at ? patch(slot, op.set) : slot)),
      );
      return undefined;
    }
    case "slot.rename": {
      const found = slotOf(work, index, op);
      if (isProblem(found)) return found;
      const { template, at } = found;
      // A name another slot has is refused by the template's check: two slots with one id.
      withSlots(
        work,
        template,
        template.slots.map((slot, i) => (i === at ? { ...slot, id: op.to } : slot)),
      );
      blocksIn(work, template.id, op.id, (block) => ({ ...block, slot: op.to }));
      return undefined;
    }
    case "slot.remove": {
      const found = slotOf(work, index, op);
      if (isProblem(found)) return found;
      const { template, at } = found;
      const gone = template.slots[at] as TemplateSlot;
      const others = template.slots.filter((slot) => slot !== gone).map((slot) => slot.id);
      if (!has(op, "to")) {
        const used = blocksIn(work, template.id, op.id);
        if (used.length > 0) {
          return problem(
            index,
            "/id",
            "slot-in-use",
            `The slot "${op.id}" holds ${used.join(", ")}.`,
            `Give "to": another slot (${others.join(", ")}), or null to take them out of the slots, pinned where this one was.`,
          );
        }
      } else if (typeof op.to === "string" && !others.includes(op.to)) {
        return unknownId(index, "/to", op.to, "slot", others);
      }
      withSlots(
        work,
        template,
        template.slots.filter((slot) => slot !== gone),
      );
      blocksIn(work, template.id, op.id, (block) =>
        op.to ? { ...block, slot: op.to } : patch(block, { slot: null, frame: block.frame ?? gone.frame }),
      );
      return undefined;
    }
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
      const scene = work.scenes[op.id] as Scene;
      // A scene that gains a template is 0.4, so it is upgraded first, as block.set upgrades for a slot: text written
      // later in the same operations is then read as markup whichever of the two came first.
      const base = typeof op.set.template === "string" && !readsMarkup(scene) ? upgradeScene(scene) : scene;
      work.scenes[op.id] = patch(base, op.set);
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
      const bad = forbid(index, op.set, ["id", "type"], "block.set");
      if (bad) return bad;
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

/**
 * True when `block` has a 0.3 or 0.4 part and `scene` is older than 0.3, so the scene must be upgraded to hold it:
 * both read text as markup.
 */
const needsUpgrade = (scene: Scene, block: Block): boolean =>
  !readsMarkup(scene) && versionAtLeast(blockNeeds(block), "0.3");

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

  const work: Work = {
    deck: doc.deck,
    scenes: { ...doc.scenes },
    brand: doc.brand,
    templates: doc.templates,
  };
  for (const [index, op] of (ops as Op[]).entries()) {
    const bad = step(work, op, index);
    if (bad) return fail("bad-op", prevRev, [bad]);
  }

  // A file says the version its content needs, as the tool writes the version of a new scene: 0.2 for a frame.
  for (const [id, scene] of Object.entries(work.scenes)) {
    if (scene !== own(doc.scenes, id)) work.scenes[id] = raiseScene(scene);
  }
  if (work.deck !== doc.deck) work.deck = raiseDeck(work.deck);

  const next: Doc = {
    deck: work.deck,
    scenes: work.scenes,
    assets: doc.assets,
    ...(work.brand === undefined ? {} : { brand: work.brand, templates: work.templates ?? {} }),
    ...(doc.brandFiles === undefined ? {} : { brandFiles: doc.brandFiles }),
    ...(doc.brandHashes === undefined ? {} : { brandHashes: doc.brandHashes }),
  };
  const diagnostics = checkChanges(doc, next);
  if (diagnostics.some((d) => d.severity === "error")) return fail("invalid-deck", prevRev, diagnostics);
  for (const id of next.deck.scenes) {
    const scene = next.scenes[id] as Scene;
    const was = own(doc.scenes, id);
    if (scene !== was) diagnostics.push(...literalWarnings(was, scene));
  }

  const changed = next.deck.scenes.filter((id) => {
    const before = own(doc.scenes, id);
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
    brandChanged:
      canonicalJson({ brand: doc.brand, templates: doc.templates }) !==
      canonicalJson({ brand: next.brand, templates: next.templates }),
    diagnostics,
  };
}
