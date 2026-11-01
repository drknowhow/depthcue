/**
 * A deck's brand, as far as its scenes see it: where its files are, which templates and component styles a scene may
 * name, and the checks of a scene that names them. The checks of the brand's own files are in brandcheck.ts.
 */
import { BUILT_IN_STYLES, BUILT_IN_TEMPLATES } from "./builtins.ts";
import { closest } from "./diagnostics.ts";
import { own } from "./own.ts";
import { ID_PATTERN } from "./schema.ts";
import type {
  Block,
  BlockKind,
  BlockStyle,
  Brand,
  Deck,
  Diagnostic,
  Scene,
  Template,
  TemplateSlot,
} from "./types.ts";

/** The folder of a deck that holds its brand, and the brand's own file in it. */
export const BRAND_DIR = "brand";
export const BRAND_FILE = "brand/brand.json";
/** The folder of a brand's templates. Each file is named for the template's id. */
export const TEMPLATES_DIR = "brand/templates";
export const templatePath = (id: string): string => `${TEMPLATES_DIR}/${id}.json`;
/** The deck-relative path of a file the brand names, such as `fonts/Acme-Regular.woff2`. */
export const brandFilePath = (file: string): string => `${BRAND_DIR}/${file}`;
/** True for a JSON file directly in the templates folder, whatever its name. */
export const isTemplateFile = (path: string): boolean => /^brand\/templates\/[^/]+\.json$/.test(path);
/**
 * The template id a deck-relative path names: a JSON file in the templates folder named for a valid id. Any other name,
 * such as `__proto__.json`, names no template, and the checks refuse the file.
 */
export function templateIdOf(path: string): string | undefined {
  const name = /^brand\/templates\/([^/]+)\.json$/.exec(path)?.[1];
  return name !== undefined && new RegExp(ID_PATTERN).test(name) ? name : undefined;
}

/** What a document carries of its brand: `brand.json`, and its templates by id. Both are there, or neither. */
export interface BrandPart {
  readonly brand?: Brand | undefined;
  readonly templates?: Readonly<Record<string, Template>> | undefined;
}

/** What a scene may name: the templates and the styles of its deck, by id. */
export interface SceneKit {
  readonly templates: Readonly<Record<string, Template>>;
  readonly styles: Readonly<Record<string, BlockStyle>>;
}

const hides = (brand: Brand | undefined, set: "templates" | "styles"): boolean =>
  brand?.hideBuiltIn?.includes(set) === true;

/** The templates a deck may use: Depthcue's own unless its brand hides them, with the brand's on top by id. */
export const templatesOf = (part: BrandPart): Readonly<Record<string, Template>> => ({
  ...(hides(part.brand, "templates") ? {} : BUILT_IN_TEMPLATES),
  ...part.templates,
});

/** The component styles a deck may use: Depthcue's own unless its brand hides them, with the brand's on top by id. */
export const blockStylesOf = (part: BrandPart): Readonly<Record<string, BlockStyle>> => ({
  ...(hides(part.brand, "styles") ? {} : BUILT_IN_STYLES),
  ...part.brand?.styles,
});

export const kitOf = (part: BrandPart): SceneKit => ({
  templates: templatesOf(part),
  styles: blockStylesOf(part),
});

/** The kind a slot accepts and a style is for: a text block by its role, a `bar-chart` as a chart, others by type. */
export function kindOf(block: Block): BlockKind {
  if (block.type === "text") return block.role;
  return block.type === "bar-chart" ? "chart" : block.type;
}

/** How many blocks a slot stacks. */
export const slotMax = (slot: TemplateSlot): number => slot.max ?? 1;

export type BackgroundColor = NonNullable<Template["background"]>["color"];

/**
 * The color text is drawn in on a template's background: the text color on the slide's own colors, and the slide's
 * color on a strong one, as white on a dark band.
 */
export const textOn = (color: BackgroundColor): "text" | "bg" =>
  color === "bg" || color === "surface" ? "text" : "bg";

const error = (file: string, path: string, code: string, message: string, fix: string): Diagnostic => ({
  severity: "error",
  code,
  file,
  path,
  message,
  fix,
});

const choices = (wanted: string, options: readonly string[], what: string): string => {
  const guess = closest(wanted, options);
  const list = options.length > 0 ? `Use one of: ${options.join(", ")}.` : `The deck has no ${what}s.`;
  return guess ? `Did you mean "${guess}"? ${list}` : list;
};

/** "heading, body and image" */
const listed = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** A palette or a font pair in deck.json while its brand locks them, as errors under `brand-locked`. */
export function checkBrandLock(deck: Deck, brand: Brand | undefined, file: string): Diagnostic[] {
  if (!brand?.lock) return [];
  return (["palette", "fonts"] as const)
    .filter((key) => deck[key] !== undefined)
    .map((key) =>
      error(
        file,
        `/${key}`,
        "brand-locked",
        `The brand "${brand.id}" is locked, so the deck cannot set its own ${key === "palette" ? "colors" : "fonts"}.`,
        `Remove "${key}" from deck.json, or change the brand's ${key === "palette" ? "colors" : "fonts"} with brand.set.`,
      ),
    );
}

/**
 * That a scene has exactly one of a layout and a template. The schema leaves both optional so this can say both ways
 * out; a scene with neither keeps the code it had when `layout` was required.
 */
export function checkSceneForm(scene: Partial<Scene>, file: string): Diagnostic[] {
  if (scene.layout !== undefined && scene.template !== undefined) {
    return [
      error(
        file,
        "/template",
        "layout-and-template",
        "A scene is drawn by a layout or by a template, not both.",
        'Remove "layout" to keep the template, or remove "template" and each block\'s "slot" to keep the layout.',
      ),
    ];
  }
  if (scene.layout === undefined && scene.template === undefined) {
    return [
      error(file, "/layout", "missing-property", 'Missing "layout".', 'Add "layout", or a "template".'),
    ];
  }
  return [];
}

/**
 * Facts about the templates, slots and styles a sound scene names, which only the deck's kit can tell: the template
 * and each style exist, every block of a template scene sits in a slot that takes its kind and has room for it, a block
 * of a layout scene names no slot, a style is for the kind of block that takes it, and a template scene has no claim.
 * A required slot left empty is a warning: the scene may still be in progress. A pinned block names a slot like any
 * other, for its kind and its style, but floats at its frame, so it neither fills a slot nor counts toward its `max`.
 */
export function checkSceneBrand(scene: Scene, kit: SceneKit, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const styleIds = Object.keys(kit.styles);
  scene.blocks.forEach((block, i) => {
    if (block.style === undefined) return;
    const style = own(kit.styles, block.style);
    if (!style) {
      out.push(
        error(
          file,
          `/blocks/${i}/style`,
          "unknown-style",
          `There is no style "${block.style}".`,
          choices(block.style, styleIds, "style"),
        ),
      );
    } else if (!(style.for as readonly string[]).includes(kindOf(block))) {
      out.push(
        error(
          file,
          `/blocks/${i}/style`,
          "style-wrong-kind",
          `The style "${block.style}" is for ${listed(style.for)}, not for a ${kindOf(block)}.`,
          `Use a style made for a ${kindOf(block)}, or remove "style".`,
        ),
      );
    }
  });

  if (scene.template === undefined) {
    scene.blocks.forEach((block, i) => {
      if (block.slot === undefined) return;
      out.push(
        error(
          file,
          `/blocks/${i}/slot`,
          "slot-without-template",
          `"${block.slot}" names a slot, but this scene has a layout, which has no named slots.`,
          'Remove "slot", or move the scene to a template with scene.set.',
        ),
      );
    });
    return out;
  }

  const template = own(kit.templates, scene.template);
  if (!template) {
    out.push(
      error(
        file,
        "/template",
        "unknown-template",
        `There is no template "${scene.template}".`,
        choices(scene.template, Object.keys(kit.templates), "template"),
      ),
    );
    return out;
  }
  if (scene.summary) {
    out.push(
      error(
        file,
        "/summary",
        "claim-in-template",
        "A template scene has no place for a claim.",
        "Put the claim's words in a heading block in one of the template's slots, or use the claim-evidence layout.",
      ),
    );
  }
  const slots = new Map(template.slots.map((slot) => [slot.id, slot]));
  const filled = new Map<string, number>();
  scene.blocks.forEach((block, i) => {
    if (block.slot === undefined) {
      out.push(
        error(
          file,
          `/blocks/${i}`,
          "missing-slot",
          `The block "${block.id}" names no slot, and every block of a template scene sits in one.`,
          `Add "slot". The template "${template.id}" has: ${[...slots.keys()].join(", ")}.`,
        ),
      );
      return;
    }
    const slot = slots.get(block.slot);
    if (!slot) {
      out.push(
        error(
          file,
          `/blocks/${i}/slot`,
          "unknown-slot",
          `The template "${template.id}" has no slot "${block.slot}".`,
          choices(block.slot, [...slots.keys()], "slot"),
        ),
      );
      return;
    }
    const kind = kindOf(block);
    if (!(slot.accepts as readonly string[]).includes(kind)) {
      out.push(
        error(
          file,
          `/blocks/${i}/slot`,
          "slot-refuses-block",
          `The slot "${slot.id}" takes ${listed(slot.accepts)}, not a ${kind}.`,
          `Put the block in a slot that takes a ${kind}, or pick another template.`,
        ),
      );
      return;
    }
    // A pinned block floats over the slots at its frame: it names a slot that takes it, but takes no room in it.
    if (block.frame !== undefined) return;
    const count = (filled.get(slot.id) ?? 0) + 1;
    filled.set(slot.id, count);
    if (count === slotMax(slot) + 1) {
      out.push(
        error(
          file,
          `/blocks/${i}/slot`,
          "slot-over-max",
          `The slot "${slot.id}" holds ${slotMax(slot)} block${slotMax(slot) === 1 ? "" : "s"}, and this is one more.`,
          "Move the block to another slot, remove it, or split the scene.",
        ),
      );
    }
  });
  for (const slot of template.slots) {
    if (slot.required && !filled.has(slot.id)) {
      out.push({
        severity: "warning",
        code: "slot-empty",
        file,
        path: "/template",
        message: `The slot "${slot.id}" of the template "${template.id}" is empty.`,
        fix: `Add a block with "slot": "${slot.id}". It is for: ${slot.hint}`,
      });
    }
  }
  return out;
}
