/**
 * The Styles and Templates sections of the Brand panel. Each lists the brand's own and Depthcue's, a brand's one with the
 * id of Depthcue's listed once as the brand's. A built-in is changed by copying it into the brand first, as the command
 * line says to. Every change is `style.set` or `template.set`, as `depthcue apply` takes them, and one step of Undo.
 */
import type { BlockKind, BlockStyle, Brand, Doc, Op, Scene, Template } from "@depthcue/core";
import { h } from "@depthcue/player";
import {
  type BrandContext,
  choices,
  hint,
  listed,
  part,
  THEME_NAME,
  THEMES,
  type Theme,
  toggle,
} from "./brandbits.ts";
import { BUILT_IN_STYLES, BUILT_IN_TEMPLATES } from "./brandchecks.ts";
import { asScene, KIND_LABEL, lookWithAll, picture, templateScene } from "./branduse.ts";
import { actionButton, checkField, selectField, textField } from "./fields.ts";
import { scenesOn, toWrite } from "./slotops.ts";
import { editTemplate } from "./templateedit.ts";
import { uniqueId } from "./templates.ts";
import { saveTemplate } from "./templatesave.ts";
import { thumbnailFrame } from "./thumbnail.ts";

type Hidden = NonNullable<Brand["hideBuiltIn"]>[number];

/** The operation that offers Depthcue's own templates or styles, or stops offering them. */
function offerBuiltIns(ctx: BrandContext, set: Hidden, on: boolean): Op {
  const hidden = new Set(ctx.brand().hideBuiltIn ?? []);
  if (on) hidden.delete(set);
  else hidden.add(set);
  return { op: "brand.set", set: { hideBuiltIn: hidden.size > 0 ? [...hidden] : null } };
}

const hides = (ctx: BrandContext, set: Hidden) => ctx.brand().hideBuiltIn?.includes(set) === true;

/** The ids to list: the brand's own first, then Depthcue's that the brand neither hides nor replaces. */
function listedIds(
  own: Readonly<Record<string, unknown>>,
  builtIn: Readonly<Record<string, unknown>>,
  hidden: boolean,
) {
  return [
    ...Object.keys(own),
    ...(hidden ? [] : Object.keys(builtIn).filter((id) => !Object.hasOwn(own, id))),
  ];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Styles

type StyleProp = Exclude<keyof BlockStyle, "name" | "for">;

/**
 * What each property of a style can be, in a person's words. A value the schema adds and this leaves out still shows,
 * by its own name, where a style has it; brandkit.test.ts compares these with the schema's, so the list cannot fall
 * behind unnoticed. (Typed over the schema itself, the record is more than the compiler will check.)
 */
export const STYLE_VALUES: Record<StyleProp, Record<string, string>> = {
  font: { display: "Display face", body: "Body face", mono: "Mono face" },
  size: { s: "Small", m: "Medium", l: "Large", xl: "Extra large" },
  weight: { regular: "Regular", bold: "Bold" },
  case: { none: "As written", upper: "Upper case", lower: "Lower case" },
  tone: { text: "Text", muted: "Muted", action: "Accent", evidence: "Evidence", bg: "Reversed" },
  fill: { none: "None", surface: "Panel", action: "Accent", evidence: "Evidence", text: "Text color" },
  border: { none: "None", line: "Line", action: "Accent" },
  edge: { none: "None", start: "Down the start side", top: "Along the top" },
  radius: { none: "Square", s: "Small", m: "Medium", l: "Large" },
  pad: { none: "None", s: "Small", m: "Medium", l: "Large" },
  align: { start: "Start", center: "Center", end: "End" },
};
const STYLE_PROP: Record<StyleProp, string> = {
  font: "Face",
  size: "Size",
  weight: "Weight",
  case: "Case",
  tone: "Text color",
  fill: "Fill",
  border: "Border",
  edge: "Accent edge",
  radius: "Corners",
  pad: "Padding",
  align: "Alignment",
};

const TEXT_KINDS: readonly BlockKind[] = ["heading", "body", "caption", "quote"];
/** The words a sample block shows, for each kind a style can be for. */
const SAMPLE: Record<BlockKind, string> = {
  heading: "A heading",
  body: "Some body text",
  caption: "A short label",
  quote: "Worth repeating",
  image: "Round an image",
  table: "Round a table",
  chart: "Round a chart",
  clip: "Round a clip",
};

/** The deck on another preset, with no colors of its own, so the brand's are what shows. */
export function onPreset(doc: Doc, theme: Theme): Doc {
  const { palette: _palette, ...deck } = doc.deck;
  return { ...doc, deck: { ...deck, theme } };
}

/**
 * A style on a sample block of one kind, drawn by the player at its true size on a slide of the deck's look: text for a
 * text kind, and for any other kind a line of text in its fill, border and edge, which is what the style gives it.
 */
export function styleSample(doc: Doc, styleId: string, kind: BlockKind): HTMLElement {
  const role = (TEXT_KINDS.includes(kind) ? kind : "body") as "heading" | "body" | "caption" | "quote";
  const scene: Scene = {
    schemaVersion: "0.4",
    id: "style-sample",
    title: "Style",
    layout: "text-media",
    blocks: [{ id: "sample", type: "text", role, text: SAMPLE[kind], style: styleId }],
  };
  const { chrome: _chrome, ...look } = lookWithAll(doc);
  return h("span", { class: "ed-mini ed-style-thumb ed-brand-sample" }, thumbnailFrame(scene, look));
}

/** How many blocks of the deck take a style. */
function blocksWith(doc: Doc, id: string): number {
  let count = 0;
  for (const sceneId of doc.deck.scenes)
    for (const block of doc.scenes[sceneId]?.blocks ?? []) if (block.style === id) count += 1;
  return count;
}

function styleEditor(ctx: BrandContext, id: string): HTMLElement {
  const style = () => ctx.brand().styles?.[id] as BlockStyle;
  const write = (next: BlockStyle): Op => ({ op: "style.set", id, style: next });
  const props = (Object.keys(STYLE_PROP) as StyleProp[]).map((prop) =>
    selectField(ctx.edits, {
      key: `brand:style:${id}:${prop}`,
      label: STYLE_PROP[prop],
      empty: "Not set",
      options: choices(STYLE_VALUES[prop]),
      read: () => (style()[prop] as string | undefined) ?? "",
      commit: (value) => {
        const next: Record<string, unknown> = { ...style() };
        if (value === "") delete next[prop];
        else next[prop] = value;
        return write(next as BlockStyle);
      },
    }),
  );
  const doc = ctx.session.doc;
  const kinds = style().for as readonly BlockKind[];
  return h(
    "div",
    { class: "ed-brand-editor", "data-editing": id },
    textField(ctx.edits, {
      key: `brand:style:${id}:name`,
      label: "Name",
      read: () => style().name,
      commit: (value) => (value.trim() === "" ? "A style needs a name." : write({ ...style(), name: value })),
    }),
    checkField(ctx.edits, {
      key: `brand:style:${id}:for`,
      label: "For",
      items: (Object.keys(KIND_LABEL) as BlockKind[]).map((kind) => ({ id: kind, label: KIND_LABEL[kind] })),
      read: () => style().for,
      commit: (ids) => write({ ...style(), for: ids as BlockStyle["for"] }),
    }),
    h(
      "div",
      { class: "ed-brand-preview", role: "group", "aria-label": "Preview" },
      ...THEMES.map((theme) =>
        h(
          "div",
          { class: "ed-brand-preview-row", "data-theme": theme },
          h("span", { class: "ed-label" }, THEME_NAME[theme]),
          ...kinds.map((kind) =>
            h(
              "figure",
              { class: "ed-brand-figure", "data-kind": kind },
              styleSample(onPreset(doc, theme), id, kind),
              h("figcaption", {}, KIND_LABEL[kind]),
            ),
          ),
        ),
      ),
    ),
    h("div", { class: "ed-brand-props" }, ...props),
  );
}

export function stylesSection(ctx: BrandContext): Node[] {
  const doc = ctx.session.doc;
  const own = ctx.brand().styles ?? {};
  const hidden = hides(ctx, "styles");
  const ids = listedIds(own, BUILT_IN_STYLES, hidden);
  const editing =
    ctx.state.style !== undefined && Object.hasOwn(own, ctx.state.style) ? ctx.state.style : undefined;
  const entries = ids.map((id) => {
    const mine = Object.hasOwn(own, id);
    const style = (mine ? own[id] : BUILT_IN_STYLES[id]) as BlockStyle;
    const kinds = (style.for as readonly BlockKind[]).map((kind) => KIND_LABEL[kind].toLowerCase());
    const about = [
      mine ? (Object.hasOwn(BUILT_IN_STYLES, id) ? "Replaces Depthcue's own" : "The brand's") : "Built in",
      `for ${listed(kinds)}`,
      plural(blocksWith(doc, id), "block", "blocks"),
    ].join(" · ");
    const open = editing === id;
    const acts = mine
      ? [
          actionButton(
            open ? "Done" : "Edit",
            () => {
              ctx.state.style = open ? undefined : id;
              ctx.redraw();
            },
            {
              "data-field": `brand:style:${id}:edit`,
              "aria-expanded": String(open),
              "aria-label": `${open ? "Done editing" : "Edit"} ${style.name}`,
            },
          ),
          actionButton(
            "Remove",
            () => {
              if (ctx.run([{ op: "style.set", id, style: null }]) && editing === id)
                ctx.state.style = undefined;
            },
            { "data-field": `brand:style:${id}:remove`, "aria-label": `Remove ${style.name}` },
          ),
        ]
      : [
          actionButton(
            "Copy into the brand",
            () => {
              if (ctx.run([{ op: "style.set", id, style: { ...style } }])) {
                ctx.state.style = id;
                ctx.redraw();
              }
            },
            {
              "data-field": `brand:style:${id}:copy`,
              "aria-label": `Copy ${style.name} into the brand, to change it`,
            },
          ),
        ];
    return h(
      "li",
      { class: "ed-brand-entry", "data-style": id, "data-own": mine },
      styleSample(doc, id, (style.for as readonly BlockKind[])[0] ?? "body"),
      h(
        "div",
        { class: "ed-brand-entry-text" },
        h("span", { class: "ed-brand-entry-name" }, style.name),
        h("span", { class: "ed-hint-text" }, about),
      ),
      h("div", { class: "ed-acts" }, ...acts),
      open && styleEditor(ctx, id),
    );
  });
  const add = actionButton(
    "Add a style",
    () => {
      const id = uniqueId("style", new Set(ids));
      if (ctx.run([{ op: "style.set", id, style: { name: "New style", for: ["body"] } }])) {
        ctx.state.style = id;
        ctx.redraw();
      }
    },
    { "data-field": "brand:style:add" },
  );
  return [
    part(
      "Styles",
      hint(
        "Named looks a block takes from its Style menu. A block's own color, size and alignment win over its style's.",
      ),
      h("ul", { class: "ed-brand-list" }, ...entries),
      add,
    ),
    toggle(ctx, "brand:hide:styles", "Offer Depthcue's own styles too", !hidden, (on) =>
      offerBuiltIns(ctx, "styles", on),
    ),
  ];
}

// Templates

export function templatesSection(ctx: BrandContext): Node[] {
  const doc = ctx.session.doc;
  const own = doc.templates ?? {};
  const hidden = hides(ctx, "templates");
  const ids = listedIds(own, BUILT_IN_TEMPLATES, hidden);
  const look = lookWithAll(doc);
  const current = (id: string) => ctx.session.doc.templates?.[id] as Template;
  const entries = ids.map((id) => {
    const mine = Object.hasOwn(own, id);
    const template = (mine ? own[id] : BUILT_IN_TEMPLATES[id]) as Template;
    const users = scenesOn(doc, id);
    const takesOver = Object.hasOwn(BUILT_IN_TEMPLATES, id) && !hidden;
    const about = [
      mine ? (Object.hasOwn(BUILT_IN_TEMPLATES, id) ? "Replaces Depthcue's own" : "The brand's") : "Built in",
      plural(users.length, "scene", "scenes"),
    ].join(" · ");
    const remove = () => {
      if (users.length > 0 && !takesOver) {
        ctx.say(
          `${template.name} is used by ${listed(users.map((scene) => `"${scene.title}"`))}. Put ${users.length === 1 ? "that scene" : "those scenes"} on another template first, with Change template.`,
        );
        return;
      }
      ctx.run([{ op: "template.set", id, template: null }]);
    };
    const words = mine
      ? [
          textField(ctx.edits, {
            key: `brand:template:${id}:name`,
            label: "Name",
            read: () => current(id).name,
            commit: (value) =>
              value.trim() === ""
                ? "A template needs a name."
                : { op: "template.set", id, template: { ...toWrite(current(id)), name: value } },
          }),
          textField(ctx.edits, {
            key: `brand:template:${id}:description`,
            label: "When to use it",
            multiline: true,
            read: () => current(id).description,
            commit: (value) =>
              value.trim() === ""
                ? "A template needs a description, for the picker and for an agent choosing one."
                : { op: "template.set", id, template: { ...toWrite(current(id)), description: value } },
          }),
        ]
      : [
          h("span", { class: "ed-brand-entry-name" }, template.name),
          h("p", { class: "ed-hint-text" }, template.description),
        ];
    const acts = mine
      ? [
          actionButton("Edit slots", () => editTemplate(ctx.host, id), {
            "data-field": `brand:template:${id}:edit`,
            "aria-label": `Edit the slots of ${template.name}`,
          }),
          actionButton(
            "Duplicate",
            () => {
              const copy = uniqueId(`${id}-copy`, new Set(ids));
              ctx.run([
                {
                  op: "template.set",
                  id: copy,
                  template: { ...toWrite(template), name: `${template.name} copy`.slice(0, 40) },
                },
              ]);
            },
            { "data-field": `brand:template:${id}:duplicate`, "aria-label": `Duplicate ${template.name}` },
          ),
          actionButton("Remove", remove, {
            "data-field": `brand:template:${id}:remove`,
            "aria-label": `Remove ${template.name}`,
          }),
        ]
      : [
          actionButton(
            "Copy into the brand",
            () => ctx.run([{ op: "template.set", id, template: toWrite(template) }]),
            {
              "data-field": `brand:template:${id}:copy`,
              "aria-label": `Copy ${template.name} into the brand, to change it`,
            },
          ),
        ];
    return h(
      "li",
      { class: "ed-brand-entry ed-brand-template", "data-template": id, "data-own": mine },
      picture(doc, asScene(templateScene(doc, id)), look, "ed-brand-thumb"),
      h(
        "div",
        { class: "ed-brand-entry-text" },
        ...words,
        h("span", { class: "ed-hint-text", "data-uses": users.length }, about),
      ),
      h("div", { class: "ed-acts" }, ...acts),
    );
  });
  return [
    part(
      "Templates",
      hint("Slide layouts with named slots, for the template picker and for an agent adding a scene."),
      h("ul", { class: "ed-brand-list" }, ...entries),
      actionButton("Save the scene on show as a template…", () => saveTemplate(ctx.host), {
        "data-field": "brand:template:save",
      }),
    ),
    toggle(ctx, "brand:hide:templates", "Offer Depthcue's own templates too", !hidden, (on) =>
      offerBuiltIns(ctx, "templates", on),
    ),
  ];
}
