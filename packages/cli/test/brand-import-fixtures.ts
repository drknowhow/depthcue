// PowerPoint files for the brand import tests, built in the test from nothing: a .potx, .pptx or .thmx is a zip of XML
// parts, so each test says what it needs (a dark theme, a 4:3 slide, a logo in a JPEG, an embedded font) and gets a file
// with exactly that. No Microsoft theme or template is in the repository, and none is needed to test the import.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Diagnostic } from "@depthcue/core";
import JSZip from "jszip";
import { afterEach } from "vitest";
import { type ImportReport, importBrand } from "../src/brand-import/index.ts";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`;

export interface Colors {
  dk1: string;
  lt1: string;
  dk2: string;
  lt2: string;
  accent1: string;
  accent2: string;
  accent3: string;
  accent4: string;
  accent5: string;
  accent6: string;
  hlink: string;
  folHlink: string;
}

/** A light theme whose every color reads on its background, so an import of it keeps every one. */
export const LIGHT: Colors = {
  dk1: "1B1B1B",
  lt1: "FFFFFF",
  dk2: "44546A",
  lt2: "F3F1EC",
  accent1: "B23A48",
  accent2: "2F6690",
  accent3: "3A7D44",
  accent4: "C77D0A",
  accent5: "6C4A9E",
  accent6: "007C89",
  hlink: "0B5FA5",
  folHlink: "6B3FA0",
};

/** A dark theme, whose master maps its dark colors to background and its light ones to text. */
export const DARK: Colors = {
  dk1: "0E1116",
  lt1: "F2F4F8",
  dk2: "1C2330",
  lt2: "C9D1DE",
  accent1: "4FB3FF",
  accent2: "FFB347",
  accent3: "6FD08C",
  accent4: "E86A92",
  accent5: "B9A3FF",
  accent6: "5ED3C8",
  hlink: "8CC4FF",
  folHlink: "C3A8FF",
};

/** A box as percent of the slide. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ShapeSpec =
  | {
      kind: "ph";
      /** The placeholder type: `title`, `ctrTitle`, `subTitle`, `body`, `pic`, `chart`, `tbl`, `dt`, `ftr`, `sldNum`; none is an object. */
      type?: string;
      idx?: number;
      name?: string;
      /** Left out, the placeholder takes its place from the master. */
      frame?: Frame;
      text?: string;
      anchor?: "t" | "ctr" | "b";
      vert?: string;
      /** A field in the text, such as `slidenum`. */
      field?: string;
      rotated?: boolean;
    }
  | {
      kind: "pic";
      name: string;
      descr?: string;
      frame: Frame;
      /** The media file the picture shows, a key of the package's `media`. */
      media: string;
      cropped?: boolean;
      flipped?: boolean;
    }
  | { kind: "shape"; name: string; frame: Frame };

export type BgSpec =
  | { scheme: string; adjust?: boolean }
  | { rgb: string }
  | { gradient: true }
  | { picture: string }
  | { none: true };

export interface LayoutSpec {
  name: string;
  type?: string;
  /** False writes `showMasterSp="0"`. */
  showMasterShapes?: boolean;
  shapes: ShapeSpec[];
  bg?: BgSpec;
}

export interface PackageSpec {
  kind?: "potx" | "pptx" | "thmx";
  themeName?: string;
  colors?: Colors;
  /** The theme's heading and body fonts, with their PANOSE numbers when given. */
  fonts?: { major?: string; minor?: string; majorPanose?: string; minorPanose?: string };
  /** The slide, in EMU. Default 16:9 widescreen. */
  size?: { cx: number; cy: number };
  /** The master maps `lt1` to text and `dk1` to background. */
  dark?: boolean;
  masterBg?: BgSpec;
  master?: ShapeSpec[];
  layouts?: LayoutSpec[];
  /** Pictures by their name under `media/`. */
  media?: Record<string, Uint8Array>;
  /** Faces to embed: the presentation lists them and the package holds a `.fntdata` part for each. */
  embeddedFonts?: string[];
  /** How many slides, each on the first layout. */
  slides?: number;
  /** Masters beyond the first. */
  extraMasters?: number;
  /** Theme variants, as a .thmx carries. */
  variants?: number;
  /** A .thmx with a theme and nothing else: no presentation, master or layout. */
  themeOnly?: boolean;
  /** Leave out the color scheme, so the file has no usable theme. */
  noColors?: boolean;
}

const SLIDE = { cx: 12192000, cy: 6858000 };

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ----------------------------------------------------------------------------------------------- pictures

const base64 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "base64"));

/** A 1 by 1 PNG. */
export const PNG: Uint8Array = base64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

/** The start of a JPEG of this size: the markers a reader needs for its size, and a few bytes of image data. */
export function jpeg(width: number, height: number): Uint8Array {
  const bytes = [
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    0xff,
    0xd9,
  ];
  return Uint8Array.from(bytes);
}

/** The header of an EMF file: the signature at the start and ` EMF` at byte 40. */
export const EMF: Uint8Array = (() => {
  const bytes = new Uint8Array(88);
  bytes[0] = 1;
  bytes.set([0x20, 0x45, 0x4d, 0x46], 40);
  return bytes;
})();

/** The start of a GIF. */
export const GIF: Uint8Array = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]);

export const svg = (body = '<circle cx="5" cy="5" r="4"/>'): Uint8Array =>
  new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);

/** An SVG with a script in it, which a logo may not have. */
export const SCRIPTED_SVG: Uint8Array = svg('<script>alert(1)</script><circle cx="5" cy="5" r="4"/>');

// ---------------------------------------------------------------------------------------------- the parts

const emu = (percent: number, of: number): number => Math.round((percent / 100) * of);

function xfrm(frame: Frame, size: { cx: number; cy: number }, extra = ""): string {
  return `<a:xfrm${extra}><a:off x="${emu(frame.x, size.cx)}" y="${emu(frame.y, size.cy)}"/><a:ext cx="${emu(frame.w, size.cx)}" cy="${emu(frame.h, size.cy)}"/></a:xfrm>`;
}

/** The relationships a part's pictures need: media name to relationship id. */
type Embeds = Map<string, string>;

function shapeXml(spec: ShapeSpec, id: number, size: { cx: number; cy: number }, embeds: Embeds): string {
  if (spec.kind === "shape") {
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(spec.name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(spec.frame, size)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>`;
  }
  if (spec.kind === "pic") {
    const rid = embeds.get(spec.media);
    const crop = spec.cropped ? '<a:srcRect l="10000" t="5000"/>' : "";
    const descr = spec.descr === undefined ? "" : ` descr="${esc(spec.descr)}"`;
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(spec.name)}"${descr}/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(spec.frame, size, spec.flipped ? ' flipH="1"' : "")}</p:spPr></p:pic>`;
  }
  const type = spec.type === undefined ? "" : ` type="${spec.type}"`;
  const idx = spec.idx === undefined ? "" : ` idx="${spec.idx}"`;
  const anchor = spec.anchor ? ` anchor="${spec.anchor}"` : "";
  const vert = spec.vert ? ` vert="${spec.vert}"` : "";
  const place = spec.frame ? xfrm(spec.frame, size, spec.rotated ? ' rot="900000"' : "") : "";
  const text = spec.field
    ? `<a:fld id="{00000000-0000-0000-0000-000000000001}" type="${spec.field}"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld>`
    : spec.text === undefined
      ? ""
      : `<a:r><a:rPr lang="en-US"/><a:t>${esc(spec.text)}</a:t></a:r>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(spec.name ?? `${spec.type ?? "Content"} ${id}`)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${type}${idx}/></p:nvPr></p:nvSpPr><p:spPr>${place}</p:spPr><p:txBody><a:bodyPr${anchor}${vert}/><a:lstStyle/><a:p>${text}</a:p></p:txBody></p:sp>`;
}

function backgroundXml(bg: BgSpec | undefined, embeds: Embeds): string {
  if (!bg) return "";
  const wrap = (fill: string) => `<p:bg><p:bgPr>${fill}<a:effectLst/></p:bgPr></p:bg>`;
  if ("none" in bg) return wrap("<a:noFill/>");
  if ("scheme" in bg) {
    return wrap(
      `<a:solidFill><a:schemeClr val="${bg.scheme}">${bg.adjust ? '<a:lumMod val="95000"/>' : ""}</a:schemeClr></a:solidFill>`,
    );
  }
  if ("rgb" in bg) return wrap(`<a:solidFill><a:srgbClr val="${bg.rgb}"/></a:solidFill>`);
  if ("gradient" in bg) {
    return wrap(
      '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="112233"/></a:gs><a:gs pos="100000"><a:srgbClr val="334455"/></a:gs></a:gsLst></a:gradFill>',
    );
  }
  return wrap(
    `<a:blipFill><a:blip r:embed="${embeds.get(bg.picture)}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`,
  );
}

function treeXml(shapes: readonly ShapeSpec[], size: { cx: number; cy: number }, embeds: Embeds): string {
  const body = shapes.map((shape, at) => shapeXml(shape, at + 2, size, embeds)).join("");
  return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree>`;
}

/** The media names a set of shapes and a background show, in the order first used. */
function mediaOf(shapes: readonly ShapeSpec[], bg: BgSpec | undefined): string[] {
  const names = shapes.flatMap((shape) => (shape.kind === "pic" ? [shape.media] : []));
  if (bg && "picture" in bg) names.push(bg.picture);
  return [...new Set(names)];
}

const rels = (items: ReadonlyArray<{ id: string; type: string; target: string }>): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map((item) => `<Relationship Id="${item.id}" Type="${R}/${item.type}" Target="${item.target}"/>`)
    .join("")}</Relationships>`;

const KEYS = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;

function themeXml(spec: PackageSpec): string {
  const colors = spec.colors ?? LIGHT;
  const scheme = KEYS.map((key) => `<a:${key}><a:srgbClr val="${colors[key]}"/></a:${key}>`).join("");
  const font = (face: string | undefined, panose: string | undefined) =>
    face === undefined
      ? '<a:latin typeface=""/>'
      : `<a:latin typeface="${esc(face)}"${panose ? ` panose="${panose}"` : ""}/>`;
  const fonts = spec.fonts ?? {
    major: "Georgia",
    minor: "Calibri",
    majorPanose: "02040502050405020303",
    minorPanose: "020F0502020204030204",
  };
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="${A}" name="${esc(spec.themeName ?? "Harbor")}"><a:themeElements>${
    spec.noColors ? "" : `<a:clrScheme name="Harbor">${scheme}</a:clrScheme>`
  }<a:fontScheme name="Harbor"><a:majorFont>${font(fonts.major, fonts.majorPanose)}</a:majorFont><a:minorFont>${font(fonts.minor, fonts.minorPanose)}</a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill/><a:blipFill/></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

const CLR_MAP_LIGHT =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';
const CLR_MAP_DARK = CLR_MAP_LIGHT.replace(
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"',
  'bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"',
);

/** The standard master of the fixtures: a title, a body, a footer with words, a slide number field and a logo in the top corner. */
export const MASTER: ShapeSpec[] = [
  {
    kind: "ph",
    type: "title",
    name: "Title Placeholder 1",
    frame: { x: 8, y: 6, w: 78, h: 16 },
    text: "Click to edit Master title style",
  },
  {
    kind: "ph",
    type: "body",
    idx: 1,
    name: "Text Placeholder 2",
    frame: { x: 8, y: 26, w: 84, h: 60 },
    text: "Click to edit Master text styles",
  },
  {
    kind: "ph",
    type: "ftr",
    idx: 3,
    name: "Footer Placeholder 4",
    frame: { x: 34, y: 92, w: 32, h: 5 },
    text: "Harbor Co. confidential",
  },
  {
    kind: "ph",
    type: "sldNum",
    idx: 4,
    name: "Slide Number Placeholder 5",
    frame: { x: 88, y: 92, w: 6, h: 5 },
    field: "slidenum",
  },
  {
    kind: "pic",
    name: "Harbor logo",
    descr: "The Harbor Co. wordmark",
    frame: { x: 90, y: 5, w: 5, h: 9 },
    media: "logo.png",
  },
];

/** Three layouts: a title slide, a title and content, and a two-content one. */
export const LAYOUTS: LayoutSpec[] = [
  {
    name: "Title Slide",
    type: "title",
    shapes: [
      {
        kind: "ph",
        type: "ctrTitle",
        name: "Title 1",
        frame: { x: 10, y: 28, w: 80, h: 24 },
        anchor: "b",
        text: "Click to edit Master title style",
      },
      {
        kind: "ph",
        type: "subTitle",
        idx: 1,
        name: "Subtitle 2",
        frame: { x: 10, y: 56, w: 80, h: 14 },
        text: "Who presents, and when",
      },
    ],
  },
  {
    name: "Title and Content",
    type: "obj",
    shapes: [
      { kind: "ph", type: "title", name: "Title 1", text: "Click to edit Master title style" },
      { kind: "ph", idx: 1, name: "Content Placeholder 2", text: "Click to edit Master text styles" },
    ],
  },
  {
    name: "Two Content",
    type: "twoObj",
    shapes: [
      { kind: "ph", type: "title", name: "Title 1", text: "Click to edit Master title style" },
      {
        kind: "ph",
        idx: 1,
        name: "Content Placeholder 2",
        frame: { x: 8, y: 26, w: 41, h: 60 },
        text: "Click to edit Master text styles",
      },
      {
        kind: "ph",
        idx: 2,
        name: "Content Placeholder 3",
        frame: { x: 51, y: 26, w: 41, h: 60 },
        text: "Click to edit Master text styles",
      },
    ],
  },
];

/** The media of the standard package. */
export const STANDARD_MEDIA: Record<string, Uint8Array> = { "logo.png": PNG };

/** The parts of the package by name, with their text or bytes. */
export function partsOf(spec: PackageSpec = {}): Map<string, string | Uint8Array> {
  const kind = spec.kind ?? "potx";
  const size = spec.size ?? SLIDE;
  const base = kind === "thmx" ? "theme" : "ppt";
  const parts = new Map<string, string | Uint8Array>();
  const media = spec.media ?? STANDARD_MEDIA;
  const layouts = spec.layouts ?? LAYOUTS;
  const master = spec.master ?? MASTER;
  const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;

  parts.set(
    "[Content_Types].xml",
    xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    ),
  );
  parts.set(`${base}/theme/theme1.xml`, themeXml(spec));
  for (const [name, data] of Object.entries(media)) parts.set(`${base}/media/${name}`, data);

  if (kind === "thmx") {
    parts.set(
      "_rels/.rels",
      rels([{ id: "rId1", type: "officeDocument", target: "theme/theme/themeManager.xml" }]),
    );
    parts.set("theme/theme/themeManager.xml", xml(`<a:themeManager xmlns:a="${A}"/>`));
    parts.set(
      "theme/theme/_rels/themeManager.xml.rels",
      rels(
        spec.themeOnly
          ? [{ id: "rId1", type: "theme", target: "theme1.xml" }]
          : [
              { id: "rId1", type: "theme", target: "theme1.xml" },
              { id: "rId2", type: "officeDocument", target: "../presentation.xml" },
            ],
      ),
    );
    for (let n = 1; n <= (spec.variants ?? 0); n++) {
      parts.set(`themeVariants/variant${n}/theme/theme/theme1.xml`, themeXml(spec));
    }
    if (spec.themeOnly) return parts;
  } else {
    parts.set("_rels/.rels", rels([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]));
  }

  // The slide master, and the layouts it lists.
  const masterMedia = mediaOf(master, spec.masterBg);
  const masterEmbeds: Embeds = new Map(
    masterMedia.map((name, at) => [name, `rId${layouts.length + 2 + at}`]),
  );
  const masterRels = [
    ...layouts.map((_, at) => ({
      id: `rId${at + 1}`,
      type: "slideLayout",
      target: `../slideLayouts/slideLayout${at + 1}.xml`,
    })),
    { id: `rId${layouts.length + 1}`, type: "theme", target: "../theme/theme1.xml" },
    ...masterMedia.map((name) => ({
      id: masterEmbeds.get(name) as string,
      type: "image",
      target: `../media/${name}`,
    })),
  ];
  parts.set(
    `${base}/slideMasters/slideMaster1.xml`,
    xml(
      `<p:sldMaster ${NS}><p:cSld>${backgroundXml(spec.masterBg ?? { scheme: "bg1" }, masterEmbeds)}${treeXml(master, size, masterEmbeds)}</p:cSld><p:clrMap ${spec.dark ? CLR_MAP_DARK : CLR_MAP_LIGHT}/><p:sldLayoutIdLst>${layouts
        .map((_, at) => `<p:sldLayoutId id="${2147483649 + at}" r:id="rId${at + 1}"/>`)
        .join("")}</p:sldLayoutIdLst></p:sldMaster>`,
    ),
  );
  parts.set(`${base}/slideMasters/_rels/slideMaster1.xml.rels`, rels(masterRels));

  layouts.forEach((layout, at) => {
    const used = mediaOf(layout.shapes, layout.bg);
    const embeds: Embeds = new Map(used.map((name, n) => [name, `rId${n + 2}`]));
    const shows = layout.showMasterShapes === false ? ' showMasterSp="0"' : "";
    const type = layout.type ? ` type="${layout.type}"` : "";
    parts.set(
      `${base}/slideLayouts/slideLayout${at + 1}.xml`,
      xml(
        `<p:sldLayout ${NS}${type}${shows}><p:cSld name="${esc(layout.name)}">${backgroundXml(layout.bg, embeds)}${treeXml(layout.shapes, size, embeds)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
      ),
    );
    parts.set(
      `${base}/slideLayouts/_rels/slideLayout${at + 1}.xml.rels`,
      rels([
        { id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" },
        ...used.map((name) => ({
          id: embeds.get(name) as string,
          type: "image",
          target: `../media/${name}`,
        })),
      ]),
    );
  });

  // Further masters, empty but for a title, so a file with several masters has them.
  const extra = spec.extraMasters ?? 0;
  for (let n = 0; n < extra; n++) {
    parts.set(
      `${base}/slideMasters/slideMaster${n + 2}.xml`,
      xml(
        `<p:sldMaster ${NS}><p:cSld>${treeXml([], size, new Map())}</p:cSld><p:clrMap ${CLR_MAP_LIGHT}/></p:sldMaster>`,
      ),
    );
    parts.set(
      `${base}/slideMasters/_rels/slideMaster${n + 2}.xml.rels`,
      rels([{ id: "rId1", type: "theme", target: "../theme/theme1.xml" }]),
    );
  }

  // Slides, each on the first layout.
  const slides = spec.slides ?? 0;
  for (let n = 1; n <= slides; n++) {
    parts.set(
      `${base}/slides/slide${n}.xml`,
      xml(`<p:sld ${NS}><p:cSld>${treeXml([], size, new Map())}</p:cSld></p:sld>`),
    );
    parts.set(
      `${base}/slides/_rels/slide${n}.xml.rels`,
      rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }]),
    );
  }

  // Embedded fonts.
  const fontFaces = spec.embeddedFonts ?? [];
  for (const [at] of fontFaces.entries()) {
    parts.set(`${base}/fonts/font${at + 1}.fntdata`, Uint8Array.from([0, 1, 2, 3, at]));
  }

  const presentationRels = [
    { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
    ...Array.from({ length: extra }, (_, n) => ({
      id: `rId${n + 2}`,
      type: "slideMaster",
      target: `slideMasters/slideMaster${n + 2}.xml`,
    })),
    { id: "rId50", type: "theme", target: "theme/theme1.xml" },
    ...Array.from({ length: slides }, (_, n) => ({
      id: `rId${100 + n}`,
      type: "slide",
      target: `slides/slide${n + 1}.xml`,
    })),
    ...fontFaces.map((_, at) => ({
      id: `rId${200 + at}`,
      type: "font",
      target: `fonts/font${at + 1}.fntdata`,
    })),
  ];
  parts.set(`${base}/_rels/presentation.xml.rels`, rels(presentationRels));
  parts.set(
    `${base}/presentation.xml`,
    xml(
      `<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>${Array.from({ length: extra }, (_, n) => `<p:sldMasterId id="${2147483700 + n}" r:id="rId${n + 2}"/>`).join("")}</p:sldMasterIdLst>${
        slides > 0
          ? `<p:sldIdLst>${Array.from({ length: slides }, (_, n) => `<p:sldId id="${256 + n}" r:id="rId${100 + n}"/>`).join("")}</p:sldIdLst>`
          : ""
      }<p:sldSz cx="${size.cx}" cy="${size.cy}"/>${
        fontFaces.length > 0
          ? `<p:embeddedFontLst>${fontFaces.map((face, at) => `<p:embeddedFont><p:font typeface="${esc(face)}"/><p:regular r:id="rId${200 + at}"/></p:embeddedFont>`).join("")}</p:embeddedFontLst>`
          : ""
      }</p:presentation>`,
    ),
  );
  return parts;
}

/** Parts as the bytes of a zip file. */
export async function zipParts(parts: ReadonlyMap<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, data] of parts) zip.file(name, data);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** The package as the bytes of a zip file. */
export const buildPackage = (spec: PackageSpec = {}): Promise<Uint8Array> => zipParts(partsOf(spec));

// ---------------------------------------------------------------------------------------- running an import

/** Makes temporary folders, removed after each test. Call it once in a test file's top level. */
export function temporaryFolders(): () => string {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    const dir = mkdtempSync(join(tmpdir(), "depthcue-import-"));
    made.push(dir);
    return dir;
  };
}

/** A fixture written to a file in a new folder, ready to import. */
export async function writeFixture(
  folder: string,
  spec: PackageSpec = {},
  name = "Harbor",
): Promise<{ file: string; out: string }> {
  const file = join(folder, `${name}.${spec.kind ?? "potx"}`);
  writeFileSync(file, await buildPackage(spec));
  return { file, out: join(folder, "brand-out") };
}

export interface Imported {
  report: ImportReport;
  diagnostics: Diagnostic[];
  file: string;
  out: string;
  /** A file of the brand folder as text. */
  read(path: string): string;
  /** A file of the brand folder as bytes. */
  bytes(path: string): Uint8Array;
  /** A JSON file of the brand folder, read as whatever the test expects it to be. */
  // biome-ignore lint/suspicious/noExplicitAny: a test helper that reads the JSON file a test names
  json(path: string): any;
}

/** Imports a fixture into a new folder and returns what came out. Fails the test when the import does not succeed. */
export async function importFixture(
  make: () => string,
  spec: PackageSpec = {},
  name = "Harbor",
): Promise<Imported> {
  const folder = make();
  const { file, out } = await writeFixture(folder, spec, name);
  const result = await importBrand({ file, out });
  if (!result.ok) throw new Error(`The import failed: ${result.code}: ${result.message}`);
  return {
    report: result.report,
    diagnostics: result.diagnostics,
    file,
    out,
    read: (path) => readFileSync(join(out, path), "utf8"),
    bytes: (path) => new Uint8Array(readFileSync(join(out, path))),
    json: (path) => JSON.parse(readFileSync(join(out, path), "utf8")),
  };
}

// ---------------------------------------------------------------------------------------------- hostile files

/**
 * A copy of the zip in which the named part claims to unpack to `claimed` bytes, in both of its headers, whatever it
 * really holds. A real zip never does this; a file made to exhaust memory does, to get past a check of the headers.
 */
export function lieAbout(zip: Uint8Array, name: string, claimed: number): Uint8Array {
  const buffer = Buffer.from(zip);
  const wanted = Buffer.from(name);
  let patched = 0;
  for (let at = 0; at < buffer.length - 46; at++) {
    const signature = buffer.readUInt32LE(at);
    if (signature === 0x04034b50) {
      const length = buffer.readUInt16LE(at + 26);
      if (buffer.subarray(at + 30, at + 30 + length).equals(wanted)) {
        buffer.writeUInt32LE(claimed, at + 22);
        patched++;
      }
    } else if (signature === 0x02014b50) {
      const length = buffer.readUInt16LE(at + 28);
      if (buffer.subarray(at + 46, at + 46 + length).equals(wanted)) {
        buffer.writeUInt32LE(claimed, at + 24);
        patched++;
      }
    }
  }
  if (patched !== 2) throw new Error(`Expected to change two headers of ${name}, changed ${patched}.`);
  return new Uint8Array(buffer);
}
