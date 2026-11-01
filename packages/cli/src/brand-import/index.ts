/**
 * `depthcue brand import <file>`: a PowerPoint template, presentation or theme as a Depthcue brand folder. The theme's
 * colors and fonts, the master's logo, footer and slide number, and each layout as a template are taken; what is not is
 * listed, with the reason. The brand is checked with the brand checks before anything is written, so a brand that fails
 * them is never produced.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
  type Brand,
  BUILT_IN_TEMPLATES,
  brandFilePath,
  checkBrand,
  checkBrandFile,
  checkTemplateFile,
  type Deck,
  type Diagnostic,
  type Template,
  type ThemeName,
} from "@depthcue/core";
import { readFonts } from "./fonts.ts";
import { chooseLogo, formatOf, type LogoCandidate, type LogoChoice } from "./logo.ts";
import {
  chromeOfMaster,
  embeddedFonts,
  type FileKind,
  type Layout,
  locate,
  type Master,
  readLayout,
  readMaster,
  slideSize,
} from "./master.ts";
import { OfficePackage, PackageError } from "./package.ts";
import { buildPalette, shownRatio } from "./palette.ts";
import { svgProblem } from "./svg.ts";
import { buildTemplate, fillOf, type TemplateContext, type TemplateResult } from "./templates.ts";
import { DEFAULT_COLOR_MAP, resolveColor } from "./theme.ts";
import type { ImportReport, Left } from "./types.ts";
import { IMPORT_MARKER, WriteError, writeBrand } from "./write.ts";
import { XmlError } from "./xml.ts";

export type { ImportReport } from "./types.ts";
export { IMPORT_FORMAT, IMPORT_MARKER } from "./write.ts";

/** Files bigger than this are not PowerPoint templates; refusing them first keeps a wrong file from filling memory. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export type ImportErrorCode =
  | "bad-file"
  | "unreadable"
  | "out-is-file"
  | "out-not-ours"
  | "out-edited"
  | "out-in-source"
  | "write-failed";

/** The import could not run, as opposed to the file having nothing to import. The message says what to change. */
export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ImportRequest {
  file: string;
  /** Where the brand folder goes. Default: `<file name>-brand` in the current directory. */
  out?: string;
}

export type ImportFailureCode = "no-theme" | "no-layout" | "portrait" | "brand-invalid";

export type ImportResult =
  | { ok: true; report: ImportReport; diagnostics: Diagnostic[] }
  | {
      ok: false;
      code: ImportFailureCode;
      message: string;
      /** Why each layout was skipped, when the file had layouts and none could be used. */
      left: Left[];
      diagnostics: Diagnostic[];
    };

const KINDS: Readonly<Record<string, FileKind>> = { ".potx": "potx", ".pptx": "pptx", ".thmx": "thmx" };

/** A name as an id: lower case letters, digits and hyphens, starting with a letter, at most 64 characters. */
export function slug(text: string, fallback: string): string {
  const base = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  if (/^[a-z][a-z0-9-]+$/.test(base)) return base;
  return base ? `${fallback}-${base}`.slice(0, 64).replace(/-+$/, "") : fallback;
}

/** The id with `-2`, `-3` and so on added until it is not taken. */
function unique(id: string, taken: ReadonlySet<string>): string {
  let candidate = id;
  for (let n = 2; taken.has(candidate); n++) candidate = `${id.slice(0, 60)}-${n}`;
  return candidate;
}

const RATIOS: ReadonlyArray<readonly [number, number]> = [
  [16, 9],
  [4, 3],
  [16, 10],
  [3, 2],
  [5, 4],
  [21, 9],
  [1, 1],
];

/** A slide's shape as a ratio people know ("4:3"), or a decimal when it is none of them. */
export function ratioLabel(width: number, height: number): string {
  const shape = width / height;
  const near = RATIOS.find(([w, h]) => Math.abs(shape / (w / h) - 1) < 0.01);
  return near ? `${near[0]}:${near[1]}` : `${shape.toFixed(2)}:1`;
}

/** A widescreen slide, 13.333 by 7.5 inches, for a theme file that names no size. */
const DEFAULT_SLIDE = { w: 12192000, h: 6858000 } as const;

const failure = (
  code: ImportFailureCode,
  message: string,
  left: Left[] = [],
  diagnostics: Diagnostic[] = [],
): ImportResult => ({ ok: false, code, message, left, diagnostics });

const jsonOf = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface Source {
  source: string;
  kind: FileKind;
  stem: string;
  out: string;
  fileName: string;
}

export async function importBrand(request: ImportRequest): Promise<ImportResult> {
  const source = resolve(request.file);
  const kind = KINDS[extname(source).toLowerCase()];
  if (!kind) {
    throw new ImportError(
      "bad-file",
      `${request.file} does not end in .potx, .pptx or .thmx, the PowerPoint files a brand can be imported from.`,
    );
  }
  let bytes: Uint8Array;
  try {
    if (statSync(source).size > MAX_FILE_BYTES) {
      throw new ImportError(
        "bad-file",
        `${request.file} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, which no PowerPoint template is.`,
      );
    }
    bytes = readFileSync(source);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("unreadable", `Could not read ${request.file}: ${(error as Error).message}`);
  }
  const stem = basename(source, extname(source));
  try {
    const pkg = await OfficePackage.open(bytes);
    return await importFrom(pkg, {
      source,
      kind,
      stem,
      out: resolve(request.out ?? `${stem}-brand`),
      fileName: basename(source),
    });
  } catch (error) {
    if (error instanceof PackageError || error instanceof XmlError) {
      throw new ImportError("unreadable", `${request.file}: ${error.message}`);
    }
    if (error instanceof WriteError) throw new ImportError(error.code, error.message);
    throw error;
  }
}

/** The pictures a master holds, or else the title layout's, as logo candidates. */
function logoCandidates(
  master: Master,
  layouts: readonly Layout[],
): { list: LogoCandidate[]; layout?: Layout } {
  const own = master.shapes.filter((shape) => shape.kind === "picture");
  if (own.length > 0)
    return { list: own.map((shape) => ({ shape, rels: master.rels, where: "the slide master" })) };
  const title =
    layouts.find((layout) => layout.type === "title") ??
    layouts.find((layout) => /title slide/i.test(layout.name));
  if (!title) return { list: [] };
  const list = title.shapes
    .filter((shape) => shape.kind === "picture")
    .map((shape) => ({ shape, rels: title.rels, where: `the layout "${title.name}"` }));
  return { list, layout: title };
}

/** The stock name for a picture file in the brand's `images/` folder: its part's name, made safe. */
const imageStem = (part: string): string =>
  basename(part, extname(part))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "") || "background";

const isWebp = (data: Uint8Array): boolean =>
  new TextDecoder("latin1").decode(data.subarray(0, 4)) === "RIFF" &&
  new TextDecoder("latin1").decode(data.subarray(8, 12)) === "WEBP";

async function importFrom(pkg: OfficePackage, input: Source): Promise<ImportResult> {
  const found = await locate(pkg, input.kind);
  const theme = found.theme;
  if (!theme) {
    return failure(
      "no-theme",
      "The file has no theme with a color scheme, so there is nothing to build a brand from.",
    );
  }
  const slide = (await slideSize(pkg, found.presentation)) ?? DEFAULT_SLIDE;
  if (slide.h > slide.w) {
    return failure(
      "portrait",
      `The slides are portrait (${slide.w} by ${slide.h} EMU), and Depthcue slides are 16:9 landscape, so no brand was made. Set the slide size to widescreen in PowerPoint (Design, Slide Size) and import again.`,
    );
  }

  const master = found.master ? await readMaster(pkg, found.master) : undefined;
  // One at a time, so only one part is unpacked at once: the limits are counted as the parts come out.
  const layouts: Layout[] = [];
  for (const part of master?.layouts ?? []) {
    const layout = await readLayout(pkg, part);
    if (layout) layouts.push(layout);
  }
  // A theme file may carry no layouts at all. A presentation or template with none has nothing to import.
  if (input.kind !== "thmx" && layouts.length === 0) {
    return failure("no-layout", "The file has no slide layouts, so there is nothing to make templates from.");
  }

  const left: Left[] = [];
  const notes: string[] = [];
  const files = new Map<string, Uint8Array | string>();

  // Colors. The master's background says which preset the slides use; a picture or a gradient is not a color.
  const map = master?.map ?? DEFAULT_COLOR_MAP;
  const masterFill = fillOf(master?.background, theme);
  const background = masterFill.color ? resolveColor(masterFill.color, theme, map) : undefined;
  const backgroundNote =
    masterFill.kind !== undefined && masterFill.kind !== "solidFill"
      ? `The master's background is a ${masterFill.kind.replace(/Fill$/, "")} fill, which is not a color, so the theme's background color was used.`
      : background && !background.plain
        ? "The master's background is a theme color made lighter or darker, which is not worked out, so the theme's own background color was used."
        : undefined;
  const palette = buildPalette({ theme, map, background, backgroundNote });
  const brandName = input.stem.replace(/\s+/g, " ").trim().slice(0, 80) || "Imported brand";
  const brandId = slug(input.stem, "imported-brand");
  notes.push(
    `These colors are for decks with the theme "${palette.preset}": set "theme": "${palette.preset}" in deck.json. The other theme keeps Depthcue's own colors.`,
  );
  notes.push(...palette.notes);
  if (input.kind !== "thmx" && Math.abs(slide.w / slide.h / (16 / 9) - 1) > 0.01) {
    notes.push(
      `The slides are ${ratioLabel(slide.w, slide.h)} (${slide.w} by ${slide.h} EMU) and Depthcue's are 16:9, so every frame was scaled: each keeps its place as a share of the slide, and the slide is stretched to 16:9 with it.`,
    );
  }

  // Fonts.
  const fonts = readFonts(theme.fonts);
  notes.push(...fonts.notes);
  const embedded = await embeddedFonts(pkg, found.presentation);
  if (embedded.length > 0) {
    left.push({
      what: `Embedded font files (${embedded.join(", ")})`,
      why: "they are Embedded OpenType, often licensed for use in that one file only, so they are not copied; install the fonts, or add files whose license allows it to the brand",
    });
  }

  // Logo.
  let logo: LogoChoice = { skipped: [] };
  let logoLayout: Layout | undefined;
  if (master) {
    const candidates = logoCandidates(master, layouts);
    logoLayout = candidates.layout;
    logo = await chooseLogo(pkg, candidates.list, slide, brandName);
    for (const picture of logo.skipped) {
      left.push({ what: `The picture "${picture.name}" on ${picture.where}`, why: picture.why });
    }
    if (logo.logo && logoLayout) {
      notes.push(
        `The logo was on the layout "${logoLayout.name}", not the master. Depthcue shows it on every template that shows the brand's chrome.`,
      );
    }
  }
  if (logo.logo) files.set(logo.logo.file, logo.logo.bytes);

  // Chrome: the logo's place, and the master's footer and slide number.
  const parts = master
    ? chromeOfMaster(
        master,
        layouts.map((layout) => layout.shapes),
        slide.w,
      )
    : undefined;
  notes.push(...(parts?.notes ?? []));
  const chrome = {
    ...(logo.logo ? { logo: { corner: logo.logo.corner, size: logo.logo.size } } : {}),
    ...(parts?.footer ? { footer: parts.footer } : {}),
    ...(parts?.number ? { number: parts.number } : {}),
  };

  // Templates.
  const imageFiles = new Map<string, string>();
  const context: TemplateContext = {
    pkg,
    slide,
    masterShapes: master?.shapes ?? [],
    theme,
    map,
    palette: palette.colors,
    addImage(part, data) {
      const format = formatOf(data);
      const ext =
        format === "png"
          ? "png"
          : format === "jpeg"
            ? "jpg"
            : format === "svg"
              ? "svg"
              : isWebp(data)
                ? "webp"
                : undefined;
      if (!ext) {
        const what = format === "unknown" ? "one this does not know" : format.toUpperCase();
        return {
          why: `its picture is in a format a template's background cannot be (${what}); use PNG, JPEG, WebP or SVG`,
        };
      }
      const problem = ext === "svg" ? svgProblem(new TextDecoder().decode(data)) : undefined;
      if (problem) return { why: `its SVG has ${problem}, which a template's background may not` };
      const known = imageFiles.get(part);
      if (known) return { file: known };
      let file = `images/${imageStem(part)}.${ext}`;
      for (let n = 2; files.has(file); n++) file = `images/${imageStem(part)}-${n}.${ext}`;
      imageFiles.set(part, file);
      files.set(file, data);
      return { file };
    },
  };
  const templates: Record<string, Template> = {};
  const built: Array<{ id: string; result: TemplateResult }> = [];
  const taken = new Set<string>();
  for (const layout of layouts) {
    const id = unique(slug(layout.name, "layout"), taken);
    const result = await buildTemplate(layout, id, context);
    left.push(...result.left);
    if (!result.template) {
      left.push({ what: `The layout "${layout.name}"`, why: `it is not a template: ${result.skipped}` });
      continue;
    }
    taken.add(id);
    templates[id] = result.template;
    built.push({ id, result });
    if (Object.hasOwn(BUILT_IN_TEMPLATES, id)) {
      notes.push(
        `The template "${id}" has the id of one of Depthcue's own, so decks of this brand get yours instead.`,
      );
    }
  }
  if (layouts.length > 0 && built.length === 0) {
    return failure(
      "no-layout",
      "None of the file's slide layouts can be a template, so there is nothing to make templates from. The reasons are listed below.",
      left,
    );
  }

  // Assemble the brand, and check it as a deck would before anything is written.
  const brand: Brand = {
    schemaVersion: "0.4",
    id: brandId,
    name: brandName,
    colors: {
      [palette.preset]: {
        bg: palette.colors.bg,
        surface: palette.colors.surface,
        line: palette.colors.line,
        text: palette.colors.text,
        muted: palette.colors.muted,
        action: palette.colors.action,
        evidence: palette.colors.evidence,
        ...(palette.chart.colors.length > 0 ? { chart: palette.chart.colors } : {}),
      },
    },
    ...(fonts.fonts
      ? {
          fonts: {
            display: { family: fonts.fonts.display.family },
            body: { family: fonts.fonts.body.family },
            fallback: fonts.fonts.fallback,
          },
        }
      : {}),
    ...(logo.logo
      ? { logos: { [palette.preset === "ink" ? "dark" : "light"]: logo.logo.file, alt: logo.logo.alt } }
      : {}),
    ...(Object.keys(chrome).length > 0 ? { chrome } : {}),
  };
  if (palette.chart.colors.length === 0) {
    notes.push(
      "No accent reaches 3:1 on the background, so the brand has no chart colors and charts take the palette's.",
    );
  }
  const checked = checkAll(brand, templates, files, left);
  if (!checked.ok) {
    return failure(
      "brand-invalid",
      "The brand made from this file does not pass Depthcue's brand checks, so nothing was written. This is a fault in the import; the checks it failed are listed.",
      left,
      checked.errors,
    );
  }

  const output = new Map<string, Uint8Array | string>([["brand.json", jsonOf(brand)]]);
  for (const [id, template] of Object.entries(templates))
    output.set(`templates/${id}.json`, jsonOf(template));
  for (const [path, data] of files) output.set(path, data);
  const { removed } = writeBrand(input.out, input.source, output);

  // What the master and the layouts draw besides placeholders and the logo is not copied.
  const logoOnMaster = logo.logo && !logoLayout ? 1 : 0;
  const logoOnLayout = logo.logo && logoLayout ? 1 : 0;
  const shapes =
    (master?.shapes.filter((shape) => shape.kind === "other").length ?? 0) +
    built.reduce((sum, { result }) => sum + result.decoration.shapes, 0);
  const pictures =
    (master?.shapes.filter((shape) => shape.kind === "picture").length ?? 0) -
    logoOnMaster +
    built.reduce((sum, { result }) => sum + result.decoration.pictures, 0) -
    logoOnLayout;
  if (shapes + pictures > 0) {
    left.push({
      what: `Decoration: ${shapes} shape${shapes === 1 ? "" : "s"} and ${pictures} picture${pictures === 1 ? "" : "s"} on the master and the layouts`,
      why: "a template holds slots, a background and the brand's chrome; drawn bars, lines and artwork are not copied",
    });
  }
  const generic = [...new Set(built.flatMap(({ result }) => result.generic))];
  if (generic.length > 0) {
    notes.push(`Placeholders of the type ${generic.join(", ")} became content slots, which take any block.`);
  }
  if (master) {
    left.push({
      what: "The master's text styles (sizes, weights, bullets, spacing)",
      why: "Depthcue sets text by role, not by a master's text styles",
    });
  }
  if (parts?.hasDate) {
    left.push({
      what: "The date placeholder",
      why: "Depthcue slides have no date; only the footer and the slide number are chrome",
    });
  }
  if (built.length > 0) {
    left.push({
      what: "Claim slots",
      why: "PowerPoint has no placeholder for a claim, so no imported template has one; add a claim slot to a template where a scene's claim should go",
    });
  }
  if (found.slides.length > 0) {
    const n = found.slides.length;
    left.push({
      what: `${n} slide${n === 1 ? "" : "s"}`,
      why: "their content is not imported; only the master, layouts and theme they use are",
    });
  }
  if (found.masters.length > 1) {
    const n = found.masters.length - 1;
    left.push({
      what: `${n} other slide master${n === 1 ? "" : "s"}`,
      why: "a brand is taken from one master, the one the first slide uses or else the first listed",
    });
  }
  if (found.variants > 0) {
    left.push({
      what: `${found.variants} theme variant${found.variants === 1 ? "" : "s"}`,
      why: "they are other color sets of the same theme; the theme's own is imported",
    });
  }

  const report: ImportReport = {
    source: {
      file: input.fileName,
      kind: input.kind,
      ...(theme.name ? { theme: theme.name } : {}),
      slide: { width: slide.w, height: slide.h, ratio: ratioLabel(slide.w, slide.h) },
    },
    out: input.out,
    brand: { id: brandId, name: brandName },
    preset: { name: palette.preset, why: palette.presetWhy },
    colors: palette.taken,
    kept: palette.kept.map((kept) => ({ ...kept, ratio: shownRatio(kept.ratio) })),
    chart:
      palette.chart.colors.length > 0
        ? { colors: palette.chart.colors, from: palette.chart.from.map(String) }
        : null,
    fonts: fonts.fonts
      ? {
          display: {
            family: fonts.fonts.display.family,
            kind: fonts.fonts.display.kind.kind,
            rule: fonts.fonts.display.kind.rule,
          },
          body: {
            family: fonts.fonts.body.family,
            kind: fonts.fonts.body.kind.kind,
            rule: fonts.fonts.body.kind.rule,
          },
          fallback: fonts.fonts.fallback,
          fallbackRule: fonts.fonts.fallbackRule,
        }
      : null,
    logo: logo.logo
      ? {
          file: logo.logo.file,
          corner: logo.logo.corner,
          size: logo.logo.size,
          alt: logo.logo.alt,
          from: logo.logo.from,
        }
      : null,
    chrome: {
      ...(logo.logo ? { logo: `${logo.logo.corner}, size ${logo.logo.size}` } : {}),
      ...(parts?.footer ? { footer: `"${parts.footer.text}" at the ${parts.footer.place}` } : {}),
      ...(parts?.number ? { number: `at the ${parts.number.place}` } : {}),
    },
    templates: built.map(({ id, result }) => {
      const template = templates[id] as Template;
      const bg = template.background;
      return {
        id,
        name: template.name,
        layout: result.layout,
        slots: result.slots,
        ...(bg
          ? { background: bg.image ? `${bg.image} under a ${bg.scrim}% ${bg.color} scrim` : bg.color }
          : {}),
        ...(template.chrome ? { chrome: template.chrome } : {}),
      };
    }),
    files: [...output.keys(), IMPORT_MARKER].sort(),
    removed,
    left,
    notes,
  };
  return { ok: true, report, diagnostics: checked.warnings };
}

/** The deck the checks run against: one that names the brand, in the given theme. */
const deckFor = (brand: Brand, theme: ThemeName): Deck => ({
  schemaVersion: "0.4",
  id: "brand-import-check",
  title: "Brand import check",
  language: "en",
  theme,
  brand: brand.id,
  scenes: ["check"],
});

const sameFinding = (diagnostic: Diagnostic) =>
  `${diagnostic.file}|${diagnostic.path}|${diagnostic.code}|${diagnostic.message}`;

/**
 * Runs the brand checks on the brand and its templates, with a paper deck and an ink one, so a color that reads on the
 * preset it was made for and fails on the other is found too. A template background that text cannot be read on is the
 * one thing taken out, and reported; any other error means the import itself is wrong.
 */
function checkAll(
  brand: Brand,
  templates: Record<string, Template>,
  files: ReadonlyMap<string, unknown>,
  left: Left[],
): { ok: true; warnings: Diagnostic[] } | { ok: false; errors: Diagnostic[] } {
  const brandFiles = new Set([...files.keys()].map(brandFilePath));
  for (let pass = 0; pass <= Object.keys(templates).length; pass++) {
    const structure = [
      ...checkBrandFile(brand),
      ...Object.entries(templates).flatMap(([id, template]) => checkTemplateFile(template, id)),
    ];
    if (structure.length > 0) return { ok: false, errors: structure };
    const found = new Map<string, Diagnostic>();
    for (const theme of ["paper", "ink"] as const) {
      for (const diagnostic of checkBrand(deckFor(brand, theme), { brand, templates }, brandFiles)) {
        found.set(sameFinding(diagnostic), { ...diagnostic, file: diagnostic.file.replace(/^brand\//, "") });
      }
    }
    const diagnostics = [...found.values()];
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length === 0) return { ok: true, warnings: diagnostics };
    const unreadable = errors.filter((diagnostic) => diagnostic.code === "template-low-contrast");
    if (unreadable.length < errors.length) return { ok: false, errors };
    for (const diagnostic of unreadable) {
      const id = /^templates\/(.+)\.json$/.exec(diagnostic.file)?.[1];
      const template = id === undefined ? undefined : templates[id];
      if (id === undefined || !template?.background) continue;
      const { background: _background, ...rest } = template;
      templates[id] = rest;
      left.push({ what: `The background of the layout "${template.name}"`, why: diagnostic.message });
    }
  }
  return { ok: false, errors: [] };
}
