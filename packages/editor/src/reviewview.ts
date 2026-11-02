import { type Change, type Doc, describeChange } from "@depthcue/core";

/** Longest piece of a value the drawer shows. The rest is a click away on the slide itself. */
const EXCERPT_LIMIT = 140;

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT - 1).trimEnd()}…` : flat;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value as a short line: text as it is, a block or a scene by what it holds, a list of ids joined. */
export function excerpt(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return clip(value);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    return clip(value.every((item) => typeof item === "string") ? value.join(", ") : JSON.stringify(value));
  }
  if (!isRecord(value)) return clip(JSON.stringify(value));
  if (typeof value.type === "string" && typeof value.id === "string") {
    // A block: its kind and the words on it, when it has any.
    const words =
      typeof value.text === "string"
        ? `: ${value.text}`
        : typeof value.alt === "string"
          ? `: ${value.alt}`
          : "";
    return clip(`${value.type}${words}`);
  }
  if (typeof value.title === "string" && Array.isArray(value.blocks)) {
    const count = value.blocks.length;
    return clip(`${value.title} (${count} ${count === 1 ? "block" : "blocks"})`);
  }
  return clip(JSON.stringify(value));
}

export interface ChangeRow {
  change: Change;
  /** Where the change is, as small capitals over it: `Scene 2 · Method · Block opening-title · text`. */
  where: string;
  /** The change in a sentence, for assistive technology. */
  said: string;
  /** What it was, when it was there, and what it is, when it still is. */
  before: string | undefined;
  after: string | undefined;
}

/** The scene's place and title, as the strip shows them. A scene that is gone is named by what it was. */
function sceneLabel(change: Change, doc: Doc): string {
  const id = change.scene as string;
  const at = doc.deck.scenes.indexOf(id);
  const gone = isRecord(change.before) ? change.before : undefined;
  const title = doc.scenes[id]?.title ?? (typeof gone?.title === "string" ? gone.title : id);
  return at >= 0 ? `Scene ${at + 1} · ${title}` : `Scene · ${title}`;
}

/** The brand's properties by name, as a row of the drawer says them. A property this leaves out is said by its key. */
const BRAND_KEY: Record<string, string> = {
  name: "Brand name",
  colors: "Brand colors",
  fonts: "Brand fonts",
  logos: "Brand logos",
  chrome: "Brand chrome",
  lock: "Brand lock",
  hideBuiltIn: "Built-ins the brand hides",
};

/** A change to the brand's files is one of the deck's: these name its parts, as `rowOf` says them. */
export const BRAND_CHANGE = /^deck\/(brand|style:|template:)/;

/** The name of a style or a template, from the value it had or has. */
const nameIn = (change: Change, id: string): string => {
  const value = isRecord(change.after) ? change.after : isRecord(change.before) ? change.before : {};
  return typeof value.name === "string" ? value.name : id;
};

/**
 * A part of the brand as a short line. Changed, it is only what differs from the other side, so a style that changed
 * its size says `size: "l"` and not the whole style; added or removed, a template is its name and how many slots it has.
 */
function brandExcerpt(value: unknown, other: unknown): string {
  if (!isRecord(value)) return excerpt(value);
  if (!isRecord(other)) {
    const slots = Array.isArray(value.slots) ? value.slots.length : undefined;
    return slots === undefined
      ? excerpt(value)
      : clip(`${value.name} (${slots} ${slots === 1 ? "slot" : "slots"})`);
  }
  const text = (part: unknown) => (part === undefined ? "none" : JSON.stringify(part));
  const keys = Object.keys({ ...other, ...value }).filter((key) => text(value[key]) !== text(other[key]));
  return clip(keys.map((key) => `${key}: ${text(value[key])}`).join("; "));
}

/** Where a change of the brand's files is, in plain words: "Brand colors", "Style: Callout", "Template: Cover". */
function brandWhere(change: Change): string | undefined {
  const field = change.field ?? "";
  if (field === "brand") return "Brand";
  if (field.startsWith("brand/")) return BRAND_KEY[field.slice(6)] ?? `Brand ${field.slice(6)}`;
  if (field.startsWith("style:")) return `Style: ${nameIn(change, field.slice(6))}`;
  if (field.startsWith("template:")) return `Template: ${nameIn(change, field.slice(9))}`;
  return undefined;
}

export function rowOf(change: Change, doc: Doc): ChangeRow {
  const parts: string[] = [];
  const brand = change.scope === "deck" ? brandWhere(change) : undefined;
  if (brand !== undefined) {
    parts.push(brand);
  } else if (change.scope === "deck") {
    parts.push("Deck", change.field === "scenes" ? "Scene order" : (change.field as string));
  } else {
    parts.push(sceneLabel(change, doc));
    if (change.scope === "block") parts.push(`Block ${change.block}`);
    if (change.field !== undefined) parts.push(change.field === "blocks" ? "Block order" : change.field);
  }
  const shown = (value: unknown, other: unknown) =>
    brand === undefined ? excerpt(value) : brandExcerpt(value, other);
  const was = change.kind === "added" ? undefined : shown(change.before, change.after);
  const is = change.kind === "removed" ? undefined : shown(change.after, change.before);
  return { change, where: parts.join(" · "), said: describeChange(change), before: was, after: is };
}

// The counts the bar and the strip show live with the book, so this module goes to the drawer's chunk alone.
export { countsByScene, type Summary, summaryOf } from "./reviewbook.ts";
