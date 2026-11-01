import type { Doc } from "@depthcue/core";
import type { Count } from "./commentview.ts";
import type { Problem } from "./ribbon.ts";
import { LEAD_LABEL, type Lead } from "./templates.ts";

/** One scene on the storyboard: where it is in the deck, who leads it and what is waiting on it. */
export interface Card {
  id: string;
  /** Its place in the deck, from 1. */
  number: number;
  title: string;
  lead: Lead;
  /** Changes since the last review. */
  changed: number;
  /** Things the checks say are wrong with it, as the ribbon counts them. */
  toCheck: number;
  /** Comments nobody has resolved, and how many of those the agent has been asked about. */
  comments: number;
  tasks: number;
  /** Blocks pinned where they are instead of left to the layout. */
  pinned: number;
}

/** What each scene is marked with. A scene a map leaves out has none of it. */
export interface Marks {
  comments?: ReadonlyMap<string, Count> | undefined;
  changed?: ReadonlyMap<string, number> | undefined;
  checks?: ReadonlyMap<string, number> | undefined;
}

/** The cards in the deck's order, each with its marks. */
export function cardsOf(doc: Doc, marks: Marks = {}): Card[] {
  return doc.deck.scenes.flatMap((id, index): Card[] => {
    const scene = doc.scenes[id];
    if (!scene) return [];
    const count = marks.comments?.get(id);
    return [
      {
        id,
        number: index + 1,
        title: scene.title,
        lead: scene.lead ?? "human",
        changed: marks.changed?.get(id) ?? 0,
        toCheck: marks.checks?.get(id) ?? 0,
        comments: count?.open ?? 0,
        tasks: count?.tasks ?? 0,
        pinned: scene.blocks.filter((block) => block.frame !== undefined).length,
      },
    ];
  });
}

/** How many problems each scene has, from the list the ribbon walks. */
export function checksByScene(problems: readonly Problem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const problem of problems) counts.set(problem.scene, (counts.get(problem.scene) ?? 0) + 1);
  return counts;
}

export interface Pill {
  kind: "lead" | "changed" | "check" | "comments" | "pinned";
  text: string;
  /** On the lead pill: who leads, so an agent-led scene can stand out. */
  lead?: Lead;
  /** On the comments pill: the agent is being waited on. */
  tasks?: boolean;
}

const noun = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The marks a card shows, in the order it shows them. The lead is always there; the others only when there is something. */
export function pillsOf(card: Card): Pill[] {
  const pills: Pill[] = [{ kind: "lead", text: LEAD_LABEL[card.lead], lead: card.lead }];
  if (card.changed > 0) pills.push({ kind: "changed", text: `${card.changed} changed` });
  if (card.toCheck > 0) pills.push({ kind: "check", text: `${card.toCheck} to check` });
  if (card.comments > 0) {
    pills.push({
      kind: "comments",
      text: noun(card.comments, "comment", "comments"),
      ...(card.tasks > 0 ? { tasks: true } : {}),
    });
  }
  if (card.pinned > 0) pills.push({ kind: "pinned", text: `${card.pinned} pinned` });
  return pills;
}

/** The card in a sentence, for a screen reader: the pills are said in words, because the card's button carries them. */
export function sayCard(card: Card): string {
  const parts = [`Scene ${card.number}, ${card.title}`, `Lead: ${LEAD_LABEL[card.lead]}`];
  if (card.changed > 0) parts.push(`${noun(card.changed, "change", "changes")} to review`);
  if (card.toCheck > 0) parts.push(`${noun(card.toCheck, "thing", "things")} to check`);
  if (card.comments > 0) {
    const waiting = card.tasks > 0 ? `, ${card.tasks} waiting for the agent` : "";
    parts.push(`${noun(card.comments, "open comment", "open comments")}${waiting}`);
  }
  if (card.pinned > 0) parts.push(noun(card.pinned, "pinned block", "pinned blocks"));
  return `${parts.join(". ")}.`;
}

export type Step = "left" | "right" | "up" | "down" | "first" | "last";

const STEP_OF_KEY: ReadonlyMap<string, Step> = new Map<string, Step>([
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["Home", "first"],
  ["End", "last"],
]);

/** The way a key moves over the cards, if it does. */
export const stepOfKey = (key: string): Step | undefined => STEP_OF_KEY.get(key);

/**
 * Where a step leads from card `at`, in a grid of `columns` and `count` cards in reading order. Left and right go
 * card to card, over the end of a row onto the next. Up and down keep the column, and down from the row above a
 * short last row lands on its last card instead of going nowhere. An edge is a stop, not a wrap.
 */
export function stepTo(step: Step, at: number, count: number, columns: number): number {
  const last = count - 1;
  const width = Math.max(1, columns);
  switch (step) {
    case "left":
      return Math.max(0, at - 1);
    case "right":
      return Math.min(last, at + 1);
    case "up":
      return at - width >= 0 ? at - width : at;
    case "down":
      if (at + width <= last) return at + width;
      return Math.floor(at / width) < Math.floor(last / width) ? last : at;
    case "first":
      return 0;
    case "last":
      return last;
  }
}
