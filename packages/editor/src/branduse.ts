/**
 * Using a deck's brand in the editor: the template picker that adds a scene, Change template with its preview, the hints
 * in a template's empty slots, and the Style menu of a block. It is a part of its own (see lazy.ts), fetched the first
 * time one of them is wanted. A deck with no brand gets Depthcue's own templates and styles here, drawn in its own colors
 * and fonts. Everything it changes goes through the operations `depthcue apply` takes, so the files come out the same.
 */
import {
  type ApplyFailure,
  applyOps,
  type Block,
  type BlockKind,
  type BlockStyle,
  blockStylesOf,
  claimSlot,
  type DeckLook,
  type Doc,
  type Frame,
  kindOf,
  LAYOUTS,
  type NewScene,
  type Op,
  retemplate,
  revisionOf,
  type Scene,
  type Session,
  slotsOf,
  type Template,
  type TemplateSlot,
  templatesOf,
} from "@depthcue/core";
import { h } from "@depthcue/player";
import { removeClaim } from "./cleanup.ts";
import { fileButton, problemOf } from "./fields.ts";
import { describeBlock, IMAGE_ACCEPT, LAYOUT_LABEL, type Layout, newScene, uniqueId } from "./templates.ts";
import { lookFor, thumbnailFrame } from "./thumbnail.ts";

/** What a scene is drawn by: a template of the deck's, or one of the three layouts. */
export type Choice = { template: string } | { layout: Layout };

export interface Option {
  to: Choice;
  name: string;
  about: string;
  /** The brand's name for its own templates, "Built in" for Depthcue's, "Layouts" for the layouts. */
  group: string;
}

const LAYOUT_ABOUT: Record<Layout, string> = {
  title: "Blocks one under another, for a title or a single point.",
  "claim-evidence": "A claim at the top, the evidence that backs it, and support beside it.",
  "text-media": "Text on one side, and a picture, chart, table or clip on the other.",
};

/** What each kind of block is called in a slot's menu. A `Record` over the core's kinds, so a new one needs a name. */
export const KIND_LABEL: Record<BlockKind, string> = {
  heading: "Heading",
  body: "Text",
  caption: "Caption",
  quote: "Quote",
  image: "Image",
  table: "Table",
  chart: "Chart",
  clip: "Clip",
  contents: "Contents",
};

const TEXT_KINDS = ["heading", "body", "caption", "quote"] as const;
const SAMPLE: Record<(typeof TEXT_KINDS)[number], string> = {
  heading: "New scene",
  body: "Say something short.",
  caption: "A short label",
  quote: "A line worth repeating.",
};

const NO_VIDEO = "Put an .mp4 or .webm file in the deck's assets folder first.";

/** Where a block that no slot takes is pinned when it is not on the slide to measure. */
const FALLBACK: Frame = { x: 8, y: 8, w: 40, h: 20 };

export const keyOf = (to: Choice): string =>
  "template" in to ? `template:${to.template}` : `layout:${to.layout}`;

/** The template a scene names, when the deck has it. */
export function templateOf(doc: Doc, id: string | undefined): Template | undefined {
  const all = templatesOf(doc);
  return id !== undefined && Object.hasOwn(all, id) ? all[id] : undefined;
}

/**
 * The templates and layouts a scene can have, in the order the picker shows them: the brand's templates, then
 * Depthcue's own (none when the brand hides them, and one the brand replaces shows once, as the brand's), then the three
 * layouts.
 */
export function optionsOf(doc: Doc): Option[] {
  const all = templatesOf(doc);
  const mine = doc.templates ?? {};
  const listed = (id: string, group: string): Option => {
    const template = all[id] as Template;
    return { to: { template: id }, name: template.name, about: template.description, group };
  };
  return [
    ...Object.keys(mine).map((id) => listed(id, doc.brand?.name ?? "Brand")),
    ...Object.keys(all)
      .filter((id) => !Object.hasOwn(mine, id))
      .map((id) => listed(id, "Built in")),
    ...LAYOUTS.map((layout) => ({
      to: { layout },
      name: LAYOUT_LABEL[layout],
      about: LAYOUT_ABOUT[layout],
      group: "Layouts",
    })),
  ];
}

/** The deck's look with every template and style it may use, so one it does not use yet is drawn in it too. */
export const lookWithAll = (doc: Doc): DeckLook => ({
  ...lookFor(doc),
  templates: { ...templatesOf(doc) },
  styles: { ...blockStylesOf(doc) },
});

/**
 * A new scene drawn by a template. A scene holds at least one block, so it starts with one text: in the first slot that
 * takes a heading, else the first that takes text. Every other slot starts empty and shows its hint in the editor.
 */
export function templateScene(doc: Doc, templateId: string): NewScene {
  const template = templateOf(doc, templateId) as Template;
  const id = uniqueId("new-scene", new Set(doc.deck.scenes));
  const takes = (kind: BlockKind) => template.slots.find((slot) => slot.accepts?.includes(kind));
  const kind = TEXT_KINDS.find(takes) ?? "body";
  const slot = takes(kind);
  const block: Block = {
    id: `${id}-${kind}`,
    type: "text",
    role: kind,
    text: SAMPLE[kind],
    // A template with no slot for text still gets its block: pinned over the slots, to move or replace.
    ...(slot ? { slot: slot.id } : { frame: { x: 8, y: 8, w: 84, h: 16 } }),
  };
  return { id, title: "New scene", template: templateId, blocks: [block] };
}

/** The scene the picker adds for a choice. */
export const sceneFor = (doc: Doc, to: Choice): NewScene =>
  "template" in to ? templateScene(doc, to.template) : newScene(doc, to.layout);

// Empty slots

export interface SlotHooks {
  /** Adds a block of `kind` to the slot. An image comes with its file. */
  add(slot: string, kind: BlockKind, file?: File): void;
  /** Gives the scene a claim, for its claim slot. */
  claim(): void;
  /** Whether the deck has a video a clip could play. */
  hasVideo(): boolean;
}

let uid = 0;

/**
 * Each empty slot of a template scene, as a box at the slot's frame with the slot's hint and, for a required one, a mark.
 * With `hooks` a click adds what the slot takes: at once when it takes one kind, from a short menu when it takes more.
 * Only the editor draws these, into its own copy of the slide: the player, the exported page, the thumbnails of the
 * strip and the PowerPoint file never do, and the hints come from the templates, which the page's look leaves out.
 * They lie under every block and pin (editor.css), so a block over an empty slot, such as a pinned chart or a title
 * inside a slide-sized picture slot, still takes its own clicks.
 */
export function drawSlots(doc: Doc, scene: Scene, view: ParentNode, hooks?: SlotHooks): void {
  const template = templateOf(doc, scene.template);
  const root = view.querySelector(".dc-scene");
  if (!template || !root) return;
  for (const slot of template.slots) if (!filled(scene, slot)) root.append(emptySlot(slot, hooks));
}

/** Whether a slot of the scene's template has something in it: the claim for the claim slot, else a block. */
const filled = (scene: Scene, slot: TemplateSlot): boolean =>
  slot.role === "claim" ? scene.summary !== undefined : scene.blocks.some((block) => block.slot === slot.id);

function emptySlot(slot: TemplateSlot, hooks: SlotHooks | undefined): HTMLElement {
  const { x, y, w, h: tall } = slot.frame;
  const box = h("div", {
    class: "ed-slot",
    "data-slot": slot.id,
    "data-required": slot.required === true,
    "--x": x,
    "--y": y,
    "--w": w,
    "--h": tall,
  });
  const claim = slot.role === "claim";
  const kinds = slot.accepts ?? [];
  const hint =
    slot.hint ??
    (claim
      ? "The scene's claim."
      : `Takes ${kinds.map((kind) => KIND_LABEL[kind].toLowerCase()).join(", ")}.`);
  const hintId = `ed-slot-hint-${++uid}`;
  const parts = [
    h("span", { class: "ed-slot-hint", id: hintId }, hint),
    slot.required && h("span", { class: "ed-slot-required" }, "Required"),
  ];
  if (!hooks) {
    box.append(...parts.filter((part) => part !== false && part !== undefined));
    return box;
  }
  const only = kinds.length === 1 ? kinds[0] : undefined;
  const label = claim ? "Add the claim" : only ? `Add ${KIND_LABEL[only].toLowerCase()}` : "Add";
  const open = h(
    "button",
    {
      type: "button",
      class: "ed-slot-add",
      "aria-label": `${label} to the ${slot.id} slot${slot.required ? ", required" : ""}`,
      "aria-describedby": hintId,
    },
    ...parts,
    h("span", { class: "ed-slot-do", "aria-hidden": "true" }, `+ ${label}`),
  );
  box.append(open);
  if (claim) {
    open.addEventListener("click", () => hooks.claim());
    return box;
  }
  if (only !== undefined && only !== "image") {
    if (only === "clip" && !hooks.hasVideo()) {
      open.disabled = true;
      open.title = NO_VIDEO;
    }
    open.addEventListener("click", () => hooks.add(slot.id, only));
    return box;
  }
  // More than one kind, or a picture, which needs its file chosen: a menu of what the slot takes.
  const menu = h("div", {
    class: "ed-slot-menu",
    role: "group",
    "aria-label": `${label}: what kind`,
    hidden: true,
  });
  menu.append(
    ...kinds.map((kind) => {
      if (kind === "image")
        return fileButton("Image", IMAGE_ACCEPT, `slot:${slot.id}:image`, (file) =>
          hooks.add(slot.id, "image", file),
        );
      const video = kind !== "clip" || hooks.hasVideo();
      const choice = h(
        "button",
        {
          type: "button",
          "data-slot-kind": kind,
          disabled: !video,
          title: video ? undefined : NO_VIDEO,
        },
        KIND_LABEL[kind],
      );
      choice.addEventListener("click", () => hooks.add(slot.id, kind));
      return choice;
    }),
  );
  box.append(menu);
  const toggle = (show: boolean) => {
    menu.hidden = !show;
    open.setAttribute("aria-expanded", String(show));
  };
  toggle(false);
  open.addEventListener("click", () => toggle(menu.hidden === true));
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.hidden) return;
    event.stopPropagation();
    toggle(false);
    open.focus();
  });
  box.addEventListener("focusout", (event) => {
    if (!box.contains(event.relatedTarget as Node | null)) toggle(false);
  });
  return box;
}

// Pictures

/** A slide as a small picture: the real player's drawing of it, with its empty slots and their hints. */
export function picture(doc: Doc, scene: Scene, look: DeckLook, className: string): HTMLElement {
  const frame = thumbnailFrame(scene, look);
  drawSlots(doc, scene, frame);
  return h("span", { class: `ed-mini ${className}`, "aria-hidden": "true" }, frame);
}

export const asScene = (scene: NewScene): Scene => ({ schemaVersion: "0.4", ...scene }) as Scene;

// Dialogs

export interface Modal {
  element: HTMLDialogElement;
  body: HTMLElement;
  foot: HTMLElement;
  /** Says why what was chosen was refused, in the dialog, where the person is looking. */
  refused(problem: string | undefined): void;
  close(): void;
}

/** Where the keyboard goes when a dialog closes, kept with the dialog so one that replaces it can take it over. */
const backs = new WeakMap<Element, HTMLElement | undefined>();

/**
 * A modal dialog over the editor. Esc and Cancel close it, and the keyboard goes back to where it was. While it is open
 * the editor's own keys stay off, so a key pressed in it does only what the dialog says. One opened over another of the
 * same name replaces it and gives the keyboard back to where that one would have.
 */
export function modal(root: HTMLElement, title: string, name: string): Modal {
  const replaced = root.querySelector(`dialog[data-dialog="${name}"]`);
  const back = replaced
    ? backs.get(replaced)
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  replaced?.remove();
  const titleId = `ed-dialog-${++uid}`;
  const body = h("div", { class: "ed-dialog-body" });
  const cancel = h("button", { type: "button", "data-dialog-action": "cancel" }, "Cancel");
  const problem = h("p", { class: "ed-problem", role: "alert" });
  const foot = h("div", { class: "ed-dialog-foot" }, problem, cancel);
  const element = h(
    "dialog",
    { class: `ed-dialog ed-dialog-${name}`, "data-dialog": name, "aria-labelledby": titleId },
    h("h2", { class: "ed-dialog-title", id: titleId }, title),
    body,
    foot,
  );
  backs.set(element, back);
  const close = () => {
    if (!element.isConnected) return;
    if (element.open && typeof element.close === "function") element.close();
    element.remove();
    back?.focus({ preventScroll: true });
  };
  cancel.addEventListener("click", close);
  element.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  element.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  root.append(element);
  if (typeof element.showModal === "function") element.showModal();
  else element.setAttribute("open", "");
  const refused = (text: string | undefined) => {
    problem.textContent = text ?? "";
  };
  return { element, body, foot, refused, close };
}

/** Arrow keys move between the buttons of a grid, as Tab does, so a long list is quick to go through. */
export function arrows(holder: HTMLElement, buttons: readonly HTMLElement[]): void {
  holder.addEventListener("keydown", (event) => {
    const at = buttons.indexOf(event.target as HTMLElement);
    if (at < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const to = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : step && at + step;
    const next = to === undefined ? undefined : buttons[to];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
}

const grouped = (options: readonly Option[]): Map<string, Option[]> => {
  const groups = new Map<string, Option[]>();
  for (const option of options) groups.set(option.group, [...(groups.get(option.group) ?? []), option]);
  return groups;
};

// The template picker

export interface PickHooks {
  /** Adds the scene after the one on show and goes to it. Answers why it was refused, or undefined when it was added. */
  add(scene: NewScene): string | undefined;
}

/**
 * The template picker: every template the deck can use and the three layouts, each as a picture of the slide it makes,
 * drawn by the player in the deck's look with its slots and their hints. A choice adds the scene with `scene.add`, the
 * operation `depthcue apply` takes, after the scene on show.
 */
export function pickTemplate(session: Session, root: HTMLElement, hooks: PickHooks): void {
  const doc = session.doc;
  const look = lookWithAll(doc);
  const { body, refused, close } = modal(root, "Add a scene", "picker");
  const buttons: HTMLButtonElement[] = [];
  for (const [group, options] of grouped(optionsOf(doc))) {
    const list = h("ul", { class: "ed-pick-list" });
    for (const option of options) {
      // Named by its name and described by what it is for, so a screen reader says each once.
      const id = `ed-pick-${++uid}`;
      const button = h(
        "button",
        {
          type: "button",
          class: "ed-pick",
          "data-pick": keyOf(option.to),
          "aria-labelledby": `${id}-name`,
          "aria-describedby": `${id}-about`,
        },
        picture(doc, asScene(sceneFor(doc, option.to)), look, "ed-pick-thumb"),
        h("span", { class: "ed-pick-name", id: `${id}-name` }, option.name),
        h("span", { class: "ed-pick-about", id: `${id}-about` }, option.about),
      );
      button.addEventListener("click", () => {
        const problem = hooks.add(sceneFor(session.doc, option.to));
        if (problem === undefined) close();
        else refused(problem);
      });
      buttons.push(button);
      list.append(h("li", {}, button));
    }
    body.append(h("section", { "aria-label": group }, h("h3", { class: "ed-pick-group" }, group), list));
  }
  arrows(body, buttons);
  buttons[0]?.focus();
}

// Change template

export interface Plan {
  /** The operations that make the change, to apply as one step of Undo. */
  ops: Op[];
  /** Where each block will be, in words: "Heading: Why → title slot". */
  placed: string[];
  /** Each block that fits no slot, by name, and what happens to it. Never one dropped without a word. */
  unplaced: string[];
  /** The new template's required slots that nothing fills: "right (required)". */
  empty: string[];
  /** The scene as it will be, when the change can be made. */
  after?: { doc: Doc; scene: Scene };
  /** Why the change cannot be made, when it cannot. */
  problem?: string;
}

/** Why core refused a change, with the block it is about named first when it is about one, such as a contrast. */
function refusal(failure: ApplyFailure, scene: Scene): string {
  const at = /^\/blocks\/(\d+)/.exec(failure.diagnostics[0]?.path ?? "");
  const block = at ? scene.blocks[Number(at[1])] : undefined;
  return block ? `${describeBlock(block, 40, scene)}: ${problemOf(failure)}` : problemOf(failure);
}

/**
 * What moving a scene to a template or a layout does, from core's `retemplate`, before anything changes. A block no slot
 * takes is kept, pinned where it is on the slide now. The claim goes as core moves it: it stays the scene's claim, with
 * its links to its evidence, and never becomes a block. A layout that does not draw it leaves it in the scene, unseen; a
 * template with no claim slot takes the scene only without it, so it is removed, as core's own refusal suggests, and the
 * plan names it, the links that go with it, and the templates that would keep it. Required slots left empty are named.
 */
export function planOf(
  doc: Doc,
  sceneId: string,
  to: Choice,
  measure: (id: string) => Frame | undefined,
): Plan {
  const scene = doc.scenes[sceneId] as Scene;
  const moved = retemplate(doc, sceneId, to);
  const ops = [...moved.ops];
  const unplaced: string[] = [];
  for (const id of moved.unplaced) {
    const block = scene.blocks.find((candidate) => candidate.id === id);
    if (!block) {
      const claim = scene.summary as NonNullable<Scene["summary"]>;
      if ("layout" in to) {
        unplaced.push(
          `The claim "${claim.text}" stays in the scene, but ${LAYOUT_LABEL[to.layout]} does not show a claim.`,
        );
        continue;
      }
      // As the editor takes a claim off anywhere: out of the build order too.
      const off = removeClaim(scene);
      ops.push(...off);
      const stepped = off.some((op) => op.op === "scene.set" && "steps" in op.set);
      const links = claim.evidenceIds.flatMap((ref) => {
        const cited = scene.blocks.find((candidate) => candidate.id === ref);
        return cited ? [describeBlock(cited, 40, scene)] : [];
      });
      const keep = Object.values(templatesOf(doc))
        .filter((template) => claimSlot(template))
        .map((template) => template.name);
      unplaced.push(
        `The claim "${claim.text}" has no slot in this template, so it is removed${
          links.length > 0 ? `, and its links to ${links.join(", ")} are removed with it` : ""
        }.${stepped ? " It leaves the build order too." : ""} To keep it, choose ${keep.length > 0 ? `${keep.join(", ")} or ` : ""}the layout ${LAYOUT_LABEL["claim-evidence"]}.`,
      );
      continue;
    }
    if (block.slot !== undefined) ops.push({ op: "block.set", scene: sceneId, id, set: { slot: null } });
    ops.push({ op: "block.frame", scene: sceneId, id, frame: measure(id) ?? FALLBACK });
    unplaced.push(
      `${describeBlock(block, 40, scene)}. No slot here takes a ${KIND_LABEL[kindOf(block)].toLowerCase()}, so it stays on the slide, pinned where it is now, to move or delete.`,
    );
  }
  const result = applyOps(doc, ops, revisionOf(doc));
  if (!result.ok) return { ops, placed: [], unplaced, empty: [], problem: refusal(result, scene) };
  const after = result.doc.scenes[sceneId] as Scene;
  const areas = "layout" in to ? slotsOf(after) : [];
  // A block no slot takes is said once, under "Fits no slot", with what happens to it.
  const unfit = new Set(moved.unplaced);
  const placed = after.blocks
    .filter((block) => !unfit.has(block.id))
    .map((block) => {
      const where =
        block.slot !== undefined
          ? `${block.slot} slot`
          : block.frame !== undefined
            ? "pinned over the slide"
            : (areas.find((area) => area.blocks.includes(block.id))?.label ?? "slide");
      return `${describeBlock(block, 40, after)} → ${where.toLowerCase()}`;
    });
  const empty = (templateOf(result.doc, after.template)?.slots ?? [])
    .filter((slot) => slot.required && !filled(after, slot))
    .map((slot) => `${slot.id} (required)`);
  return { ops, placed, unplaced, empty, after: { doc: result.doc, scene: after } };
}

export interface ChangeHooks {
  /** Applies the change as one step of Undo. Answers why it was refused, or undefined when it was made. */
  act(ops: readonly Op[]): string | undefined;
  /** Where a block is on the slide now, in percent of it, for one no slot takes and that stays pinned there. */
  measure(id: string): Frame | undefined;
}

/**
 * Change template: the deck's templates and the layouts to choose from, and for the one chosen a picture of the scene as
 * it will be, where each block goes, and every block no slot takes, by name, with what happens to it. Apply makes the
 * change as one step of Undo, with the operations `depthcue apply` takes.
 */
export function changeTemplate(
  session: Session,
  root: HTMLElement,
  sceneId: string,
  hooks: ChangeHooks,
  first?: Choice,
): void {
  const doc = session.doc;
  const scene = doc.scenes[sceneId];
  if (!scene) return;
  const current = keyOf(
    scene.template !== undefined ? { template: scene.template } : { layout: scene.layout ?? "title" },
  );
  const { body, foot, refused, close } = modal(root, `Change the template of "${scene.title}"`, "retemplate");
  const options = optionsOf(doc);
  const name = `ed-retemplate-${++uid}`;
  const look = lookWithAll(doc);
  const preview = h("div", { class: "ed-retemplate-preview", "aria-live": "polite" });
  const apply = h("button", { type: "button", class: "ed-primary", "data-dialog-action": "apply" }, "Apply");
  foot.prepend(apply);
  let plan: Plan | undefined;

  const list = h(
    "fieldset",
    { class: "ed-retemplate-list" },
    h("legend", { class: "ed-label" }, "Template or layout"),
  );
  for (const [group, entries] of grouped(options)) {
    list.append(h("p", { class: "ed-pick-group" }, group));
    for (const option of entries) {
      const key = keyOf(option.to);
      const radio = h("input", { type: "radio", name, value: key, "data-choice": key });
      radio.addEventListener("change", () => show(option));
      list.append(
        h(
          "label",
          { class: "ed-retemplate-choice", "data-current": key === current },
          radio,
          h("span", {}, option.name),
          key === current && h("span", { class: "ed-hint-text" }, "Now"),
        ),
      );
    }
  }

  function show(option: Option) {
    const same = keyOf(option.to) === current;
    plan = same ? undefined : planOf(session.doc, sceneId, option.to, hooks.measure);
    const rows = (items: readonly string[], kind: string) =>
      h("ul", { class: `ed-retemplate-${kind}` }, ...items.map((item) => h("li", {}, item)));
    const unplaced = plan?.unplaced ?? [];
    const shown = same
      ? [h("p", {}, "The scene already has this one.")]
      : plan?.problem
        ? [h("p", { class: "ed-problem", role: "alert" }, plan.problem)]
        : [
            plan?.after && picture(plan.after.doc, plan.after.scene, look, "ed-retemplate-thumb"),
            (plan?.placed.length ?? 0) > 0 && h("h3", { class: "ed-label" }, "Where each block goes"),
            (plan?.placed.length ?? 0) > 0 && rows(plan?.placed ?? [], "placed"),
            unplaced.length > 0 && h("h3", { class: "ed-label" }, "Fits no slot"),
            unplaced.length > 0 && rows(unplaced, "unplaced"),
            (plan?.empty.length ?? 0) > 0 &&
              h("p", { class: "ed-retemplate-empty" }, `Left empty: ${plan?.empty.join(", ")}`),
          ];
    preview.replaceChildren(...shown.filter((node): node is HTMLElement => node instanceof HTMLElement));
    apply.disabled = same || plan?.problem !== undefined;
  }

  apply.addEventListener("click", () => {
    if (!plan || plan.problem) return;
    const problem = hooks.act(plan.ops);
    if (problem === undefined) close();
    else refused(problem);
  });
  body.append(h("div", { class: "ed-retemplate" }, list, preview));
  const start = first ? keyOf(first) : undefined;
  const pick =
    options.find((option) => keyOf(option.to) === start) ??
    options.find((option) => keyOf(option.to) !== current) ??
    options[0];
  const radio = list.querySelector<HTMLInputElement>(`input[value="${pick ? keyOf(pick.to) : ""}"]`);
  if (pick && radio) {
    radio.checked = true;
    show(pick);
    radio.focus();
  }
}

// Styles

/** The styles a block of `kind` can take, by id: the brand's and Depthcue's own, one the brand replaces listed once. */
export const stylesFor = (doc: Doc, kind: BlockKind): Array<[string, BlockStyle]> =>
  Object.entries(blockStylesOf(doc)).filter(([, style]) => (style.for as readonly string[]).includes(kind));

/**
 * The operations that give each of `ids` a style, or with "" take theirs off, and the blocks the style is not for, by
 * name, which keep what they have.
 */
export function styleOps(
  doc: Doc,
  sceneId: string,
  ids: readonly string[],
  styleId: string,
): { ops: Op[]; refused: string[] } {
  const scene = doc.scenes[sceneId];
  const all = blockStylesOf(doc);
  const style = styleId !== "" && Object.hasOwn(all, styleId) ? all[styleId] : undefined;
  const ops: Op[] = [];
  const refused: string[] = [];
  for (const id of ids) {
    const block = scene?.blocks.find((candidate) => candidate.id === id);
    if (!scene || !block) continue;
    if (styleId !== "" && !(style?.for as readonly string[] | undefined)?.includes(kindOf(block))) {
      refused.push(describeBlock(block, 40, scene));
      continue;
    }
    if ((block.style ?? "") !== styleId)
      ops.push({ op: "block.set", scene: sceneId, id, set: { style: styleId === "" ? null : styleId } });
  }
  return { ops, refused };
}

/**
 * A style as a small picture: a sample block in the style, drawn by the player in the deck's look but with no chrome,
 * on a slide the size of the picture. It is drawn at its true size, not a whole slide scaled down: editor.css sets the
 * sample at 13 CSS px times the style's own size, never under 12, with the slide's color a little way round it, so the
 * fill, edge, border, face and tone of Callout, Card or Pull quote can be told apart. The block is not pinned and has no
 * size of its own, so the style's size shows, and the layout is the plainest one, where text is in the deck's own color.
 * With "" it is the block with no style, for No style.
 */
export function stylePreview(doc: Doc, styleId: string, kind: BlockKind = "body"): HTMLElement {
  const role = (TEXT_KINDS as readonly string[]).includes(kind)
    ? (kind as (typeof TEXT_KINDS)[number])
    : "body";
  const scene: Scene = {
    schemaVersion: "0.4",
    id: "style-preview",
    title: "Style",
    layout: "text-media",
    blocks: [{ id: "sample", type: "text", role, text: "Aa", ...(styleId === "" ? {} : { style: styleId }) }],
  };
  const { chrome: _chrome, ...look } = lookWithAll(doc);
  return h("span", { class: "ed-mini ed-style-thumb", "aria-hidden": "true" }, thumbnailFrame(scene, look));
}

export interface StyleSection {
  readonly body: HTMLElement;
  /**
   * Brings the list up to date with the deck: the one the block has is checked in place, so the keyboard stays on its
   * choice. The pictures are drawn again only when the kind, the styles or the deck's look changed, and never while
   * `typing`, when none of them can.
   */
  fill(typing?: boolean): void;
}

/**
 * The Style menu of a block: No style and each style for its kind, each with its picture, the one the block has checked.
 * A choice writes `block.set` with `style`, as `depthcue apply` would. Given several blocks, it styles every one the
 * style is for and names the others.
 */
export function styleSection(
  session: Session,
  sceneId: string,
  ids: () => readonly string[],
  run: (ops: readonly Op[]) => boolean,
): StyleSection {
  const body = h("fieldset", { class: "ed-styles", "data-styles": "" });
  const name = `ed-style-${++uid}`;
  const said = h("p", { class: "ed-hint-text", role: "status" });
  const blocks = () => {
    const scene = session.doc.scenes[sceneId];
    return ids().flatMap((id) => scene?.blocks.find((block) => block.id === id) ?? []);
  };
  /** What the list was drawn from, and its radios, to check in place while that stays the same. */
  let drawnFrom: string | undefined;
  let radios: Array<[HTMLInputElement, string]> = [];
  function fill(typing = false) {
    const chosen = blocks();
    const first = chosen[0];
    if (!first) {
      body.replaceChildren();
      drawnFrom = undefined;
      return;
    }
    const kind = kindOf(first);
    const current = new Set(chosen.map((block) => block.style ?? ""));
    const check = () => {
      for (const [radio, id] of radios) radio.checked = current.size === 1 && current.has(id);
    };
    const own = stylesFor(session.doc, kind);
    const none = own.length === 0 && current.has("");
    const from =
      typing && drawnFrom !== undefined
        ? drawnFrom
        : JSON.stringify([kind, none, own, lookWithAll(session.doc)]);
    if (from === drawnFrom) {
      check();
      return;
    }
    drawnFrom = from;
    radios = [];
    if (none) {
      body.replaceChildren(
        h("legend", { class: "ed-label" }, "Styles"),
        h("p", { class: "ed-hint-text" }, `No style is made for a ${KIND_LABEL[kind].toLowerCase()}.`),
      );
      return;
    }
    const choices: Array<[string, string]> = [
      ["", "No style"],
      ...own.map(([id, style]): [string, string] => [id, style.name]),
    ];
    body.replaceChildren(
      h("legend", { class: "ed-label" }, "Styles"),
      ...choices.map(([id, label]) => {
        const radio = h("input", { type: "radio", name, value: id, "data-style": id || "none" });
        radios.push([radio, id]);
        radio.addEventListener("change", () => {
          const { ops, refused } = styleOps(session.doc, sceneId, ids(), id);
          said.textContent =
            refused.length > 0 ? `Not styled, as ${label} is not for them: ${refused.join("; ")}.` : "";
          if (ops.length > 0) run(ops);
        });
        return h(
          "label",
          { class: "ed-style-choice" },
          radio,
          stylePreview(session.doc, id, kind),
          h("span", {}, label),
        );
      }),
      said,
    );
    check();
  }
  fill();
  return { body, fill };
}
