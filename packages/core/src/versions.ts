/**
 * What each schema version adds, so a file declares the version its fields need and is read as that version. A file
 * is rewritten as a newer version only when it gains something of that version, as the operations do, never by
 * loading it. 0.3 changes how text reads, so upgrading a scene to 0.3 also escapes its text: a `*` that was a star
 * stays a star. 0.4 reads text as 0.3 does, so a scene below 0.3 that gains a 0.4 part is escaped on the way too.
 */
import { escapeText, type Flow, literalText, parseText, visibleText } from "./inline.ts";
import { SCHEMA_VERSIONS, TEXT_LIMITS } from "./schema.ts";
import type { Block, Deck, Diagnostic, Scene } from "./types.ts";

export type SchemaVersion = (typeof SCHEMA_VERSIONS)[number];
type TextBlock = Extract<Block, { type: "text" }>;

const rank = (version: string): number => SCHEMA_VERSIONS.indexOf(version as SchemaVersion);
/** True when `version` is `min` or later. */
export const versionAtLeast = (version: string, min: SchemaVersion): boolean => rank(version) >= rank(min);
const newest = (a: SchemaVersion, b: SchemaVersion): SchemaVersion => (rank(b) > rank(a) ? b : a);

/** True when the scene's text is markup: from 0.3. Below that, text is shown exactly as it is written. */
export const readsMarkup = (scene: Pick<Scene, "schemaVersion">): boolean =>
  versionAtLeast(scene.schemaVersion, "0.3");

/** The properties of a text block that came with 0.3. */
export const TEXT_STYLE_KEYS = ["tone", "size", "align"] as const;
/** The properties of any block that came with 0.4: the template slot it sits in and the style it takes. */
export const BLOCK_BRAND_KEYS = ["slot", "style"] as const;
/** The properties of an image block that came with 0.6: how it takes its box, and that it carries no information. */
export const IMAGE_KEYS = ["fit", "crop", "focus", "decorative"] as const;
/** The properties of deck.json that came after 0.1, with the version each came with. */
export const DECK_KEYS_BY_VERSION = { palette: "0.3", fonts: "0.3", brand: "0.4", links: "0.5" } as const;

type Part = { name: string; version: SchemaVersion; path: string };

/**
 * What a block uses that its scene's version must have, by the name its diagnostic code takes, with the path. The
 * operations call this before a block is checked, so it takes anything without failing.
 */
function newerParts(block: Block): Part[] {
  const out: Part[] = [];
  if (block === null || typeof block !== "object") return out;
  if (block.type === "table" || block.type === "chart")
    out.push({ name: block.type, version: "0.3", path: "" });
  if (block.type === "text") {
    for (const key of TEXT_STYLE_KEYS)
      if (block[key] !== undefined) out.push({ name: key, version: "0.3", path: `/${key}` });
  }
  for (const key of BLOCK_BRAND_KEYS)
    if (block[key] !== undefined) out.push({ name: key, version: "0.4", path: `/${key}` });
  if (block.link !== undefined) out.push({ name: "link", version: "0.5", path: "/link" });
  if (block.type === "image") {
    for (const key of IMAGE_KEYS)
      if (block[key] !== undefined) out.push({ name: key, version: "0.6", path: `/${key}` });
  }
  if (block.frame !== undefined) out.push({ name: "frame", version: "0.2", path: "/frame" });
  return out;
}

/** The oldest version that has everything the block uses. */
export function blockNeeds(block: Block): SchemaVersion {
  return newerParts(block).reduce<SchemaVersion>((most, part) => newest(most, part.version), "0.1");
}

/**
 * The oldest version that has everything the scene uses: its blocks, a template, which came with 0.4, a source's
 * link, which came with 0.5, and a background, which came with 0.6.
 */
export const sceneNeeds = (scene: Scene): SchemaVersion => {
  const base: SchemaVersion =
    scene.background !== undefined
      ? "0.6"
      : scene.sources?.some((source) => source?.link !== undefined)
        ? "0.5"
        : scene.template === undefined
          ? "0.1"
          : "0.4";
  return (Array.isArray(scene.blocks) ? scene.blocks : []).reduce<SchemaVersion>(
    (most, block) => newest(most, blockNeeds(block)),
    base,
  );
};

/** The oldest version that has everything deck.json uses. */
export const deckNeeds = (deck: Deck): SchemaVersion =>
  Object.entries(DECK_KEYS_BY_VERSION).reduce<SchemaVersion>(
    (most, [key, version]) => (deck[key as keyof Deck] === undefined ? most : newest(most, version)),
    "0.1",
  );

const tooOld = (
  file: string,
  path: string,
  name: string,
  version: string,
  declared: string,
  what: string,
) => ({
  severity: "error" as const,
  code: `${name}-needs-version`,
  file,
  path,
  message: `${what} came with schema ${version}, but this file says schemaVersion "${declared}".`,
  fix: `Remove it, then set it again with depthcue apply or deck_apply: the tool rewrites the file as ${version}${escapes(version, declared, file) ? " and escapes its text, so the text keeps its meaning" : ""}.`,
});
/** Whether raising the file says it escapes text: a 0.3 part always has, and a 0.4 part does for a scene below 0.3. */
const escapes = (version: string, declared: string, file: string): boolean =>
  version === "0.3" || (rank(declared) < rank("0.3") && file !== "deck.json");

/**
 * Errors for 0.3 and 0.4 parts of a scene that declares an older version, under `<part>-needs-version`, such as
 * `tone-needs-version`, `table-needs-version`, `slot-needs-version` or `template-needs-version`. Frames have their own
 * check, in frames.ts. Setting the version by hand is not the fix this suggests: the text of a scene changes meaning at
 * 0.3, and the tool escapes it on the way.
 */
export function checkSceneVersion(scene: Scene, file: string): Diagnostic[] {
  const declared = rank(scene.schemaVersion);
  const out: Diagnostic[] = [];
  if (scene.template !== undefined && declared < rank("0.4"))
    out.push(tooOld(file, "/template", "template", "0.4", scene.schemaVersion, '"template"'));
  if (scene.background !== undefined && declared < rank("0.6"))
    out.push(tooOld(file, "/background", "background", "0.6", scene.schemaVersion, '"background"'));
  scene.sources?.forEach((source, i) => {
    if (source.link !== undefined && declared < rank("0.5"))
      out.push(tooOld(file, `/sources/${i}/link`, "link", "0.5", scene.schemaVersion, '"link"'));
  });
  scene.blocks.forEach((block, i) => {
    for (const part of newerParts(block)) {
      if (part.name === "frame" || rank(part.version) <= declared) continue;
      const what = part.path === "" ? `A ${part.name} block` : `"${part.name}"`;
      out.push(tooOld(file, `/blocks/${i}${part.path}`, part.name, part.version, scene.schemaVersion, what));
    }
  });
  return out;
}

/** Errors for a palette, font pair or brand in a deck.json that declares a version before the one each came with. */
export function checkDeckVersion(deck: Deck, file = "deck.json"): Diagnostic[] {
  return Object.entries(DECK_KEYS_BY_VERSION)
    .filter(
      ([key, version]) => deck[key as keyof Deck] !== undefined && rank(deck.schemaVersion) < rank(version),
    )
    .map(([key, version]) => tooOld(file, `/${key}`, key, version, deck.schemaVersion, `"${key}"`));
}

const lists = (block: TextBlock): { lists: boolean } => ({ lists: block.role === "body" });

/** A text block's text as paragraphs and lists: parsed in a scene that reads markup, one plain paragraph below. */
export const textFlow = (scene: Pick<Scene, "schemaVersion">, block: TextBlock): Flow[] =>
  readsMarkup(scene) ? parseText(block.text, lists(block)) : literalText(block.text);

/** The words of a text block as the audience sees them, without markup. */
export const shownText = (scene: Pick<Scene, "schemaVersion">, block: TextBlock): string =>
  visibleText(textFlow(scene, block));

/**
 * The scene at 0.3, with the text of each text block escaped so that it reads exactly as before. A scene at 0.3
 * already comes back as it is, the same object.
 */
export function upgradeScene(scene: Scene): Scene {
  if (readsMarkup(scene) || !Array.isArray(scene.blocks)) return scene;
  return {
    ...scene,
    schemaVersion: "0.3",
    blocks: scene.blocks.map((block) =>
      block?.type === "text" && typeof block.text === "string"
        ? { ...block, text: escapeText(block.text, lists(block)) }
        : block,
    ),
  };
}

/**
 * The scene at the version its content needs, when that is newer than the one it says: 0.2 for a frame, and for a
 * 0.3 or 0.4 part, that version by way of `upgradeScene`, so its text keeps its meaning. A scene that needs nothing
 * newer, or says a version there is no such thing as, comes back as it is.
 */
export function raiseScene(scene: Scene): Scene {
  const need = sceneNeeds(scene);
  if (rank(scene.schemaVersion) < 0 || rank(need) <= rank(scene.schemaVersion)) return scene;
  return { ...(versionAtLeast(need, "0.3") ? upgradeScene(scene) : scene), schemaVersion: need };
}

/** deck.json at the version its content needs, when that is newer than the one it says. */
export function raiseDeck(deck: Deck): Deck {
  const need = deckNeeds(deck);
  const declared = rank(deck.schemaVersion);
  return declared >= 0 && rank(need) > declared ? { ...deck, schemaVersion: need } : deck;
}

/**
 * Text longer than its role allows, counted as the audience sees it: in a scene that reads markup, without the
 * markup. Works on a scene that failed its structure check too, so a long text is reported with the other problems.
 */
export function checkText(data: unknown, file: string): Diagnostic[] {
  const scene = data as { schemaVersion?: unknown; blocks?: unknown } | null;
  if (scene === null || typeof scene !== "object" || !Array.isArray(scene.blocks)) return [];
  const version = { schemaVersion: String(scene.schemaVersion) } as Pick<Scene, "schemaVersion">;
  const out: Diagnostic[] = [];
  scene.blocks.forEach((entry: unknown, i) => {
    const block = entry as Partial<TextBlock> | null;
    if (block === null || typeof block !== "object" || block.type !== "text") return;
    if (typeof block.text !== "string" || block.text.length === 0) return;
    const limit = TEXT_LIMITS[block.role as keyof typeof TEXT_LIMITS];
    if (limit === undefined) return;
    const shown = shownText(version, block as TextBlock);
    const markup = readsMarkup(version);
    if (shown.length === 0) {
      out.push({
        severity: "error",
        code: "too-short",
        file,
        path: `/blocks/${i}/text`,
        message: "The text shows nothing: it is only markup.",
        fix: "Write the text, or remove the block.",
      });
    } else if (shown.length > limit) {
      out.push({
        severity: "error",
        code: "too-long",
        file,
        path: `/blocks/${i}/text`,
        message: `${shown.length} characters${markup && shown.length !== block.text.length ? " as shown" : ""}; the limit is ${limit}.`,
        fix: `Shorten it by ${shown.length - limit}, or move the detail into a body block or the reading text.`,
      });
    }
  });
  return out;
}
