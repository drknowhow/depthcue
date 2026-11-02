/**
 * Edit template: a mode of the stage for one of the brand's templates. Its slots are boxes over the slide, named, which
 * the person drags and resizes with the snapping and the guide lines a pinned block has; the arrow keys move the chosen
 * one, and Ctrl with them sizes it. A side panel edits the chosen slot and the template's background and chrome, and adds
 * and removes slots. Each change is one step of Undo. Under the slide, every scene on the template is drawn again after
 * each change, so the person sees what it does to them. Done, or Esc, goes back to the scene they came from.
 */
import {
  type ApplyOptions,
  type Frame,
  type Op,
  ROLE_KINDS,
  type Template,
  type TemplateSlot,
  type VALIGNS,
} from "@depthcue/core";
import { h } from "@depthcue/player";
import { type BrandHost, choices, hint } from "./brandbits.ts";
import { asScene, KIND_LABEL, lookWithAll, picture } from "./branduse.ts";
import {
  actionButton,
  checkField,
  type Edits,
  numberField,
  problemOf,
  selectField,
  textField,
} from "./fields.ts";
import {
  CORNERS,
  type Corner,
  fitted,
  type Guide,
  NUDGE,
  NUDGE_BIG,
  nudged,
  type Rect,
  resized,
  type Snapped,
  snapMove,
  snapResize,
  targetsOf,
} from "./pin.ts";
import { scenesOn, slotAdd, slotRemove, slotRename, slotSet, templateSet } from "./slotops.ts";
import { uniqueId } from "./templates.ts";
import { ROLE_LABEL, type SlotRole } from "./templatesave.ts";
import { thumbnailFrame } from "./thumbnail.ts";

type Background = NonNullable<Template["background"]>["color"];
type ChromeLevel = NonNullable<Template["chrome"]>;
type Accepts = NonNullable<TemplateSlot["accepts"]>;

const BACKGROUND: Record<Background, string> = {
  bg: "The slide's background",
  surface: "Panel",
  text: "Text color",
  action: "Accent",
  evidence: "Evidence",
};
const CHROME: Record<ChromeLevel, string> = {
  full: "All of the brand's chrome",
  minimal: "The logo only",
  none: "None",
};
type Valign = (typeof VALIGNS)[number];
const VALIGN: Record<Valign, string> = { top: "Top", middle: "Middle", bottom: "Bottom" };

/** A press moves nothing until the pointer has gone this far, in pixels, so a click stays a click. */
const DRAG_THRESHOLD = 3;

interface Gesture {
  slot: string;
  corner: Corner | undefined;
  start: Frame;
  frame: Frame;
  x: number;
  y: number;
  slide: Rect;
  others: Frame[];
  live: boolean;
}

const sameFrame = (a: Frame, b: Frame) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const paint = (node: HTMLElement, frame: Frame) => {
  for (const key of ["x", "y", "w", "h"] as const) node.style.setProperty(`--${key}`, String(frame[key]));
};
/** Keys that are the editor's own however the keyboard got here: Undo and Redo. */
const isHistoryKey = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) && !event.altKey && ["z", "y"].includes(event.key.toLowerCase());

let visits = 0;

/** Opens the template editor for one of the brand's templates, over the stage. */
export function editTemplate(host: BrandHost, id: string): void {
  const { session, floor } = host;
  if (!session.doc.templates || !Object.hasOwn(session.doc.templates, id)) return;
  floor.querySelector(".ed-tpl")?.remove();
  const from = host.scene();
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const template = () => session.doc.templates?.[id] as Template;
  let chosen: string | undefined = template().slots[0]?.id;
  let gesture: Gesture | undefined;
  let typing = false;
  let visit = 0;

  const said = h("p", { class: "ed-problem", role: "alert", hidden: true });
  const say = (text: string | undefined) => {
    said.hidden = text === undefined;
    said.textContent = text ?? "";
  };
  /** Applies the operations of one change, or says why there are none. True when it was made. */
  const run = (ops: Op[] | string, options?: ApplyOptions): boolean => {
    if (typeof ops === "string") {
      say(ops);
      return false;
    }
    if (ops.length === 0) return true;
    const result = session.apply(ops, options);
    say(result.ok ? undefined : problemOf(result));
    return result.ok;
  };
  /**
   * A form field's single operation. A change to one slot, or to the template's own properties, is always one; the
   * reasons there can be none (the template or the slot is gone) close the mode or choose another slot first.
   */
  const one = (ops: Op[] | string): Op => {
    if (typeof ops === "string" || ops.length !== 1)
      throw new Error(typeof ops === "string" ? ops : "Not one change.");
    return ops[0] as Op;
  };
  const edits: Edits = {
    type(ops, options) {
      typing = true;
      try {
        return session.apply(ops, options);
      } finally {
        typing = false;
      }
    },
    act: (ops, options) => session.apply(ops, options),
  };

  // The slide

  const art = h("span", { class: "ed-mini ed-tpl-art", "aria-hidden": "true" });
  const boxes = h("div", { class: "ed-tpl-boxes", role: "group", "aria-label": "Slots" });
  const guides = h("div", { class: "ed-guides", "aria-hidden": "true" });
  const slide = h("div", { class: "ed-tpl-slide" }, art, boxes, guides);
  const fit = () => art.style.setProperty("--thumb-k", String(slide.clientWidth / 1280));
  const sizes = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : undefined;
  sizes?.observe(slide);

  const slotOf = (slot: string | undefined) => template().slots.find((candidate) => candidate.id === slot);

  function drawSlide() {
    const doc = session.doc;
    // The template's background and chrome, as the player draws them, under the boxes that stand for its slots.
    art.replaceChildren(
      thumbnailFrame(
        asScene({ id: "template-edit", title: template().name, template: id, blocks: [] }),
        lookWithAll(doc),
      ),
    );
    const held =
      document.activeElement instanceof HTMLElement ? document.activeElement.dataset.slot : undefined;
    boxes.replaceChildren(
      ...template().slots.map((slot) => {
        const on = slot.id === chosen;
        const box = h(
          "button",
          {
            type: "button",
            class: "ed-tpl-slot",
            "data-slot": slot.id,
            "data-required": slot.required === true,
            "aria-pressed": String(on),
            "aria-label": `${slot.id}, ${ROLE_LABEL[slot.role]}${slot.required ? ", required" : ""}. ${slot.hint}`,
            "aria-keyshortcuts": "ArrowUp ArrowDown ArrowLeft ArrowRight",
          },
          h("span", { class: "ed-tpl-slot-name" }, slot.id),
          h("span", { class: "ed-tpl-slot-role" }, ROLE_LABEL[slot.role]),
          ...(on
            ? CORNERS.map((corner) =>
                h("span", {
                  class: "ed-handle",
                  "data-handle": corner,
                  title: "Drag to resize",
                  "aria-hidden": "true",
                }),
              )
            : []),
        );
        paint(box, slot.frame);
        return box;
      }),
    );
    if (held !== undefined) boxes.querySelector<HTMLElement>(`[data-slot="${CSS.escape(held)}"]`)?.focus();
    fit();
  }

  function choose(slot: string) {
    if (chosen === slot) return;
    chosen = slot;
    drawSlide();
    drawSide();
  }

  function drawGuides(lines: readonly Guide[]) {
    guides.replaceChildren(
      ...lines.map((line) => {
        const node = h("span", { class: "ed-guide", "data-axis": line.axis });
        if (line.axis === "x") {
          node.style.left = `${line.at}%`;
          node.style.top = "0";
          node.style.height = "100%";
        } else {
          node.style.top = `${line.at}%`;
          node.style.left = "0";
          node.style.width = "100%";
        }
        return node;
      }),
    );
  }

  function move(event: PointerEvent) {
    const g = gesture;
    if (!g) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (!g.live) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.live = true;
      slide.dataset.framing = "";
    }
    const px = (dx / g.slide.width) * 100;
    const py = (dy / g.slide.height) * 100;
    const targets = targetsOf(g.others);
    let result: Snapped;
    if (g.corner === undefined) {
      const moved = nudged(g.start, px, py);
      result = event.altKey ? { frame: moved, guides: [] } : snapMove(moved, targets);
    } else {
      result = event.altKey
        ? { frame: resized(g.start, g.corner, px, py), guides: [] }
        : snapResize(g.start, g.corner, px, py, targets);
    }
    g.frame = result.frame;
    const node = boxes.querySelector<HTMLElement>(`[data-slot="${CSS.escape(g.slot)}"]`);
    if (node) paint(node, result.frame);
    drawGuides(result.guides);
  }

  function finish(commit: boolean) {
    const g = gesture;
    if (!g) return;
    gesture = undefined;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    slide.removeAttribute("data-framing");
    guides.replaceChildren();
    if (!g.live) return;
    // The click that ends a drag lands wherever the pointer is; it must not choose another slot.
    const stop = (event: Event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", stop, true), 0);
    if (commit && !sameFrame(g.frame, g.start) && run(slotSet(session.doc, id, g.slot, { frame: g.frame })))
      return;
    drawSlide();
  }
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (gesture?.live) {
      event.preventDefault();
      event.stopPropagation();
    }
    finish(false);
  }

  boxes.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || gesture || !(event.target instanceof Element)) return;
    const box = event.target.closest<HTMLElement>("[data-slot]");
    const slot = slotOf(box?.dataset.slot);
    if (!box || !slot) return;
    const rect = slide.getBoundingClientRect();
    if (rect.width <= 0) return;
    choose(slot.id);
    const handle = event.target.closest<HTMLElement>("[data-handle]");
    gesture = {
      slot: slot.id,
      corner: handle ? (handle.dataset.handle as Corner) : undefined,
      start: slot.frame,
      frame: slot.frame,
      x: event.clientX,
      y: event.clientY,
      slide: rect,
      others: template()
        .slots.filter((other) => other.id !== slot.id)
        .map((other) => other.frame),
      live: false,
    };
    event.preventDefault();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  });
  boxes.addEventListener("click", (event) => {
    const slot = (event.target as Element).closest<HTMLElement>("[data-slot]")?.dataset.slot;
    if (slot !== undefined) choose(slot);
  });
  boxes.addEventListener("focusin", () => {
    visit = ++visits;
  });
  // The arrow keys move the slot with the keyboard, and with Ctrl size it; holding one down is one step of Undo.
  boxes.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? NUDGE_BIG : NUDGE;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[
      event.key
    ];
    const slot = slotOf((event.target as HTMLElement).dataset.slot);
    if (!delta || !slot) return;
    event.preventDefault();
    const [dx, dy] = delta as [number, number];
    const frame =
      event.ctrlKey || event.metaKey
        ? fitted({ ...slot.frame, w: slot.frame.w + dx, h: slot.frame.h + dy })
        : nudged(slot.frame, dx, dy);
    chosen = slot.id;
    run(slotSet(session.doc, id, slot.id, { frame }), { coalesce: `slot-frame:${id}:${slot.id}:${visit}` });
  });

  // The side panel

  const side = h("div", { class: "ed-tpl-side" });
  let drawn = "";
  function drawSide() {
    const slot = slotOf(chosen);
    const held = document.activeElement;
    const key = held instanceof HTMLElement && side.contains(held) ? held.dataset.field : undefined;
    drawn = JSON.stringify([chosen, template()]);
    const rename = h("input", {
      type: "text",
      "data-field": "tpl:slot:id",
      spellcheck: false,
      maxlength: 64,
    });
    rename.value = slot?.id ?? "";
    rename.addEventListener("change", () => {
      if (!slot || rename.value === slot.id) return;
      const to = rename.value.trim();
      if (run(slotRename(session.doc, id, slot.id, to))) chosen = to;
      else rename.value = slot.id;
    });
    const kinds = slot && slot.role !== "claim" ? (ROLE_KINDS[slot.role] as readonly string[]) : [];
    const removeIt = (to?: string | null) => {
      if (!slot) return;
      const ops = slotRemove(session.doc, id, slot.id, to);
      if (typeof ops === "string") {
        say(ops);
        pinOffer.hidden = !/holds/.test(ops);
        return;
      }
      const at = template().slots.findIndex((candidate) => candidate.id === slot.id);
      if (run(ops)) {
        pinOffer.hidden = true;
        chosen = template().slots[Math.max(0, at - 1)]?.id;
      }
    };
    const pinOffer = actionButton("Remove it, and pin its blocks where it was", () => removeIt(null), {
      "data-field": "tpl:slot:remove-pin",
      hidden: true,
    });
    const slotParts: Array<HTMLElement | false | undefined> = slot
      ? [
          h("h3", { class: "ed-label" }, `Slot ${slot.id}`),
          h(
            "div",
            { class: "ed-field" },
            h("label", {}, h("span", { class: "ed-label" }, "Name"), rename),
            hint("Blocks in the slot follow a new name."),
          ),
          selectField(edits, {
            key: "tpl:slot:role",
            label: "Role",
            options: choices(ROLE_LABEL),
            read: () => slotOf(chosen)?.role ?? "",
            commit: (value) => {
              const role = value as SlotRole;
              const allowed = ROLE_KINDS[role] as readonly string[];
              const now = (slotOf(chosen)?.accepts ?? []).filter((kind) => allowed.includes(kind));
              const accepts =
                role === "claim" ? null : ((now.length > 0 ? now : allowed.slice(0, 1)) as Accepts);
              return one(slotSet(session.doc, id, slot.id, { role, accepts }));
            },
          }),
          kinds.length > 0 &&
            checkField(edits, {
              key: "tpl:slot:accepts",
              label: "Takes",
              items: kinds.map((kind) => ({ id: kind, label: KIND_LABEL[kind as keyof typeof KIND_LABEL] })),
              read: () => slotOf(chosen)?.accepts ?? [],
              commit: (ids) => one(slotSet(session.doc, id, slot.id, { accepts: ids as Accepts })),
            }),
          textField(edits, {
            key: "tpl:slot:hint",
            label: "Hint",
            hint: "What goes here, for a person or an agent filling the slot.",
            read: () => slotOf(chosen)?.hint ?? "",
            commit: (value) =>
              value.trim() === ""
                ? "A slot needs a hint."
                : one(slotSet(session.doc, id, slot.id, { hint: value })),
          }),
          h(
            "label",
            { class: "ed-check" },
            (() => {
              const box = h("input", { type: "checkbox", "data-field": "tpl:slot:required" });
              box.checked = slot.required === true;
              box.addEventListener("change", () => {
                if (!run(slotSet(session.doc, id, slot.id, { required: box.checked ? true : null })))
                  box.checked = !box.checked;
              });
              return box;
            })(),
            h("span", {}, "Required: a scene on this template should fill it"),
          ),
          selectField(edits, {
            key: "tpl:slot:valign",
            label: "Its blocks sit at the",
            options: choices(VALIGN),
            read: () => slotOf(chosen)?.valign ?? "top",
            commit: (value) =>
              one(slotSet(session.doc, id, slot.id, { valign: value === "top" ? null : (value as Valign) })),
          }),
          h(
            "fieldset",
            { class: "ed-tpl-frame" },
            h("legend", { class: "ed-label" }, "Place, in percent of the slide"),
            ...(["x", "y", "w", "h"] as const).map((axis) =>
              numberField(edits, {
                key: `tpl:slot:frame:${axis}`,
                label: { x: "Left", y: "Top", w: "Width", h: "Height" }[axis],
                read: () => slotOf(chosen)?.frame[axis] ?? 0,
                commit: (value) => {
                  const now = slotOf(chosen)?.frame ?? slot.frame;
                  return one(slotSet(session.doc, id, slot.id, { frame: fitted({ ...now, [axis]: value }) }));
                },
              }),
            ),
          ),
          h(
            "div",
            { class: "ed-acts" },
            actionButton("Remove this slot", () => removeIt(), { "data-field": "tpl:slot:remove" }),
          ),
          pinOffer,
        ]
      : [hint("Choose a slot on the slide.")];
    side.replaceChildren(
      ...slotParts.filter((node): node is HTMLElement => node instanceof HTMLElement),
      actionButton(
        "Add a slot",
        () => {
          const ids = new Set(template().slots.map((candidate) => candidate.id));
          const slotId = uniqueId("slot", ids);
          const slot: TemplateSlot = {
            id: slotId,
            role: "body",
            frame: { x: 30, y: 35, w: 40, h: 30 },
            accepts: ["body"],
            hint: "Text.",
          };
          if (run(slotAdd(session.doc, id, slot, chosen))) choose(slotId);
        },
        { "data-field": "tpl:slot:add" },
      ),
      h("h3", { class: "ed-label" }, "The template"),
      selectField(edits, {
        key: "tpl:background",
        label: "Background",
        empty: "None: the slide's own",
        options: choices(BACKGROUND),
        read: () => template().background?.color ?? "",
        commit: (value) =>
          one(
            templateSet(session.doc, id, {
              background: value === "" ? null : { ...template().background, color: value as Background },
            }),
          ),
      }),
      selectField(edits, {
        key: "tpl:chrome",
        label: "Chrome",
        options: choices(CHROME),
        read: () => template().chrome ?? "full",
        commit: (value) =>
          one(templateSet(session.doc, id, { chrome: value === "full" ? null : (value as ChromeLevel) })),
      }),
    );
    if (key !== undefined) side.querySelector<HTMLElement>(`[data-field="${CSS.escape(key)}"]`)?.focus();
  }

  // The scenes on the template

  const strip = h("ul", { class: "ed-tpl-scenes" });
  const stripHead = h("h3", { class: "ed-label" });
  function drawStrip() {
    const doc = session.doc;
    const look = lookWithAll(doc);
    const scenes = scenesOn(doc, id);
    stripHead.textContent =
      scenes.length === 0 ? "No scene is on this template yet" : `Scenes on this template (${scenes.length})`;
    strip.replaceChildren(
      ...scenes.map((scene) =>
        h(
          "li",
          { "data-scene": scene.id },
          picture(doc, scene, look, "ed-tpl-thumb"),
          h("span", { class: "ed-hint-text" }, scene.title),
        ),
      ),
    );
  }

  // The mode

  const done = h("button", { type: "button", class: "ed-primary", "data-action": "template-done" }, "Done");
  const title = h("h2", {});
  const element = h(
    "section",
    { class: "ed-tpl", "aria-label": `Edit the template ${template().name}`, "data-template": id },
    h(
      "header",
      { class: "ed-tpl-head" },
      title,
      hint("Drag a slot to move it and its corners to size it. Alt turns snapping off."),
      done,
    ),
    said,
    h("div", { class: "ed-tpl-stage" }, slide),
    h("aside", { class: "ed-tpl-panel", "aria-label": "The chosen slot and the template" }, side),
    h("div", { class: "ed-tpl-strip" }, stripHead, strip),
  );

  function leave() {
    finish(false);
    unsubscribe();
    sizes?.disconnect();
    element.remove();
    host.select(from);
    if (back?.isConnected) back.focus({ preventScroll: true });
  }
  done.addEventListener("click", leave);
  // Keys pressed here are the mode's, so a T typed into a hint adds no text to a slide. Undo and Redo still work.
  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      leave();
    }
    if (!isHistoryKey(event)) event.stopPropagation();
  });

  function drawAll() {
    title.textContent = `Template: ${template().name}`;
    drawSlide();
    drawStrip();
    if (!typing && JSON.stringify([chosen, template()]) !== drawn) drawSide();
  }
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "saved") return;
    // A template that is gone, by Undo or by the agent, leaves nothing to edit.
    if (!session.doc.templates || !Object.hasOwn(session.doc.templates, id)) return leave();
    if (!slotOf(chosen)) chosen = template().slots[0]?.id;
    drawAll();
  });

  floor.append(element);
  drawAll();
  boxes.querySelector<HTMLElement>(`[data-slot="${CSS.escape(chosen ?? "")}"]`)?.focus();
}
