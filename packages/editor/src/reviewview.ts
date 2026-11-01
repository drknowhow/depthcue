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

export function rowOf(change: Change, doc: Doc): ChangeRow {
  const parts: string[] = [];
  if (change.scope === "deck") {
    parts.push("Deck", change.field === "scenes" ? "Scene order" : (change.field as string));
  } else {
    parts.push(sceneLabel(change, doc));
    if (change.scope === "block") parts.push(`Block ${change.block}`);
    if (change.field !== undefined) parts.push(change.field === "blocks" ? "Block order" : change.field);
  }
  const was = change.kind === "added" ? undefined : excerpt(change.before);
  const is = change.kind === "removed" ? undefined : excerpt(change.after);
  return { change, where: parts.join(" · "), said: describeChange(change), before: was, after: is };
}

export interface Summary {
  /** Changes the agent made and nobody has answered. */
  agent: number;
  /** Changes somebody made by editing the files by hand. */
  outside: number;
}

export function summaryOf(changes: readonly Change[]): Summary {
  const agent = changes.filter((change) => change.by === "agent").length;
  return { agent, outside: changes.length - agent };
}

/** How many changes each scene has, for the mark on its thumbnail. A change to the deck itself belongs to no scene. */
export function countsByScene(changes: readonly Change[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const change of changes) {
    if (change.scene !== undefined) counts.set(change.scene, (counts.get(change.scene) ?? 0) + 1);
  }
  return counts;
}
