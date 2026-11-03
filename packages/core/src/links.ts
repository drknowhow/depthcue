import { closest } from "./diagnostics.ts";
import { ASSET_PATTERN, ID_PATTERN } from "./schema.ts";
import type { Deck, Diagnostic, Scene } from "./types.ts";

/**
 * What a link in the library points at. The player follows an address and a deck file, jumps to a scene, and never
 * follows a `path`: a browser does not open a place on a disk, so a path is a note for the author's own machine.
 */
export type LinkTarget =
  | { kind: "address"; scheme: "https" | "http" | "mailto" | "tel" | "sms"; href: string }
  | { kind: "asset"; asset: string }
  | { kind: "scene"; scene: string; step?: string }
  | { kind: "path"; path: string };

export type LinkKind = LinkTarget["kind"];

const ADDRESS: Record<"https" | "http" | "mailto" | "tel" | "sms", RegExp> = {
  https: /^https:\/\/[^\s<>"\\]+$/,
  http: /^http:\/\/[^\s<>"\\]+$/,
  mailto: /^mailto:[^\s<>"\\]+$/,
  tel: /^tel:\+?[0-9-]{3,20}$/,
  sms: /^sms:\+?[0-9-]{3,20}(\?[^\s<>"\\]*)?$/,
};
const ASSET = new RegExp(ASSET_PATTERN);
const SCENE = new RegExp(`^scene:(${ID_PATTERN.slice(1, -1)})(?:#(${ID_PATTERN.slice(1, -1)}))?$`);
const hasControl = (text: string): boolean =>
  [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The target a link's text names, or undefined when it is none of the forms. */
export function parseTarget(text: string): LinkTarget | undefined {
  for (const scheme of Object.keys(ADDRESS) as Array<keyof typeof ADDRESS>) {
    if (text.startsWith(`${scheme}:`) && ADDRESS[scheme].test(text))
      return { kind: "address", scheme, href: text };
  }
  if (ASSET.test(text)) return { kind: "asset", asset: text };
  const scene = SCENE.exec(text);
  if (scene) return { kind: "scene", scene: scene[1] as string, ...(scene[2] ? { step: scene[2] } : {}) };
  if (text.startsWith("path:")) {
    const path = text.slice(5).trim();
    if (path !== "" && !hasControl(path) && !URL_LIKE.test(path)) return { kind: "path", path };
  }
  return undefined;
}

export const TARGET_RULE =
  "A link target is an address (https:, http:, mailto:, tel: or sms:), a deck file (assets/...), a scene (scene:<id> or scene:<id>#<step>), or a place on your disk (path:<path>).";

type Entry = NonNullable<Deck["links"]>[number];

/**
 * The library's own facts: ids unique, each target well formed, and a scene target naming a scene of the deck. An
 * address that is not https and a path are warnings, since they work but not for every viewer.
 */
export function checkLinks(deck: Deck, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  (deck.links ?? []).forEach((entry: Entry, i) => {
    const at = `/links/${i}`;
    if (seen.has(entry.id)) {
      out.push({
        severity: "error",
        code: "duplicate-id",
        file,
        path: `${at}/id`,
        message: `"${entry.id}" is already the id of another link.`,
        fix: "Give each link its own id.",
      });
    }
    seen.add(entry.id);
    const target = parseTarget(entry.target);
    if (!target) {
      out.push({
        severity: "error",
        code: "bad-link-target",
        file,
        path: `${at}/target`,
        message: `"${entry.target}" is not a link target.`,
        fix: TARGET_RULE,
      });
    } else if (target.kind === "scene" && !deck.scenes.includes(target.scene)) {
      const guess = closest(target.scene, deck.scenes);
      out.push({
        severity: "error",
        code: "unknown-link-scene",
        file,
        path: `${at}/target`,
        message: `"${target.scene}" is not a scene of this deck.`,
        fix: guess ? `Did you mean "${guess}"?` : `Use one of: ${deck.scenes.join(", ")}.`,
      });
    } else if (target.kind === "address" && target.scheme === "http") {
      out.push({
        severity: "warning",
        code: "link-insecure",
        file,
        path: `${at}/target`,
        message: `"${entry.id}" is an http address, which a browser may warn about.`,
        fix: "Use the https address if the site has one.",
      });
    } else if (target.kind === "path") {
      out.push({
        severity: "warning",
        code: "link-local-path",
        file,
        path: `${at}/target`,
        message: `"${entry.id}" is a place on this computer; it opens nowhere else.`,
        fix: "Put the file in the deck's assets folder and link to it there, if others should open it.",
      });
    }
  });
  return out;
}

/** The deck files the library's links name, with where each is named: they go into an export with the scenes' own. */
export function deckAssetRefs(deck: Deck): Array<{ path: string; asset: string }> {
  const refs: Array<{ path: string; asset: string }> = [];
  (deck.links ?? []).forEach((entry, i) => {
    const target = parseTarget(entry.target);
    if (target?.kind === "asset") refs.push({ path: `/links/${i}/target`, asset: target.asset });
  });
  return refs;
}

/** Errors for a link to a deck file that is not in the deck. */
export function checkLinkAssets(deck: Deck, assets: ReadonlySet<string>, file: string): Diagnostic[] {
  return deckAssetRefs(deck)
    .filter((ref) => !assets.has(ref.asset))
    .map((ref) => ({
      severity: "error" as const,
      code: "missing-asset",
      file,
      path: ref.path,
      message: `${ref.asset} does not exist.`,
      fix: "Add the file to the deck folder, or point the link at an existing asset.",
    }));
}

/** Where a scene points at a library link: a block's `link` or a source's `link`, with the path in the scene. */
export function linkUses(scene: Scene): Array<{ id: string; path: string }> {
  const uses: Array<{ id: string; path: string }> = [];
  scene.blocks.forEach((block, i) => {
    if (block.link !== undefined) uses.push({ id: block.link, path: `/blocks/${i}/link` });
  });
  scene.sources?.forEach((source, i) => {
    if (source.link !== undefined) uses.push({ id: source.link, path: `/sources/${i}/link` });
  });
  return uses;
}

/** Errors for a block or a source whose `link` is not in the deck's library. */
export function checkSceneLinks(scene: Scene, deck: Deck, file: string): Diagnostic[] {
  const ids = (deck.links ?? []).map((entry) => entry.id);
  return linkUses(scene)
    .filter((use) => !ids.includes(use.id))
    .map((use) => {
      const guess = closest(use.id, ids);
      const list = ids.length ? `Links in this deck: ${ids.join(", ")}.` : "This deck has no links yet.";
      return {
        severity: "error" as const,
        code: "unknown-link",
        file,
        path: use.path,
        message: `"${use.id}" is not a link in this deck.`,
        fix: guess ? `Did you mean "${guess}"? ${list}` : list,
      };
    });
}

/** The scene with every use of link `from` pointing at `to`; the same scene when it has none. */
export function relink(scene: Scene, from: string, to: string): Scene {
  if (!linkUses(scene).some((use) => use.id === from)) return scene;
  return {
    ...scene,
    blocks: scene.blocks.map((block) => (block.link === from ? { ...block, link: to } : block)),
    ...(scene.sources
      ? { sources: scene.sources.map((s) => (s.link === from ? { ...s, link: to } : s)) }
      : {}),
  };
}
