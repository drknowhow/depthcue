/**
 * Save as template: the scene on show, made into a template of the deck's brand. Each block becomes a slot at the place
 * it has on the slide, with a role from its kind, and the claim becomes the claim slot. The person names the template,
 * says when to use it, and gives each slot its hint and whether it is required. Saving writes `template.set`; then the
 * scene can be put on it through Change template's own path, with each block going back to the slot it made.
 */
import {
  type BlockKind,
  BRAND_LIMITS,
  type Doc,
  type Frame,
  kindOf,
  type Op,
  type Template,
  type TemplateSlot,
  templatesOf,
} from "@depthcue/core";
import { h } from "@depthcue/player";
import { type BrandHost, hint } from "./brandbits.ts";
import { BUILT_IN_TEMPLATES } from "./brandchecks.ts";
import { openBrand } from "./brandpanel.ts";
import { asScene, lookWithAll, modal, picture, planOf, templateOf } from "./branduse.ts";
import { actionButton, problemOf } from "./fields.ts";
import { fitted } from "./pin.ts";
import { describeBlock, uniqueId } from "./templates.ts";

export type SlotRole = TemplateSlot["role"];

/** What each role of a slot is called. A `Record` over the schema's roles, so a role it adds needs a name here. */
export const ROLE_LABEL: Record<SlotRole, string> = {
  title: "Title",
  subtitle: "Subtitle",
  claim: "Claim",
  body: "Text",
  picture: "Picture",
  chart: "Chart",
  table: "Table",
  content: "Any block",
};

/** The role of the slot a block of each kind makes. A first heading makes the title, and any other the subtitle. */
const ROLE_OF: Record<BlockKind, SlotRole> = {
  heading: "subtitle",
  body: "body",
  caption: "body",
  quote: "body",
  image: "picture",
  chart: "chart",
  table: "table",
  clip: "content",
  contents: "content",
};

/** The hint a slot starts with, by the kind of block that made it. The person edits it before saving. */
const HINT: Record<BlockKind | "title" | "claim", string> = {
  title: "The slide's title, in a few words.",
  claim: "The one point this slide makes.",
  heading: "A heading under the title.",
  body: "What the slide says, in a few lines.",
  caption: "A short label.",
  quote: "A quote, and who said it.",
  image: "A picture.",
  chart: "A chart of the numbers.",
  table: "A table.",
  clip: "A video clip.",
  contents: "The contents of the deck.",
};

export interface Draft {
  /** The template as it would be written, with its id. */
  template: Template;
  /** For each slot, in order, the id of the block or claim it was made from. */
  from: string[];
}

/**
 * The template a scene makes: a slot for its claim, then one for each block in order, at the frame the block is pinned
 * to or measured at on the slide, else one under another. Each slot takes the kind of block that made it. The scene's
 * template, when it has one, gives its background and how much chrome shows. Answers why there can be none.
 */
export function draftOf(
  doc: Doc,
  sceneId: string,
  measure: (id: string) => Frame | undefined,
  name = "",
): Draft | string {
  const scene = doc.scenes[sceneId];
  if (!scene) return "There is no scene on show to save.";
  const count = scene.blocks.length + (scene.summary ? 1 : 0);
  if (count > BRAND_LIMITS.slots) {
    return `This scene has ${count} blocks, and a template holds ${BRAND_LIMITS.slots} slots at most. Move some blocks to another scene first.`;
  }
  const ids = new Set<string>();
  let below = 8;
  const frameOf = (id: string, own: Frame | undefined): Frame => {
    const found = own ?? measure(id);
    if (found) return fitted(found);
    const stacked = { x: 8, y: below, w: 84, h: 12 };
    below = Math.min(below + 14, 88);
    return stacked;
  };
  const slots: TemplateSlot[] = [];
  const from: string[] = [];
  if (scene.summary) {
    const id = uniqueId("claim", ids);
    ids.add(id);
    slots.push({ id, role: "claim", frame: frameOf(scene.summary.id, undefined), hint: HINT.claim });
    from.push(scene.summary.id);
  }
  let titled = false;
  for (const block of scene.blocks) {
    const kind = kindOf(block);
    const title = kind === "heading" && !titled;
    if (title) titled = true;
    const role: SlotRole = title ? "title" : ROLE_OF[kind];
    const id = uniqueId(role, ids);
    ids.add(id);
    slots.push({
      id,
      role,
      frame: frameOf(block.id, block.frame),
      accepts: [kind],
      hint: HINT[title ? "title" : kind],
    });
    from.push(block.id);
  }
  const taken = new Set([...Object.keys(templatesOf(doc)), ...Object.keys(BUILT_IN_TEMPLATES)]);
  const was = templateOf(doc, scene.template);
  const template: Template = {
    schemaVersion: "0.4",
    id: uniqueId(name.trim() || scene.title, taken),
    name: (name.trim() || scene.title).slice(0, 40),
    description: `Like the scene "${scene.title}".`.slice(0, BRAND_LIMITS.description),
    ...(was?.background ? { background: { ...was.background } } : {}),
    ...(was?.chrome ? { chrome: was.chrome } : {}),
    slots,
  };
  return { template, from };
}

/**
 * The operations that put a scene on the template it was saved as: Change template's own, then whatever makes each block
 * land in the slot it made, out of the pin it may have had, as that pin is now the slot's frame.
 */
export function putOnOps(
  doc: Doc,
  sceneId: string,
  draft: Draft,
  measure: (id: string) => Frame | undefined,
): Op[] | string {
  const plan = planOf(doc, sceneId, { template: draft.template.id }, measure);
  if (plan.problem || !plan.after) return plan.problem ?? "The scene cannot be put on the template.";
  const ops = [...plan.ops];
  const want = new Map(draft.from.map((id, at) => [id, draft.template.slots[at]?.id as string]));
  for (const block of plan.after.scene.blocks) {
    const slot = want.get(block.id);
    if (slot === undefined) continue;
    if (block.slot !== slot) ops.push({ op: "block.set", scene: sceneId, id: block.id, set: { slot } });
    if (block.frame !== undefined) ops.push({ op: "block.unframe", scene: sceneId, id: block.id });
  }
  return ops;
}

let uid = 0;

/**
 * The dialog of Save as template. With no brand it says templates belong to one and opens the Brand panel. With one it
 * shows the slots the scene makes, drawn as the template will be, each with its hint and Required, under a name and a
 * description; Save writes the template, and then offers to put the scene on it.
 */
export function saveTemplate(host: BrandHost): void {
  const { session } = host;
  const sceneId = host.scene();
  const scene = session.doc.scenes[sceneId];
  if (!scene) return;
  const dialog = modal(host.root, `Save "${scene.title}" as a template`, "save-template");
  if (!session.doc.brand) {
    dialog.body.append(
      hint("A template belongs to the deck's brand, and this deck has none yet. Start one first."),
    );
    dialog.foot.prepend(
      actionButton(
        "Start a brand…",
        () => {
          dialog.close();
          openBrand(host);
        },
        { class: "ed-primary", "data-dialog-action": "start-brand" },
      ),
    );
    return;
  }
  const first = draftOf(session.doc, sceneId, host.measure);
  if (typeof first === "string") {
    dialog.refused(first);
    return;
  }
  const slots = first.template.slots.map((slot) => ({ ...slot }));
  const field = (label: string, control: HTMLElement, note?: string) =>
    h(
      "div",
      { class: "ed-field" },
      h("label", {}, h("span", { class: "ed-label" }, label), control),
      note && hint(note),
    );
  const name = h("input", { type: "text", maxlength: 40, "data-field": "save:name", required: true });
  name.value = first.template.name;
  const about = h("textarea", {
    rows: 2,
    maxlength: BRAND_LIMITS.description,
    "data-field": "save:description",
  });
  about.value = "";
  about.placeholder = "When to use it, for the template picker and for an agent choosing one.";
  const preview = h("div", { class: "ed-save-preview" });
  const draft = (): Draft => {
    const made = draftOf(session.doc, sceneId, host.measure, name.value) as Draft;
    return {
      from: made.from,
      template: {
        ...made.template,
        description: about.value.trim(),
        slots: slots.map((slot) => ({ ...slot })),
      },
    };
  };
  const show = () => {
    const { template } = draft();
    const doc: Doc = { ...session.doc, templates: { ...session.doc.templates, [template.id]: template } };
    const thumb = picture(
      doc,
      asScene({ id: "saved", title: template.name, template: template.id, blocks: [] }),
      lookWithAll(doc),
      "ed-save-thumb",
    );
    preview.replaceChildren(thumb);
    // The picture is as wide as its column, so the slide in it is scaled to that width.
    const width = preview.clientWidth;
    if (width > 0) thumb.style.setProperty("--thumb-k", String(width / 1280));
  };
  const rows = slots.map((slot, at) => {
    const madeFrom = first.from[at] as string;
    const block = scene.blocks.find((candidate) => candidate.id === madeFrom);
    const from = block ? describeBlock(block, 40, scene) : `Claim: ${scene.summary?.text ?? ""}`.slice(0, 48);
    const id = `ed-save-slot-${++uid}`;
    const words = h("input", {
      type: "text",
      maxlength: BRAND_LIMITS.hint,
      "data-field": `save:slot:${slot.id}:hint`,
      "aria-describedby": id,
    });
    words.value = slot.hint;
    words.addEventListener("input", () => {
      slot.hint = words.value;
      show();
    });
    const required = h("input", { type: "checkbox", "data-field": `save:slot:${slot.id}:required` });
    required.addEventListener("change", () => {
      if (required.checked) slot.required = true;
      else delete slot.required;
      show();
    });
    return h(
      "li",
      { class: "ed-save-slot", "data-slot": slot.id },
      h(
        "span",
        { class: "ed-save-slot-name", id },
        h("strong", {}, slot.id),
        ` · ${ROLE_LABEL[slot.role]} · from ${from}`,
      ),
      h(
        "label",
        { class: "ed-save-hint" },
        h("span", { class: "ed-sr-only" }, `Hint for the ${slot.id} slot`),
        words,
      ),
      h("label", { class: "ed-check" }, required, h("span", {}, "Required")),
    );
  });
  name.addEventListener("input", show);
  const save = h(
    "button",
    { type: "button", class: "ed-primary", "data-dialog-action": "save" },
    "Save template",
  );
  dialog.foot.prepend(save);
  dialog.body.append(
    h(
      "div",
      { class: "ed-save" },
      h("div", { class: "ed-save-words" }, field("Name", name), field("When to use it", about), preview),
      h(
        "section",
        { class: "ed-save-slots", "aria-label": "Slots" },
        h("h3", { class: "ed-label" }, "Slots, one for each block"),
        h("ol", {}, ...rows),
      ),
    ),
  );
  show();
  name.focus();
  name.select();

  save.addEventListener("click", () => {
    const made = draft();
    if (made.template.name.trim() === "") return dialog.refused("Give the template a name.");
    if (made.template.description === "") return dialog.refused("Say when to use it, in a sentence.");
    const { id, schemaVersion: _version, ...template } = made.template;
    const result = session.apply([{ op: "template.set", id, template }]);
    if (!result.ok) return dialog.refused(problemOf(result));
    dialog.refused(undefined);
    offerPutOn(host, dialog, sceneId, made);
  });
}

/** After saving: the offer to put the scene on its new template, as a step of Undo of its own. */
function offerPutOn(host: BrandHost, dialog: ReturnType<typeof modal>, sceneId: string, draft: Draft) {
  const { session } = host;
  const title = session.doc.scenes[sceneId]?.title ?? sceneId;
  dialog.body.replaceChildren(
    h(
      "p",
      { role: "status" },
      `Saved as the template ${draft.template.name}, in brand/templates/${draft.template.id}.json. Put "${title}" on it now? Each block goes into the slot it made.`,
    ),
  );
  for (const node of dialog.foot.querySelectorAll("[data-dialog-action='save']")) node.remove();
  const cancel = dialog.foot.querySelector<HTMLElement>("[data-dialog-action='cancel']");
  if (cancel) cancel.textContent = "Not now";
  const put = actionButton(
    "Put this scene on it",
    () => {
      const ops = putOnOps(session.doc, sceneId, draft, host.measure);
      if (typeof ops === "string") return dialog.refused(ops);
      const result = session.apply(ops);
      if (!result.ok) return dialog.refused(problemOf(result));
      dialog.close();
    },
    { class: "ed-primary", "data-dialog-action": "put-on" },
  );
  dialog.foot.prepend(put);
  put.focus();
}
