import { blockStylesOf, type ChartKind, kindOf, LEADS, readsMarkup, type Session } from "@depthcue/core";
import { chartCommands } from "./chartwire.ts";
import { afterWhenMoving } from "./cleanup.ts";
import type { Spot } from "./grid.ts";
import type { Command } from "./palette.ts";
import type { Ribbon } from "./ribbon.ts";
import { type CellAction, cellCommands } from "./tablecells.ts";
import {
  ALIGN_LABEL,
  LAYOUT_CHOICES,
  type Layout,
  LEAD_LABEL,
  type NewBlockKind,
  SIZE_LABEL,
  TONE_LABEL,
} from "./templates.ts";

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
  /** Opens the box that writes a comment on a block, or the claim. */
  comment(id: string): void;
  /** What Cut, Copy and Duplicate do to a block. A command is listed only when the editor supplies what it calls. */
  cut?(id: string): void;
  copy?(id: string): void;
  duplicate?(id: string): void;
  /** Pastes the block the clipboard holds: after the chosen block, or where the menu was opened on the empty slide. */
  paste?(): void;
  /** Whether Paste could find a block. Without it Paste is listed whenever the editor can paste. */
  canPaste?(): boolean;
  /** Moves a block one place along the slide's order, as the arrows of its toolbar do. */
  moveBlock?(id: string, direction: -1 | 1): void;
  /** Changes the kind of a chart, or turns an old bar chart into a chart of that kind, as one change. */
  chartKind?(id: string, kind: ChartKind): void;
  /** Opens the data of a chart, where its rows and series are edited. */
  editData?(id: string): void;
  /**
   * Sets the size, alignment or color of a text, or with an empty value takes it off. A scene below 0.3 is brought up to
   * it by the first one set, so its text is read as markup from then on.
   */
  setTextStyle?(id: string, key: "size" | "align" | "tone", value: string): void;
  /** Brings a scene below 0.3 up to it, so its text is read as markup. */
  upgradeScene?(id: string): void;
  /** The cell of the chosen table that has the keyboard, or that the menu was opened on. Row -1 is the header. */
  cell?(): Spot | undefined;
  /** Does an action of the cell menu to the chosen table at a cell, as one change. */
  editCell?(action: CellAction, at: Spot): void;
  /** What the buttons of a scene in the strip do. */
  duplicateScene?(id: string): void;
  removeScene?(id: string): void;
  moveScene?(id: string, direction: -1 | 1): void;
  /** Whether the comments are on the slide, and putting them there or away. */
  commentsShown(): boolean;
  showComments(on: boolean): void;
  /** Opens the Style section of the Deck popover: the theme preset, the palette and the font pair. */
  deckStyle?(): void;
  /** Gives a block one of the deck's styles, or with "" takes its style off. */
  setBlockStyle?(id: string, style: string): void;
  /** A small picture of a style, for its item in the menu, once the part that draws it is in. */
  stylePreview?(style: string): Node | undefined;
  /** Why the styles are not listed yet, while they are on their way or did not arrive; undefined once they are in. */
  stylesComing?(): string | undefined;
  /** Opens Change template for the scene on show. */
  changeTemplate?(): void;
  /** Opens the template picker, which adds a scene after the one on show. */
  pickTemplate?(): void;
  /** What the buttons of the scene bar do. */
  setLead(lead: (typeof LEADS)[number]): void;
  setLayout(layout: Layout): void;
  autoLayout(): void;
  /** The problem ribbon, which knows which problem is on show and what settles it. */
  ribbon: Pick<Ribbon, "problems" | "current" | "step" | "fixNext">;
  goTo(sceneId: string): void;
  undo(): void;
  redo(): void;
  /** Whether there is something to undo or redo. Without these, the session's own answer: only edits count. */
  canUndo?(): boolean;
  canRedo?(): boolean;
  /** Opens the drawer of the changes since the last review, or closes it. */
  toggleReview?(): void;
  reviewOpen?(): boolean;
  /** Opens the storyboard, which shows every scene on one screen. */
  storyboard?(): void;
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

  // The menu on the empty slide: Paste first, then what can be added. An add there is an add of the quick bar.
  const chosen = from.block();
  const block = chosen === undefined ? undefined : scene.blocks.find((candidate) => candidate.id === chosen);
  const paste = from.paste;
  const canPaste = paste !== undefined && (from.canPaste?.() ?? true);
  if (paste && canPaste && chosen === undefined) {
    add({
      id: "paste-here",
      title: "Paste a block",
      group: "Add",
      words: "clipboard copied",
      keys: from.keysOf("paste"),
      targets: ["slide"],
      label: "Paste here",
      section: "add",
      run: paste,
    });
  }
  add({
    id: "add-text",
    title: "Add a text",
    group: "Add",
    words: "paragraph heading words",
    keys: from.keysOf("add-text"),
    targets: ["slide"],
    label: "Add a text here",
    section: "add",
    run: () => from.add("text"),
  });
  add({
    id: "add-chart",
    title: "Add a chart",
    group: "Add",
    words: "bar line area scatter donut graph numbers plot",
    keys: from.keysOf("add-chart"),
    targets: ["slide"],
    label: "Add a chart here",
    section: "add",
    run: () => from.add("chart"),
  });
  add({
    id: "add-table",
    title: "Add a table",
    group: "Add",
    words: "grid rows columns cells spreadsheet",
    targets: ["slide"],
    label: "Add a table here",
    section: "add",
    run: () => from.add("table"),
  });
  add({
    id: "add-image",
    title: "Add an image",
    group: "Add",
    words: "picture photo upload file",
    keys: from.keysOf("add-image"),
    targets: ["slide"],
    label: "Add an image here",
    section: "add",
    run: () => from.pickImage(),
  });
  if (from.hasVideo()) {
    add({
      id: "add-clip",
      title: "Add a clip",
      group: "Add",
      words: "video movie",
      targets: ["slide"],
      label: "Add a clip here",
      section: "add",
      run: () => from.add("clip"),
    });
  }
  if (!scene.summary) {
    add({
      id: "add-claim",
      title: "Add a claim",
      group: "Add",
      words: "headline statement",
      targets: ["slide"],
      section: "add",
      run: () => from.claim(),
    });
  }

  // The chosen block, or the claim. The menu lists them in three sections: what is done to it, where it goes, and notes.
  const item = block !== undefined || (chosen !== undefined && scene.summary?.id === chosen);
  // A chart's own commands come first in its menu: its data and its kind are what it is most often asked for.
  const { chartKind, editData } = from;
  if (block && chartKind) {
    for (const command of chartCommands(scene, block, { chartKind, editData }, session.doc.deck.language))
      add(command);
  }
  if (chosen !== undefined && block) {
    const { cut, copy } = from;
    if (cut) {
      add({
        id: "cut",
        title: "Cut the block",
        group: "The chosen block",
        words: "clipboard remove take",
        keys: from.keysOf("cut"),
        targets: ["block"],
        label: "Cut",
        section: "edit",
        run: () => cut(chosen),
      });
    }
    if (copy) {
      add({
        id: "copy",
        title: "Copy the block",
        group: "The chosen block",
        words: "clipboard",
        keys: from.keysOf("copy"),
        targets: ["block"],
        label: "Copy",
        section: "edit",
        run: () => copy(chosen),
      });
    }
  }
  if (item && paste && canPaste) {
    add({
      id: "paste",
      title: block ? "Paste after the block" : "Paste a block",
      group: "The chosen block",
      words: "clipboard copied",
      keys: from.keysOf("paste"),
      targets: ["block", "claim"],
      label: "Paste",
      section: "edit",
      run: paste,
    });
  }
  if (chosen !== undefined && block && from.duplicate) {
    const duplicate = from.duplicate;
    add({
      id: "duplicate",
      title: "Duplicate the block",
      group: "The chosen block",
      words: "copy again twin",
      keys: from.keysOf("duplicate"),
      targets: ["block"],
      label: "Duplicate",
      section: "edit",
      run: () => duplicate(chosen),
    });
  }
  if (chosen !== undefined && item) {
    add({
      id: "remove",
      title: block ? "Remove the block" : "Remove the claim",
      group: "The chosen block",
      words: "delete",
      targets: ["block", "claim"],
      label: "Delete",
      section: "edit",
      run: () => from.remove(chosen),
    });
  }
  if (chosen !== undefined && block) {
    add({
      id: "pin",
      title: block.frame ? "Put the block back in its layout" : "Pin the block where it is",
      group: "The chosen block",
      words: "unpin free move frame",
      keys: from.keysOf("pin"),
      targets: ["block"],
      label: block.frame ? "Put back in layout" : "Pin where it is",
      section: "place",
      run: () => from.togglePin(chosen),
    });
    const moveBlock = from.moveBlock;
    if (moveBlock) {
      const order = scene.blocks.map((candidate) => candidate.id);
      for (const direction of [-1, 1] as const) {
        if (afterWhenMoving(order, chosen, direction) === undefined) continue;
        const name = direction === -1 ? "earlier" : "later";
        add({
          id: `move-${name}`,
          title: `Move the block ${name}`,
          group: "The chosen block",
          words: "order reading arrow",
          targets: ["block"],
          label: `Move ${name}`,
          section: "place",
          run: () => moveBlock(chosen, direction),
        });
      }
    }
  }
  // How the chosen text looks: its size, alignment and color, each a submenu of the right-click menu.
  const setStyle = from.setTextStyle;
  if (block?.type === "text" && setStyle) {
    const looks = (
      key: "size" | "align" | "tone",
      name: string,
      labels: Record<string, string>,
      current: string | undefined,
      plain?: string,
    ) => {
      const options = Object.entries(labels).filter(([value]) => value !== (current ?? plain));
      // A color has no value that means none, so there is a choice that takes it off.
      if (plain === undefined && current !== undefined) options.push(["", "Default"]);
      for (const [value, label] of options) {
        add({
          id: `${key}-${value === "" ? "default" : value}`,
          title: `${name}: ${label}`,
          group: "The chosen block",
          words: `text look ${key === "size" ? "bigger smaller font" : key === "align" ? "left center right" : "tone"}`,
          targets: ["block"],
          label,
          section: "look",
          submenu: name,
          run: () => setStyle(block.id, key, value === plain ? "" : value),
        });
      }
    };
    looks("size", "Size", SIZE_LABEL, block.size, "m");
    looks("align", "Align", ALIGN_LABEL, block.align, "start");
    looks("tone", "Color", TONE_LABEL, block.tone);
  }
  // The deck's styles for the chosen block's kind, the brand's and Depthcue's own, with the one it has checked. Until
  // they are in, the submenu is there and says why it holds nothing yet.
  const setBlockStyle = from.setBlockStyle;
  const coming = block && setBlockStyle ? from.stylesComing?.() : undefined;
  if (block && setBlockStyle && coming !== undefined) {
    add({
      id: "block-style-coming",
      title: "Style",
      group: "The chosen block",
      words: "brand look component callout",
      targets: ["block"],
      label: "Styles",
      section: "look",
      submenu: "Style",
      disabled: coming,
      run: () => undefined,
    });
  } else if (block && setBlockStyle) {
    const kind = kindOf(block);
    const styles = Object.entries(blockStylesOf(session.doc)).filter(([, style]) =>
      (style.for as readonly string[]).includes(kind),
    );
    const choices: Array<[string, string]> =
      styles.length > 0
        ? [["", "No style"], ...styles.map(([id, style]): [string, string] => [id, style.name])]
        : [];
    for (const [id, name] of choices) {
      add({
        id: `block-style-${id || "none"}`,
        title: `Style: ${name}`,
        group: "The chosen block",
        words: "brand look component callout",
        targets: ["block"],
        label: name,
        section: "look",
        submenu: "Style",
        checked: (block.style ?? "") === id,
        icon: () => from.stylePreview?.(id),
        run: () => setBlockStyle(block.id, id),
      });
    }
  }
  if (chosen !== undefined && item) {
    add({
      id: "comment",
      title: block ? "Comment on the block" : "Comment on the claim",
      group: "The chosen block",
      words: "note feedback ask agent review",
      targets: ["block", "claim"],
      label: "Comment",
      section: "review",
      run: () => from.comment(chosen),
    });
  }

  // The cell of the chosen table. Its menu holds these alone; the palette lists them for the cell the keyboard is on.
  if (block?.type === "table" && from.editCell) {
    const at = from.cell?.();
    const editCell = from.editCell;
    if (at) for (const command of cellCommands(block, at, (action) => editCell(action, at))) add(command);
  }

  for (const choice of LAYOUT_CHOICES) {
    if (choice.value === scene.layout) continue;
    add({
      id: `layout-${choice.value}`,
      title: `Layout: ${choice.label}`,
      group: "This scene",
      words: "template arrangement",
      targets: ["slide"],
      label: choice.label,
      section: "scene",
      submenu: "Layout",
      run: () => from.setLayout(choice.value),
    });
  }
  const changeTemplate = from.changeTemplate;
  if (changeTemplate) {
    add({
      id: "change-template",
      title: "Change this scene's template or layout",
      group: "This scene",
      words: "template layout brand slots retemplate",
      targets: ["slide", "scene"],
      label: "Change template…",
      section: "scene",
      run: changeTemplate,
    });
  }
  const pickTemplate = from.pickTemplate;
  if (pickTemplate) {
    add({
      id: "pick-template",
      title: "Add a scene from a template",
      group: "Add",
      words: "new slide brand layout picker",
      targets: ["scene"],
      label: "Add scene from a template…",
      section: "scene-edit",
      run: pickTemplate,
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
      targets: ["slide"],
      label: LEAD_LABEL[value],
      section: "scene",
      submenu: "Lead",
      run: () => from.setLead(value),
    });
  }
  if (scene.blocks.some((candidate) => candidate.frame)) {
    add({
      id: "auto-layout",
      title: "Put every pinned block back in its layout",
      group: "This scene",
      words: "auto unpin reset frames",
      targets: ["slide"],
      label: "Put every pinned block back",
      section: "scene",
      run: () => from.autoLayout(),
    });
  }
  add({
    id: "comments-toggle",
    title: from.commentsShown() ? "Hide the comments" : "Show the comments",
    group: "This scene",
    words: "notes pins feedback review",
    targets: ["slide"],
    section: "view",
    run: () => from.showComments(!from.commentsShown()),
  });
  const deckStyle = from.deckStyle;
  if (deckStyle) {
    add({
      id: "deck-style",
      title: "Open the deck style: preset, colors and fonts",
      group: "Deck",
      words: "theme palette color swatch font typeface paper ink appearance look",
      targets: ["slide"],
      label: "Deck style",
      section: "view",
      run: deckStyle,
    });
  }
  // The scene in the strip. Right-clicking a scene chooses it, so these act on the scene on show, like the rest.
  const order = session.doc.deck.scenes;
  const at = order.indexOf(sceneId);
  const { duplicateScene, removeScene, moveScene } = from;
  if (duplicateScene) {
    add({
      id: "duplicate-scene",
      title: "Duplicate this scene",
      group: "This scene",
      words: "copy again twin",
      targets: ["scene"],
      label: "Duplicate",
      section: "scene-edit",
      run: () => duplicateScene(sceneId),
    });
  }
  const upgradeScene = from.upgradeScene;
  if (upgradeScene && !readsMarkup(scene)) {
    add({
      id: "use-text-styles",
      title: "Use text styles in this scene",
      group: "This scene",
      words: "upgrade markup bold italic list link color size align schema 0.3",
      targets: ["scene"],
      label: "Use text styles",
      section: "scene-style",
      run: () => upgradeScene(sceneId),
    });
  }
  if (removeScene && order.length > 1) {
    add({
      id: "remove-scene",
      title: "Delete this scene",
      group: "This scene",
      words: "remove",
      targets: ["scene"],
      label: "Delete",
      section: "scene-edit",
      run: () => removeScene(sceneId),
    });
  }
  if (moveScene) {
    for (const direction of [-1, 1] as const) {
      if (order[at + direction] === undefined) continue;
      const name = direction === -1 ? "earlier" : "later";
      add({
        id: `move-scene-${name}`,
        title: `Move this scene ${name}`,
        group: "This scene",
        words: "order strip arrow",
        targets: ["scene"],
        label: `Move ${name}`,
        section: "scene-move",
        run: () => moveScene(sceneId, direction),
      });
    }
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

  if (from.canUndo?.() ?? session.canUndo)
    add({ id: "undo", title: "Undo", group: "Everywhere", keys: from.keysOf("undo"), run: from.undo });
  if (from.canRedo?.() ?? session.canRedo)
    add({ id: "redo", title: "Redo", group: "Everywhere", keys: from.keysOf("redo"), run: from.redo });
  const toggleReview = from.toggleReview;
  if (toggleReview) {
    add({
      id: "review",
      title: from.reviewOpen?.() ? "Close the changes" : "Review the changes since the last review",
      group: "Everywhere",
      words: "agent accept revert diff drawer",
      run: toggleReview,
    });
  }
  const storyboard = from.storyboard;
  if (storyboard) {
    add({
      id: "storyboard",
      title: "Open the storyboard",
      group: "Everywhere",
      words: "grid overview sorter all scenes",
      keys: from.keysOf("storyboard"),
      run: storyboard,
    });
  }
  add({ id: "save", title: "Save now", group: "Everywhere", keys: from.keysOf("save"), run: from.save });
  add({
    id: "present",
    title: "Present from this scene",
    group: "Everywhere",
    words: "show slideshow play",
    targets: ["scene"],
    label: "Present from here",
    section: "present",
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
