/**
 * The last step of a PowerPoint export: the file as bytes. The writer stamps the time on every part and every chart's
 * workbook and numbers a few things at random, and the same deck must give the same bytes every time, so the parts are
 * read back, tidied and written again with one fixed date. The file is also marked as Depthcue's own, with a digest of
 * its parts, so a later export may replace it and nothing else: not a file someone else made, and not one a person has
 * since edited in PowerPoint.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import JSZip from "jszip";
import { BULLET_MARK, CAPS_MARK } from "./text.ts";

/** Every date the file holds. */
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
const FIXED_ISO = "2000-01-01T00:00:00Z";

/** The custom document property that says Depthcue wrote the file. */
export const MARKER_PART = "docProps/custom.xml";
export const MARKER_NAME = "DepthcueExport";
const MARKER_VERSION = "v1";
/** The parts the mark itself changes, which the digest leaves out. */
const OUTSIDE_DIGEST = new Set(["[Content_Types].xml", "_rels/.rels", MARKER_PART]);

type Parts = Map<string, Uint8Array>;

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

/**
 * What XML 1.0 cannot hold, whatever the escaping: every control character but tab, line feed and carriage return, and
 * the two code points that are not characters. The writer puts text in raw, so one stray control character in a deck's
 * words would make a part that PowerPoint says it must repair.
 */
const holdsXml = (code: number) =>
  code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xfffd) || code >= 0x10000;

function cleaned(text: string): string {
  let kept = "";
  for (const character of text) {
    if (holdsXml(character.codePointAt(0) as number)) kept += character;
  }
  return kept;
}

/** The bytes of an XML part without the characters XML cannot hold; the same bytes when there are none. */
function cleanBytes(bytes: Uint8Array): Uint8Array {
  const text = decode(bytes);
  const clean = cleaned(text);
  return clean === text ? bytes : encode(clean);
}

const isXml = (name: string) => name.endsWith(".xml") || name.endsWith(".rels");

async function partsOf(zip: JSZip): Promise<Parts> {
  const parts: Parts = new Map();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    parts.set(name, await entry.async("uint8array"));
  }
  return parts;
}

const readParts = async (bytes: Uint8Array): Promise<Parts> => partsOf(await JSZip.loadAsync(bytes));

/** The parts' names in the order they are written: the content types, the root relationships, then the rest by name. */
function ordered(parts: Parts): string[] {
  const rest = [...parts.keys()].filter((name) => name !== "[Content_Types].xml" && name !== "_rels/.rels");
  rest.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ["[Content_Types].xml", "_rels/.rels", ...rest].filter((name) => parts.has(name));
}

async function writeParts(parts: Parts): Promise<Buffer> {
  const zip = new JSZip();
  for (const name of ordered(parts)) {
    zip.file(name, parts.get(name) as Uint8Array, { date: FIXED_DATE, createFolders: false });
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS",
  });
}

/** A hash of the parts the mark does not touch, by name and bytes. */
function digestOf(parts: Parts): string {
  const hash = createHash("sha256");
  for (const name of ordered(parts)) {
    if (OUTSIDE_DIGEST.has(name)) continue;
    const bytes = parts.get(name) as Uint8Array;
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

const fixDates = (xml: string) =>
  xml.replace(
    /(<dcterms:(?:created|modified)\b[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g,
    `$1${FIXED_ISO}$2`,
  );

const PARAGRAPH_PROPERTIES = /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g;

/** The bullet mark, only where it was put: at the end of a run's `lang` attribute, never in the words themselves. */
const BULLET_COLOR = new RegExp(`(\\blang="[^"]*?)${BULLET_MARK}([0-9A-F]{6})"`, "g");

/** Every shape's number on a slide, the slide's own group first. */
const SHAPE_NUMBER = /<p:cNvPr id="\d+"/g;

/**
 * The writer puts a paragraph-properties element before every run of a paragraph, where the format allows one, first.
 * Keep the first and drop the rest. A bulleted paragraph's marker is given the color the first run's mark names, and a
 * numbered one is set in the text's face and not the theme's heading face. Runs whose capitals the stylesheet draws
 * become PowerPoint's "all caps", so the words keep the case they were written in. The shapes are numbered again, from
 * 2 after the slide's own group, because the writer numbers a table from a sum that can land on another shape's number.
 */
function tidySlide(xml: string, headers: readonly string[]): string {
  const paragraphs = xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_whole, inner: string) => {
    let kept = inner.replace(PARAGRAPH_PROPERTIES, (match, at: number) => (at === 0 ? match : ""));
    const marker = [...kept.matchAll(BULLET_COLOR)][0]?.[2];
    kept = kept.replace(BULLET_COLOR, '$1"');
    if (marker) {
      kept = kept.replace("<a:buSzPct", `<a:buClr><a:srgbClr val="${marker}"/></a:buClr><a:buSzPct`);
    }
    return `<a:p>${kept.replaceAll('<a:buFont typeface="+mj-lt"/>', "<a:buFontTx/>")}</a:p>`;
  });
  // A table's first row is a header when the deck says so: PowerPoint's own "Header Row" setting.
  const tables =
    headers.length === 0
      ? paragraphs
      : paragraphs.replace(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g, (frame) => {
          const name = /<p:cNvPr id="\d+" name="([^"]*)"/.exec(frame)?.[1];
          return name !== undefined && headers.includes(name)
            ? frame.replace("<a:tblPr/>", '<a:tblPr firstRow="1"/>')
            : frame;
        });
  let number = 1;
  return tables
    .replace(
      new RegExp(`lang="([^"]*?)${CAPS_MARK}" altLang="en-US"`, "g"),
      'lang="$1" altLang="en-US" cap="all"',
    )
    .replace(SHAPE_NUMBER, () => `<p:cNvPr id="${number++}"`);
}

/**
 * The speaker notes arrive as one run holding every line, joined by carriage return and line feed, which PowerPoint
 * reads as spaces. One paragraph for each line is how it keeps them.
 */
function tidyNotes(xml: string): string {
  return xml.replace(
    /<a:p>(<a:r><a:rPr\b[^>]*\/>)<a:t>([^<]*)<\/a:t><\/a:r>(<a:endParaRPr\b[^>]*\/>)<\/a:p>/g,
    (whole, open: string, text: string, end: string) => {
      const lines = text.split(/\r\n|\r|\n/);
      if (lines.length === 1) return whole;
      return lines
        .map((line) =>
          line === "" ? `<a:p>${end}</a:p>` : `<a:p>${open}<a:t>${line}</a:t></a:r>${end}</a:p>`,
        )
        .join("");
    },
  );
}

/** What the package step needs to know that the slides themselves do not say. */
export interface Hints {
  /** For each slide, the names of its tables that have a header row. */
  headers: readonly (readonly string[])[];
  /**
   * Changes to the parts the writer cannot make (the slide master and layouts, embedded fonts), made after the charts
   * are numbered again and before the parts are tidied, so a shape added here is numbered with the rest.
   */
  edit?: (parts: Map<string, Uint8Array>) => void | Promise<void>;
}

const CHART_PART = /^ppt\/charts\/chart(\d+)\.xml$/;
const CHART_NUMBER = /chart(\d+)\.xml/g;
const WORKBOOK_NUMBER = /Microsoft_Excel_Worksheet(\d+)\.xlsx/g;

/**
 * The writer numbers charts from a counter that lives as long as the process, so a second export in the same process
 * would call its first chart "chart2". The charts are numbered again from 1, in the order they were made, wherever the
 * numbers appear: in the names of the chart and its workbook, and in the relationships and content types that name them.
 */
function renumbered(parts: Parts): Parts {
  const made = [...parts.keys()]
    .flatMap((name) => {
      const digits = CHART_PART.exec(name)?.[1];
      return digits === undefined ? [] : [Number(digits)];
    })
    .sort((a, b) => a - b);
  if (made.every((value, at) => value === at + 1)) return parts;
  const number = new Map(made.map((value, at) => [value, at + 1]));
  const rename = (text: string) =>
    text
      .replace(CHART_NUMBER, (_whole, digits: string) => `chart${number.get(Number(digits)) ?? digits}.xml`)
      .replace(
        WORKBOOK_NUMBER,
        (_whole, digits: string) => `Microsoft_Excel_Worksheet${number.get(Number(digits)) ?? digits}.xlsx`,
      );
  const next: Parts = new Map();
  for (const [name, bytes] of parts) {
    const names = name === "[Content_Types].xml" || name.endsWith(".rels");
    next.set(rename(name), names ? encode(rename(decode(bytes))) : bytes);
  }
  return next;
}

/** The cell a chart's data begins at, from the range its series names: `Sheet1!$B$2:$B$5` begins at column B, row 2. */
const RANGE_START = /^Sheet1!\$([A-Z]+)\$(\d+):/;

/**
 * A chart's workbook is a zip of its own, with its own dates. The cells a chart leaves empty are empty here too: the
 * writer puts a zero (or nothing, in a scatter) where the deck has no number, and opening the data in PowerPoint would
 * then redraw the chart with a value the deck never had.
 */
async function tidyWorkbook(bytes: Uint8Array, empty: readonly string[]): Promise<Uint8Array> {
  const parts = await readParts(bytes);
  const core = parts.get("docProps/core.xml");
  if (core) parts.set("docProps/core.xml", encode(fixDates(decode(core))));
  const sheet = parts.get("xl/worksheets/sheet1.xml");
  if (sheet && empty.length > 0) {
    let text = decode(sheet);
    for (const cell of empty) {
      text = text.replace(new RegExp(`<c r="${cell}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`), "");
    }
    parts.set("xl/worksheets/sheet1.xml", encode(text));
  }
  for (const [name, part] of parts) if (isXml(name)) parts.set(name, cleanBytes(part));
  return writeParts(parts);
}

const NUMBER_CACHE = /(<c:numRef>\s*<c:f>)([^<]*)(<\/c:f>\s*<c:numCache>)([\s\S]*?)(<\/c:numCache>)/g;
/** A point the writer wrote for a number the deck does not have: it has a place and no value. */
const EMPTY_POINT = /<c:pt idx="(\d+)"><c:v><\/c:v><\/c:pt>/g;
/** The doughnut's series-level label style, which the writer sets in Arial and black whatever the options say. */
const SERIES_LABELS =
  /(<a:defRPr sz="1800"[^>]*>\s*<a:solidFill><a:srgbClr val="000000"\/><\/a:solidFill>)<a:latin typeface="Arial"\/>/g;

/**
 * Two things the writer gets wrong, and nothing else of the chart is touched.
 *
 * A number the deck does not have is written as a point with no value, which PowerPoint reads as a broken file. The
 * point is dropped, so the chart skips it as the player does, and the cell it came from is named so the workbook can
 * leave it empty.
 *
 * A doughnut's series-level label style is written in Arial under the labels of each part, which carry the chart's own
 * face. A part added in PowerPoint would take the Arial, and the file would name a face the deck does not use, so that
 * one takes the chart's own. An Arial the deck chose is left alone.
 */
function tidyChart(xml: string): { xml: string; empty: string[] } {
  const empty: string[] = [];
  const numbers = xml.replace(
    NUMBER_CACHE,
    (whole, open: string, range: string, mid: string, cache: string, close: string) => {
      const start = RANGE_START.exec(range);
      let dropped = false;
      const kept = cache.replace(EMPTY_POINT, (_point, index: string) => {
        dropped = true;
        if (start) empty.push(`${start[1]}${Number(start[2]) + Number(index)}`);
        return "";
      });
      return dropped ? `${open}${range}${mid}${kept}${close}` : whole;
    },
  );
  const own = /<c:dLbl>[\s\S]*?<a:latin typeface="([^"]*)"\/>/.exec(numbers)?.[1];
  return {
    xml: own === undefined ? numbers : numbers.replace(SERIES_LABELS, `$1<a:latin typeface="${own}"/>`),
    empty,
  };
}

/** What one part's tidying needs from the others. */
interface Whole {
  hints: Hints;
  parts: Parts;
  /** The cells each chart workbook leaves empty, filled in as the charts are tidied. */
  empty: Map<string, string[]>;
}

/** The workbook a chart draws its numbers from, by the chart's relationships. */
function workbookOf(chart: string, parts: Parts): string | undefined {
  const rels = parts.get(chart.replace("ppt/charts/", "ppt/charts/_rels/").concat(".rels"));
  const target = rels ? /Target="\.\.\/embeddings\/([^"]+)"/.exec(decode(rels))?.[1] : undefined;
  return target === undefined ? undefined : `ppt/embeddings/${target}`;
}

async function tidy(name: string, bytes: Uint8Array, whole: Whole): Promise<Uint8Array> {
  const slide = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
  if (slide) {
    return cleanBytes(encode(tidySlide(decode(bytes), whole.hints.headers[Number(slide[1]) - 1] ?? [])));
  }
  if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)) {
    return cleanBytes(encode(tidyNotes(decode(bytes))));
  }
  if (CHART_PART.test(name)) {
    const tidied = tidyChart(decode(bytes));
    const workbook = workbookOf(name, whole.parts);
    if (workbook !== undefined && tidied.empty.length > 0) whole.empty.set(workbook, tidied.empty);
    return cleanBytes(encode(tidied.xml));
  }
  if (name === "docProps/core.xml") return cleanBytes(encode(fixDates(decode(bytes))));
  if (name.endsWith(".xlsx")) return tidyWorkbook(bytes, whole.empty.get(name) ?? []);
  return isXml(name) ? cleanBytes(bytes) : bytes;
}

const markerXml = (digest: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${MARKER_NAME}"><vt:lpwstr>${MARKER_VERSION}:${digest}</vt:lpwstr></property></Properties>`;

/** The file the writer made, tidied so the same deck gives the same bytes, and marked as Depthcue's. */
export async function finishPackage(raw: Uint8Array, hints: Hints = { headers: [] }): Promise<Buffer> {
  const parts = renumbered(await readParts(raw));
  await hints.edit?.(parts);
  const whole: Whole = { hints, parts, empty: new Map() };
  // The workbooks come last: what each chart leaves empty is known only once the charts are tidied.
  const names = [...parts.keys()].sort((a, b) => Number(a.endsWith(".xlsx")) - Number(b.endsWith(".xlsx")));
  for (const name of names) parts.set(name, await tidy(name, parts.get(name) as Uint8Array, whole));

  parts.set(MARKER_PART, encode(markerXml(digestOf(parts))));
  const types = decode(parts.get("[Content_Types].xml") as Uint8Array).replace(
    "</Types>",
    `<Override PartName="/${MARKER_PART}" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`,
  );
  parts.set("[Content_Types].xml", encode(types));
  const rels = decode(parts.get("_rels/.rels") as Uint8Array).replace(
    "</Relationships>",
    `<Relationship Id="rIdDepthcue" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="${MARKER_PART}"/></Relationships>`,
  );
  parts.set("_rels/.rels", encode(rels));
  return writeParts(parts);
}

/**
 * What is at a path: nothing, a file Depthcue wrote and nobody has changed, a file Depthcue wrote that has been
 * changed since (in PowerPoint, usually), or anything else. Only the first two may be written over, and only the
 * first without losing someone's work.
 */
export type Existing = "absent" | "ours" | "edited" | "foreign";

export async function inspectOutput(path: string): Promise<Existing> {
  if (!existsSync(path)) return "absent";
  try {
    // Opening the zip reads its list of parts and nothing more; a part is unpacked only when it is asked for. The mark
    // is asked for first, so a big file that is not ours is refused without unpacking any of its parts.
    const zip = await JSZip.loadAsync(readFileSync(path));
    const marker = zip.file(MARKER_PART);
    if (!marker) return "foreign";
    const found = new RegExp(
      `name="${MARKER_NAME}"[^>]*><vt:lpwstr>${MARKER_VERSION}:([0-9a-f]{64})</vt:lpwstr>`,
    ).exec(decode(await marker.async("uint8array")));
    if (!found) return "foreign";
    return digestOf(await partsOf(zip)) === found[1] ? "ours" : "edited";
  } catch {
    return "foreign";
  }
}
