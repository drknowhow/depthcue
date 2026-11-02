/**
 * The parts of a PowerPoint file the brand comes from: where its presentation, master, layouts and theme are (a .thmx
 * keeps them under different names than a .pptx), the slide size, and what the master holds.
 */
import { firstOfKind, type OfficePackage, type Relationship, relationshipKind } from "./package.ts";
import { hasField, promptOf, type Shape, shapesOf } from "./shapes.ts";
import { type ColorMap, readColorMap, readTheme, type Theme } from "./theme.ts";
import { child, childrenNamed, descend, integer, type XmlNode } from "./xml.ts";

export type FileKind = "potx" | "pptx" | "thmx";

/** Where the parts are. A theme-only file has a theme and nothing else. */
export interface Located {
  kind: FileKind;
  theme?: Theme;
  presentation?: string;
  /** The master the brand is taken from, and how many masters the file has. */
  master?: string;
  masters: string[];
  /** The slide parts, in order, when the file has slides. */
  slides: string[];
  /** The theme variants a .thmx carries, which are other color sets of the same theme. */
  variants: number;
}

const OFFICE_DOCUMENT = "officeDocument";

/**
 * Finds the parts. A .pptx or .potx names its presentation from the package's own relationships. A .thmx names a theme
 * manager there, and the presentation, when it has one, through the manager's relationships; a bare theme has only the
 * theme. When the relationships do not lead anywhere, a part named like a theme is used.
 */
export async function locate(pkg: OfficePackage, kind: FileKind): Promise<Located> {
  const root = await pkg.rels("");
  let presentation: string | undefined;
  let themePart: string | undefined;
  const main = firstOfKind(root, OFFICE_DOCUMENT)?.target;
  if (main) {
    const direct = await pkg.xml(main);
    if (direct?.name === "presentation") presentation = main;
    else {
      const rels = await pkg.rels(main);
      const next = firstOfKind(rels, OFFICE_DOCUMENT)?.target;
      if (next && (await pkg.xml(next))?.name === "presentation") presentation = next;
      themePart = firstOfKind(rels, "theme")?.target;
    }
  }
  const variants = pkg
    .names()
    .filter((name) => /^themeVariants\/variant\d+\/theme\/theme\/theme\d*\.xml$/i.test(name)).length;
  let master: string | undefined;
  let masters: string[] = [];
  let slides: string[] = [];
  if (presentation) {
    const rels = await pkg.rels(presentation);
    const root = await pkg.xml(presentation);
    const order = (list: string, item: string) =>
      childrenNamed(child(root, list), item).flatMap((node) => {
        const target = rels.find((rel) => rel.id === node.attrs["r:id"])?.target;
        return target ? [target] : [];
      });
    masters = order("sldMasterIdLst", "sldMasterId");
    if (masters.length === 0)
      masters = rels
        .filter((rel) => relationshipKind(rel) === "slideMaster")
        .flatMap((rel) => (rel.target ? [rel.target] : []));
    slides = order("sldIdLst", "sldId");
    master = masters[0];
    // When the file has slides, the master the first one uses is the one the deck is drawn with.
    const first = slides[0];
    if (first) {
      const layout = firstOfKind(await pkg.rels(first), "slideLayout")?.target;
      const used = layout ? firstOfKind(await pkg.rels(layout), "slideMaster")?.target : undefined;
      if (used && masters.includes(used)) master = used;
    }
  }
  if (!themePart && master) themePart = firstOfKind(await pkg.rels(master), "theme")?.target;
  themePart ??= pkg
    .names()
    .filter((name) => /(^|\/)theme\/theme\d*\.xml$/i.test(name) && !/^themeVariants\//i.test(name))
    .sort()[0];
  const themeRoot = themePart ? await pkg.xml(themePart) : undefined;
  const theme = themeRoot ? readTheme(themeRoot) : undefined;
  return {
    kind,
    ...(theme ? { theme } : {}),
    ...(presentation ? { presentation } : {}),
    ...(master ? { master } : {}),
    masters,
    slides,
    variants,
  };
}

/** The slide size in EMU, from the presentation. Undefined when there is no presentation or it names no size. */
export async function slideSize(
  pkg: OfficePackage,
  presentation: string | undefined,
): Promise<{ w: number; h: number } | undefined> {
  const root = presentation ? await pkg.xml(presentation) : undefined;
  const size = child(root, "sldSz");
  const [w, h] = [integer(size, "cx"), integer(size, "cy")];
  return w && h ? { w, h } : undefined;
}

/** The names of the fonts a presentation embeds, from its font list. */
export async function embeddedFonts(pkg: OfficePackage, presentation: string | undefined): Promise<string[]> {
  const root = presentation ? await pkg.xml(presentation) : undefined;
  const names = childrenNamed(child(root, "embeddedFontLst"), "embeddedFont").flatMap((font) => {
    const face = child(font, "font")?.attrs.typeface;
    return face ? [face] : [];
  });
  const parts = pkg.names().filter((name) => /\.fntdata$/i.test(name));
  // The list names the faces; if it is missing, the parts are all there is to go on.
  return names.length > 0 ? names : parts.map((part) => part.slice(part.lastIndexOf("/") + 1));
}

export interface Master {
  part: string;
  shapes: Shape[];
  /** The `p:bg` element, when the master sets a background. */
  background: XmlNode | undefined;
  map: ColorMap;
  rels: Relationship[];
  /** The layouts in the order the master lists them. */
  layouts: string[];
}

export async function readMaster(pkg: OfficePackage, part: string): Promise<Master | undefined> {
  const root = await pkg.xml(part);
  if (!root) return undefined;
  const rels = await pkg.rels(part);
  const listed = childrenNamed(child(root, "sldLayoutIdLst"), "sldLayoutId").flatMap((node) => {
    const target = rels.find((rel) => rel.id === node.attrs["r:id"])?.target;
    return target ? [target] : [];
  });
  const layouts =
    listed.length > 0
      ? listed
      : rels
          .filter((rel) => relationshipKind(rel) === "slideLayout")
          .flatMap((rel) => (rel.target ? [rel.target] : []));
  return {
    part,
    shapes: shapesOf(descend(root, "cSld", "spTree")),
    background: descend(root, "cSld", "bg"),
    map: readColorMap(child(root, "clrMap")),
    rels,
    layouts,
  };
}

export interface Layout {
  part: string;
  name: string;
  type: string | undefined;
  /** False when the layout turns off the master's shapes, which include its logo. */
  showsMasterShapes: boolean;
  shapes: Shape[];
  background: XmlNode | undefined;
  /** The color map this layout overrides the master's with, when it does. */
  map: ColorMap | undefined;
  rels: Relationship[];
}

export async function readLayout(pkg: OfficePackage, part: string): Promise<Layout | undefined> {
  const root = await pkg.xml(part);
  if (root?.name !== "sldLayout") return undefined;
  const name = descend(root, "cSld")?.attrs.name?.replace(/\s+/g, " ").trim();
  const override = descend(root, "clrMapOvr", "overrideClrMapping");
  return {
    part,
    name: name || part.slice(part.lastIndexOf("/") + 1).replace(/\.xml$/i, ""),
    type: root.attrs.type,
    showsMasterShapes: root.attrs.showMasterSp !== "0",
    shapes: shapesOf(descend(root, "cSld", "spTree")),
    background: descend(root, "cSld", "bg"),
    map: override ? readColorMap(override) : undefined,
    rels: await pkg.rels(part),
  };
}

/** How many slides are read for words the master and its layouts do not have: the first ones, in the deck's order. */
export const SLIDES_READ = 20;

/** The shapes of the first `SLIDES_READ` of these slides. A part that is not a slide is left out. */
export async function readSlideShapes(pkg: OfficePackage, slides: readonly string[]): Promise<Shape[][]> {
  const out: Shape[][] = [];
  for (const part of slides.slice(0, SLIDES_READ)) {
    const root = await pkg.xml(part);
    if (root?.name === "sld") out.push(shapesOf(descend(root, "cSld", "spTree")));
  }
  return out;
}
/** Where a footer or a slide number sits along the bottom: the third of the slide its center is in. */
export const placeOf = (shape: Shape, slideWidth: number): "start" | "center" | "end" | undefined => {
  if (!shape.box) return undefined;
  const across = (shape.box.x + shape.box.w / 2) / slideWidth;
  return across < 1 / 3 ? "start" : across > 2 / 3 ? "end" : "center";
};

/** What the master's footer and slide number placeholders say, for the brand's chrome. */
export interface MasterChrome {
  footer?: { text: string; place: "start" | "center" | "end" };
  number?: { place: "start" | "center" | "end" };
  /** Things worth a line: a footer with no text, a date placeholder. */
  notes: string[];
  hasDate: boolean;
}

/**
 * The footer and the slide number of the master. The footer's text is the master's own, or else the first layout's or
 * slide's that has one (the master's placeholder is often empty, and the words are on the layouts and the slides).
 */
export function chromeOfMaster(master: Master, others: readonly Shape[][], slideWidth: number): MasterChrome {
  const notes: string[] = [];
  const typed = (shapes: readonly Shape[], type: string) =>
    shapes.find((shape) => shape.placeholder?.type === type);
  const footer = typed(master.shapes, "ftr");
  const number = typed(master.shapes, "sldNum");
  const out: MasterChrome = { notes, hasDate: typed(master.shapes, "dt") !== undefined };
  if (footer) {
    const text = [footer, ...others.flatMap((shapes) => typed(shapes, "ftr") ?? [])]
      .map(promptOf)
      .find((value) => value !== undefined);
    const place = placeOf(footer, slideWidth);
    if (text && place) out.footer = { text: text.slice(0, 120), place };
    else
      notes.push(
        "The master has a footer placeholder with no text in it, so the brand has no footer line; the words are typed on each slide in PowerPoint.",
      );
  }
  if (number && (hasField(number, "slidenum") || promptOf(number) === undefined)) {
    const place = placeOf(number, slideWidth);
    if (place) out.number = { place };
  } else if (number) {
    notes.push(
      "The master's slide number placeholder holds plain text, not a number field, so the brand has no slide number.",
    );
  }
  return out;
}
