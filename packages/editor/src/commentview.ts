import { type Comment, type Doc, isOrphan, isTask } from "@depthcue/core";
import type { Rect } from "./pin.ts";

/**
 * What a pin looks like and says: `task` is an Ask the agent comment the agent has not answered, `answered` one it
 * has, `open` a plain comment and `resolved` one nobody needs to look at again.
 */
export type PinState = "open" | "task" | "answered" | "resolved";

export function stateOf(comment: Comment): PinState {
  if (comment.resolved) return "resolved";
  if (isTask(comment)) return "task";
  return comment.ask === true ? "answered" : "open";
}

/** A comment of the scene on show, as the slide draws it. */
export interface PinView {
  comment: Comment;
  /** Its place among every comment of the scene, in the order they were written. A resolved one keeps its number. */
  number: number;
  state: PinState;
  /** The block it points at is not on the scene any more. */
  orphan: boolean;
}

/**
 * The comments to draw on one scene: the open ones, and the resolved ones when asked. Numbers count every comment of
 * the scene, so resolving one does not renumber the pins that are left.
 */
export function pinsOf(
  comments: readonly Comment[],
  doc: Doc,
  sceneId: string,
  showResolved: boolean,
): PinView[] {
  const views: PinView[] = [];
  let number = 0;
  for (const comment of comments) {
    if (comment.scene !== sceneId) continue;
    number += 1;
    if (comment.resolved && !showResolved) continue;
    views.push({ comment, number, state: stateOf(comment), orphan: isOrphan(comment, doc) });
  }
  return views;
}

/** The open comments and the tasks among them: what the bar and a scene's thumbnail say. */
export interface Count {
  open: number;
  tasks: number;
  resolved: number;
}

const none = (): Count => ({ open: 0, tasks: 0, resolved: 0 });

/**
 * How many comments the deck has, in all and for each scene. A comment on a scene that is gone has no place on the
 * slide or in the strip to be found, so it is not counted: a number that no pin matches would only confuse.
 */
export function countsOf(
  comments: readonly Comment[],
  doc: Doc,
): { total: Count; byScene: ReadonlyMap<string, Count> } {
  const total = none();
  const byScene = new Map<string, Count>();
  for (const comment of comments) {
    if (doc.scenes[comment.scene] === undefined) continue;
    const here = byScene.get(comment.scene) ?? none();
    byScene.set(comment.scene, here);
    for (const count of [total, here]) {
      if (comment.resolved) count.resolved += 1;
      else count.open += 1;
      if (isTask(comment)) count.tasks += 1;
    }
  }
  return { total, byScene };
}

export interface Point {
  x: number;
  y: number;
}

/** Thousandths of the block are as fine as a person can point, and the core keeps no more. */
const thousandth = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Where a point of the screen falls on a block, as fractions of its width and height from its top left. */
export function anchorAt(point: Point, box: Rect): Point {
  return {
    x: box.width > 0 ? thousandth(clamp((point.x - box.left) / box.width)) : 0.5,
    y: box.height > 0 ? thousandth(clamp((point.y - box.top) / box.height)) : 0.5,
  };
}

/** The point of the screen a block's fractions stand for: where a pin goes. */
export function pointOf(anchor: Point, box: Rect): Point {
  return { x: box.left + anchor.x * box.width, y: box.top + anchor.y * box.height };
}

/**
 * Where a comment goes when it is made from the keyboard or the palette and nobody pointed. The corner keeps the pin
 * off the middle of the block, where the words are.
 */
export const DEFAULT_ANCHOR: Point = { x: 0.92, y: 0.12 };

/** "You" or "The agent", for the head of a message. */
export const WHO = { you: "You", agent: "Agent" } as const;
