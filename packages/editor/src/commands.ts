import { LEADS, type Session } from "@depthcue/core";
import type { Command } from "./palette.ts";
import type { Ribbon } from "./ribbon.ts";
import { LAYOUT_CHOICES, type Layout, LEAD_LABEL, type NewBlockKind } from "./templates.ts";

/** What the commands call on. The mounted editor supplies each of them, so this file holds no state of its own. */
export interface CommandSources {
  session: Session;
  /** The scene on show, and the block chosen on it, if any. */
  scene(): string;
  block(): string | undefined;
  /** What the quick bar and the empty places on the slide do. */
  add(kind: NewBlockKind): void;
  pickImage(): void;
  claim(): void;
  hasVideo(): boolean;
  /** What the toolbar of a block does. */
  togglePin(id: string): void;
  remove(id: string): void;
  /** What the buttons of the scene bar do. */
  setLead(lead: (typeof LEADS)[number]): void;
  setLayout(layout: Layout): void;
  autoLayout(): void;
  /** The problem ribbon, which knows which problem is on show and what settles it. */
  ribbon: Pick<Ribbon, "problems" | "current" | "step" | "fixNext">;
  goTo(sceneId: string): void;
  undo(): void;
  redo(): void;
  save(): void;
  present(): void;
  showKeys(): void;
  /** The keys that do the same as a shortcut of the table, by its id. */
  keysOf(id: string): readonly (readonly string[])[] | undefined;
}

/**
 * What the editor can do now, for the palette to list. A command that cannot be done is left out and not shown
 * greyed: a list that only holds things that work needs no reading to find out why one does not.
 */
export function listCommands(from: CommandSources): Command[] {
  const { session } = from;
  const sceneId = from.scene();
  const scene = session.doc.scenes[sceneId];
  if (!scene) return [];
  const out: Command[] = [];
  const add = (command: Command) => out.push(command);

  const problem = from.ribbon.current;
  if (problem?.fix) {
    add({
      id: "fix",
      title: `Fix the problem shown: ${problem.fix.label}`,
      group: "Problems",
      words: "repair settle ribbon",
      run: () => void from.ribbon.fixNext(),
    });
  }
  if (from.ribbon.problems.length > 1) {
    add({
      id: "next-problem",
      title: "Next problem",
      group: "Problems",
      words: "ribbon",
      run: () => from.ribbon.step(1),
    });
    add({
      id: "previous-problem",
      title: "Previous problem",
      group: "Problems",
      words: "ribbon back",
      run: () => from.ribbon.step(-1),
    });
  }

  add({
    id: "add-text",
    title: "Add a text",
    group: "Add",
    words: "paragraph heading words",
    keys: from.keysOf("add-text"),
    run: () => from.add("text"),
  });
  add({
    id: "add-chart",
    title: "Add a chart",
    group: "Add",
    words: "bar graph numbers",
    keys: from.keysOf("add-chart"),
    run: () => from.add("bar-chart"),
  });
  add({
    id: "add-image",
    title: "Add an image",
    group: "Add",
    words: "picture photo upload file",
    keys: from.keysOf("add-image"),
    run: () => from.pickImage(),
  });
  if (from.hasVideo()) {
    add({
      id: "add-clip",
      title: "Add a clip",
      group: "Add",
      words: "video movie",
      run: () => from.add("clip"),
    });
  }
  if (!scene.summary) {
    add({
      id: "add-claim",
      title: "Add a claim",
      group: "Add",
      words: "headline statement",
      run: () => from.claim(),
    });
  }

  const chosen = from.block();
  const block = chosen === undefined ? undefined : scene.blocks.find((candidate) => candidate.id === chosen);
  if (chosen !== undefined && block) {
    add({
      id: "pin",
      title: block.frame ? "Put the block back in its layout" : "Pin the block where it is",
      group: "The chosen block",
      words: "unpin free move frame",
      keys: from.keysOf("pin"),
      run: () => from.togglePin(chosen),
    });
  }
  if (chosen !== undefined && (block || scene.summary?.id === chosen)) {
    add({
      id: "remove",
      title: block ? "Remove the block" : "Remove the claim",
      group: "The chosen block",
      words: "delete",
      run: () => from.remove(chosen),
    });
  }

  if (scene.blocks.some((candidate) => candidate.frame)) {
    add({
      id: "auto-layout",
      title: "Put every pinned block back in its layout",
      group: "This scene",
      words: "auto unpin reset frames",
      run: () => from.autoLayout(),
    });
  }
  const lead = scene.lead ?? "human";
  for (const value of LEADS) {
    if (value === lead) continue;
    add({
      id: `lead-${value}`,
      title: `Lead: ${LEAD_LABEL[value]}`,
      group: "This scene",
      words: "who leads human agent shared",
      run: () => from.setLead(value),
    });
  }
  for (const choice of LAYOUT_CHOICES) {
    if (choice.value === scene.layout) continue;
    add({
      id: `layout-${choice.value}`,
      title: `Layout: ${choice.label}`,
      group: "This scene",
      words: "template arrangement",
      run: () => from.setLayout(choice.value),
    });
  }

  session.doc.deck.scenes.forEach((id, at) => {
    const other = session.doc.scenes[id];
    if (id === sceneId || !other) return;
    add({
      id: `scene-${id}`,
      title: `Go to scene ${at + 1}: ${other.title}`,
      group: "Go to",
      words: `slide ${id}`,
      run: () => from.goTo(id),
    });
  });

  if (session.canUndo)
    add({ id: "undo", title: "Undo", group: "Everywhere", keys: from.keysOf("undo"), run: from.undo });
  if (session.canRedo)
    add({ id: "redo", title: "Redo", group: "Everywhere", keys: from.keysOf("redo"), run: from.redo });
  add({ id: "save", title: "Save now", group: "Everywhere", keys: from.keysOf("save"), run: from.save });
  add({
    id: "present",
    title: "Present from this scene",
    group: "Everywhere",
    words: "show slideshow play",
    run: from.present,
  });
  add({
    id: "keys",
    title: "Show the keyboard shortcuts",
    group: "Everywhere",
    words: "help keys",
    keys: from.keysOf("help"),
    run: from.showKeys,
  });
  return out;
}
