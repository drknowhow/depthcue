/**
 * The checks of a deck's brand files: their structure, then what the schema cannot state: the files they name exist,
 * a deck that names a brand has it and one that has a brand names it, slots lie on the slide, and every color text is
 * drawn in reaches the contrast minimum on what it is drawn on. Kept apart from brand.ts, which the scene checks use.
 */
import {
  BRAND_FILE,
  type BrandPart,
  blockStylesOf,
  brandFilePath,
  kitOf,
  listed,
  type SceneKit,
  templatePath,
  textOn,
  unusedBrand,
} from "./brand.ts";
import { explain } from "./diagnostics.ts";
import { own } from "./own.ts";
import { brandSchema, ROLE_KINDS, THEMES, templateSchema } from "./schema.ts";
import { schemaValidator } from "./schemacheck.ts";
import { CONTRAST, checkBrandColors, contrastRatio, luminance, styleOf } from "./style.ts";
import type { BlockStyle, Brand, Deck, Diagnostic, Template } from "./types.ts";

/** What a deck folder holds of a brand, read but not yet checked: brand.json, and each template file by its name. */
export interface BrandData {
  brand?: unknown;
  templates: Readonly<Record<string, unknown>>;
}

/** A brand part that passed its structure check, for the scenes to be checked against, and everything found. */
export interface BrandRead {
  /** Left out when the brand cannot be read, so the scenes are not checked against templates that are not there. */
  part?: BrandPart;
  kit?: SceneKit;
  diagnostics: Diagnostic[];
}

const error = (file: string, path: string, code: string, message: string, fix: string): Diagnostic => ({
  severity: "error",
  code,
  file,
  path,
  message,
  fix,
});

const warning = (file: string, path: string, code: string, message: string, fix: string): Diagnostic => ({
  ...error(file, path, code, message, fix),
  severity: "warning",
});

const validateBrand = /* @__PURE__ */ schemaValidator(brandSchema);
const validateTemplate = /* @__PURE__ */ schemaValidator(templateSchema);

/** brand.json's structure. */
export const checkBrandFile = (data: unknown, file = BRAND_FILE): Diagnostic[] =>
  validateBrand(data) ? [] : explain(validateBrand.errors, data, brandSchema, file);

/** A template file's structure, and that its id is the one its file is named for. */
export function checkTemplateFile(data: unknown, id: string, file = templatePath(id)): Diagnostic[] {
  if (!validateTemplate(data)) return explain(validateTemplate.errors, data, templateSchema, file);
  const own = (data as Template).id;
  if (own === id) return [];
  return [
    error(
      file,
      "/id",
      "template-id-mismatch",
      `The file is named for "${id}" but the template's id is "${own}".`,
      `Make the id "${id}", or rename the file to ${templatePath(own)}.`,
    ),
  ];
}

export { unusedBrand };

/**
 * Reads a deck's brand against its deck.json: a deck that names a brand must have its files, and one that names none
 * must not have any, so a brand is never in use by accident. Then the files' structure, then the facts across them.
 * The kit, the templates and styles the scenes may name, comes back whenever the structure is sound: Depthcue's own
 * alone for a deck without a brand.
 */
export function readBrand(deck: Deck, data: BrandData, brandFiles: ReadonlySet<string>): BrandRead {
  const paths = [
    ...(data.brand === undefined ? [] : [BRAND_FILE]),
    ...Object.keys(data.templates).map(templatePath),
  ];
  if (deck.brand === undefined) {
    if (paths.length === 0) return { part: {}, kit: kitOf({}), diagnostics: [] };
    return { diagnostics: [unusedBrand(paths[0] as string, data.brand, "error")] };
  }
  if (data.brand === undefined) {
    return {
      diagnostics: [
        error(
          "deck.json",
          "/brand",
          "missing-brand",
          `deck.json names the brand "${deck.brand}", but ${BRAND_FILE} does not exist.`,
          `Create ${BRAND_FILE} with brand.set, or remove "brand" from deck.json.`,
        ),
      ],
    };
  }
  const diagnostics = checkBrandFile(data.brand);
  for (const [id, template] of Object.entries(data.templates))
    diagnostics.push(...checkTemplateFile(template, id));
  if (diagnostics.length > 0) return { diagnostics };
  const part: BrandPart = {
    brand: data.brand as Brand,
    templates: data.templates as Readonly<Record<string, Template>>,
  };
  return { part, kit: kitOf(part), diagnostics: checkBrand(deck, part, brandFiles) };
}

const chromePlaces = (brand: Brand): string[] => {
  const chrome = brand.chrome;
  return [
    ...(chrome?.footer ? [`bottom-${chrome.footer.place}`] : []),
    ...(chrome?.number ? [`bottom-${chrome.number.place}`] : []),
    ...(chrome?.logo ? [chrome.logo.corner] : []),
  ];
};

/**
 * The facts across a sound brand and its templates that the schema cannot state. Chart colors, styles and templates
 * are checked on every preset the brand gives a palette for, and on the deck's.
 */
export function checkBrand(deck: Deck, part: BrandPart, brandFiles: ReadonlySet<string>): Diagnostic[] {
  const brand = part.brand as Brand;
  const out: Diagnostic[] = [];
  if (deck.brand !== brand.id) {
    out.push(
      error(
        BRAND_FILE,
        "/id",
        "brand-id-mismatch",
        `deck.json names the brand "${deck.brand}", but ${BRAND_FILE} has the id "${brand.id}".`,
        `To keep this ${BRAND_FILE}, set "brand" in deck.json to "${brand.id}"; a save that changed the brand's id and stopped after ${BRAND_FILE} leaves the deck here. Or set "id" in ${BRAND_FILE} to "${deck.brand}".`,
      ),
    );
  }
  const need = (file: string, path: string, what: string) => {
    if (brandFiles.has(brandFilePath(file))) return;
    out.push(
      error(
        BRAND_FILE,
        path,
        "missing-brand-file",
        `${brandFilePath(file)} does not exist.`,
        `Add the ${what} to the brand folder, or point at one that is there.`,
      ),
    );
  };
  if (brand.logos) {
    if (!brand.logos.light && !brand.logos.dark) {
      out.push(
        error(
          BRAND_FILE,
          "/logos",
          "missing-logo",
          "The logos name no file: a brand's logos need a light one, a dark one, or both.",
          'Add "light" for a logo drawn on light slides, "dark" for dark slides, or remove "logos".',
        ),
      );
    }
    if (brand.logos.light) need(brand.logos.light, "/logos/light", "logo");
    if (brand.logos.dark) need(brand.logos.dark, "/logos/dark", "logo");
  }
  // The rule: a placed logo with no dark one, in a brand whose slides can be ink (an ink palette, or an ink deck).
  if (
    brand.chrome?.logo &&
    brand.logos?.light &&
    !brand.logos.dark &&
    (deck.theme === "ink" || brand.colors?.ink !== undefined)
  ) {
    out.push(
      warning(
        BRAND_FILE,
        "/logos",
        "logo-without-dark",
        "The brand has no logo for dark slides, and its slides can be ink: there the light logo is drawn on a plate of the light slides' ground, or it would all but vanish.",
        'Add "dark" to "logos", a logo drawn for dark slides.',
      ),
    );
  }
  if (brand.chrome?.logo && !brand.logos) {
    out.push(
      error(
        BRAND_FILE,
        "/chrome/logo",
        "missing-logo",
        "The chrome places a logo, but the brand has no logos.",
        'Add "logos" with a light or dark logo, or remove "logo" from "chrome".',
      ),
    );
  }
  if (typeof brand.fonts === "object") {
    for (const role of ["display", "body", "mono"] as const) {
      const face = brand.fonts[role];
      if (!face) continue;
      if (!face.files) {
        out.push(
          warning(
            BRAND_FILE,
            `/fonts/${role}`,
            "face-without-files",
            `The deck carries no file for "${face.family}", so a viewer without it installed sees ${brand.fonts.fallback}, the fallback pair.`,
            "Add its files under the brand's fonts/, if its license allows, or leave it for machines that have it.",
          ),
        );
        continue;
      }
      face.files.forEach((entry, i) => {
        need(entry.file, `/fonts/${role}/files/${i}/file`, "font file");
      });
      if (role === "body" && !face.files.some((entry) => entry.weight >= 600 && entry.style === "normal")) {
        out.push(
          warning(
            BRAND_FILE,
            "/fonts/body/files",
            "body-without-bold",
            `"${face.family}" has no bold file, so bold body text is thickened by the browser, which looks smeared.`,
            "Add a file of weight 600 or more, style normal.",
          ),
        );
      }
    }
  }
  const places = chromePlaces(brand);
  const crowded = places.find((place, i) => places.indexOf(place) !== i);
  if (crowded) {
    out.push(
      warning(
        BRAND_FILE,
        "/chrome",
        "chrome-crowded",
        `Two parts of the chrome sit at the ${crowded.replace("-", " ")} of the slide and draw over each other.`,
        "Give the footer, the slide number and the logo different places.",
      ),
    );
  }

  out.push(...checkBrandColors(brand, BRAND_FILE));
  const looks = looksOf(deck, brand);
  for (const { theme, colors } of looks) {
    brand.colors?.[theme]?.chart?.forEach((color, i) => {
      const ratio = contrastRatio(color, colors.bg);
      if (ratio >= CONTRAST.large) return;
      out.push(
        error(
          BRAND_FILE,
          `/colors/${theme}/chart/${i}`,
          "chart-low-contrast",
          `Chart color ${i + 1} (${color}) on ${theme} slides (${colors.bg}) has a contrast of ${Math.floor(ratio * 100) / 100}:1, under the 3:1 a bar or a line needs to be seen.`,
          `Make it ${luminance(colors.bg) > 0.18 ? "darker" : "lighter"} until it reaches 3:1.`,
        ),
      );
    });
    for (const [id, style] of Object.entries(brand.styles ?? {})) {
      out.push(...checkStyleContrast(style, colors, BRAND_FILE, `/styles/${id}`, theme));
    }
  }
  const styles = blockStylesOf(part);
  for (const [id, template] of Object.entries(part.templates ?? {})) {
    out.push(...checkTemplate(template, styles, looks, brandFiles, templatePath(id)));
  }
  return out;
}

type Colors = ReturnType<typeof styleOf>["colors"];
/** The colors of one preset, as a deck of the brand draws it. */
export interface Look {
  theme: (typeof THEMES)[number];
  colors: Colors;
}

/**
 * The presets a brand's colors are checked on: each one it gives a palette for, and the deck's own, which carries the
 * deck's palette too. A deck that changes its theme is checked again then, on the new one.
 */
export const looksOf = (deck: Deck, brand: Brand | undefined): Look[] =>
  THEMES.filter((theme) => theme === deck.theme || brand?.colors?.[theme] !== undefined).map((theme) => ({
    theme,
    colors: styleOf(theme === deck.theme ? deck : { theme }, brand).colors,
  }));

/** The color a style's text is drawn in: its tone, or the one that reads on its fill. */
export const styleTone = (style: BlockStyle): keyof Colors =>
  style.tone ??
  (style.fill === undefined || style.fill === "none" || style.fill === "surface" ? "text" : "bg");

/** A style's text against what it sits on: its fill, or the slide and its panels when it has none. */
function checkStyleContrast(
  style: BlockStyle,
  colors: Colors,
  file: string,
  path: string,
  theme: string,
): Diagnostic[] {
  const tone = styleTone(style);
  const large = style.size === "l" || style.size === "xl" || style.for.every((kind) => kind === "heading");
  const need = large ? CONTRAST.large : CONTRAST.text;
  const grounds =
    style.fill === undefined || style.fill === "none" ? (["bg", "surface"] as const) : [style.fill];
  for (const ground of grounds) {
    const ratio = contrastRatio(colors[tone], colors[ground]);
    if (ratio >= need) continue;
    return [
      error(
        file,
        `${path}/${style.tone ? "tone" : "fill"}`,
        "style-low-contrast",
        `On ${theme} slides, the style's text, "${tone}" (${colors[tone]}), on "${ground}" (${colors[ground]}) has a contrast of ${Math.floor(ratio * 100) / 100}:1, under the ${need}:1 its text needs.`,
        `Pick another tone or fill, ${large ? "" : "make it size l or xl, "}or change the colors in the palette.`,
      ),
    ];
  }
  return [];
}

const overlap = (a: Template["slots"][number]["frame"], b: Template["slots"][number]["frame"]): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * A sound template's facts: slot ids are unique and their frames lie on the slide, each slot takes only blocks its
 * role allows and a claim slot none, there is one claim slot at most, the style a slot gives its blocks exists and is
 * for every kind the slot takes (a claim is drawn as a heading), its background image exists, and text reads on its
 * background color on each of `looks`, in the template's own color and in the tone of each slot's style. Slots that overlap are a warning: a designer may mean it. An image background is a
 * warning too: only `depthcue render` can measure text on a picture.
 */
export function checkTemplate(
  template: Template,
  styles: Readonly<Record<string, BlockStyle>>,
  looks: readonly Look[],
  brandFiles: ReadonlySet<string>,
  file: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const background = template.background;
  const backdrop = background?.image === undefined ? background?.color : undefined;
  template.slots.forEach((slot, i) => {
    const at = `/slots/${i}`;
    const allowed = ROLE_KINDS[slot.role];
    const wrong = slot.accepts?.filter((kind) => !allowed.includes(kind)) ?? [];
    if (wrong.length > 0) {
      out.push(
        error(
          file,
          `${at}/accepts`,
          "slot-role-mismatch",
          slot.role === "claim"
            ? "A claim slot holds the scene's claim and takes no blocks."
            : `A ${slot.role} slot takes ${listed(allowed)}, not ${listed(wrong)}.`,
          slot.role === "claim"
            ? 'Remove "accepts", or give the slot another role.'
            : `Take ${listed(wrong)} out of "accepts", or make the role "content", which takes any block.`,
        ),
      );
    }
    if (slot.role === "claim" && template.slots.findIndex((other) => other.role === "claim") < i) {
      out.push(
        error(
          file,
          `${at}/role`,
          "two-claim-slots",
          "The template has another claim slot, and a scene has one claim.",
          "Give this slot another role.",
        ),
      );
    }
    if (seen.has(slot.id)) {
      out.push(
        error(
          file,
          `${at}/id`,
          "duplicate-id",
          `Two slots have the id "${slot.id}".`,
          "Give each slot its own id.",
        ),
      );
    }
    seen.add(slot.id);
    const { x, y, w, h } = slot.frame;
    if (x + w > 100 || y + h > 100) {
      out.push(
        error(
          file,
          `${at}/frame`,
          "frame-off-slide",
          `The slot runs to ${x + w}% across and ${y + h}% down; the slide ends at 100%.`,
          "Make x + w and y + h at most 100.",
        ),
      );
    }
    template.slots.slice(0, i).forEach((other, j) => {
      if (!overlap(slot.frame, other.frame)) return;
      out.push(
        warning(
          file,
          `${at}/frame`,
          "slots-overlap",
          `The slot "${slot.id}" overlaps "${other.id}" (slot ${j + 1}), so their blocks can draw over each other.`,
          "Move or shrink one of them. Leave it if the overlap is meant.",
        ),
      );
    });
    if (slot.style !== undefined) {
      const style = own(styles, slot.style);
      if (!style) {
        out.push(
          error(
            file,
            `${at}/style`,
            "unknown-style",
            `There is no style "${slot.style}".`,
            `Use one of: ${Object.keys(styles).join(", ") || "none: the brand has no styles"}.`,
          ),
        );
      } else {
        const missing = (slot.accepts ?? ["heading"]).filter(
          (kind) => !(style.for as readonly string[]).includes(kind),
        );
        if (missing.length > 0) {
          out.push(
            error(
              file,
              `${at}/style`,
              "style-wrong-kind",
              `The slot ${slot.accepts ? "takes" : "draws its claim as"} ${missing.join(", ")}, which the style "${slot.style}" is not for.`,
              "Pick a style made for every kind the slot takes, or take those kinds out of accepts.",
            ),
          );
        }
        // A tone with no fill under it is drawn on the background; a fill is checked with the brand's styles. A
        // claim slot has no blocks to check, and is large text, drawn as a heading.
        const tone = style.tone;
        if (backdrop !== undefined && tone !== undefined && (style.fill ?? "none") === "none") {
          const kinds = slot.accepts ?? ["heading"];
          const large =
            style.size === "l" || style.size === "xl" || kinds.every((kind) => kind === "heading");
          const need = large ? CONTRAST.large : CONTRAST.text;
          for (const { theme, colors } of looks) {
            const ratio = contrastRatio(colors[tone], colors[backdrop]);
            if (ratio >= need) continue;
            out.push(
              error(
                file,
                `${at}/style`,
                "template-low-contrast",
                `The slot "${slot.id}" draws its ${slot.role === "claim" ? "claim" : "text"} in "${tone}" (${colors[tone]}), the style "${slot.style}"'s tone, on "${backdrop}" (${colors[backdrop]}), a contrast of ${Math.floor(ratio * 100) / 100}:1 on ${theme} slides, under the ${need}:1 it needs.`,
                "Give the slot a style whose tone reads on the background, or pick another background color.",
              ),
            );
          }
        }
      }
    }
  });
  if (background?.image !== undefined) {
    if (!brandFiles.has(brandFilePath(background.image))) {
      out.push(
        error(
          file,
          "/background/image",
          "missing-brand-file",
          `${brandFilePath(background.image)} does not exist.`,
          "Add the image to the brand folder, or point at one that is there.",
        ),
      );
    }
    out.push(
      warning(
        file,
        "/background/image",
        "background-unmeasured",
        "Whether text on this picture can be read depends on the picture, so the files alone cannot say.",
        "Run depthcue render on a scene of this template. It measures the pixels under each line of text and reports background-low-contrast where the contrast falls short.",
      ),
    );
  } else if (background !== undefined) {
    const ink = textOn(background.color);
    for (const { theme, colors } of looks) {
      const ratio = contrastRatio(colors[ink], colors[background.color]);
      if (ratio >= CONTRAST.text) continue;
      out.push(
        error(
          file,
          "/background/color",
          "template-low-contrast",
          `Text on this template is drawn in "${ink}" (${colors[ink]}) on "${background.color}" (${colors[background.color]}), a contrast of ${Math.floor(ratio * 100) / 100}:1 on ${theme} slides, under the ${CONTRAST.text}:1 text needs.`,
          "Pick another background color, or change the two colors in the palette.",
        ),
      );
    }
  }
  return out;
}
