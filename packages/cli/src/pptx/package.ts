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

async function readParts(bytes: Uint8Array): Promise<Parts> {
  const zip = await JSZip.loadAsync(bytes);
  const parts: Parts = new Map();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    parts.set(name, await entry.async("uint8array"));
  }
  return parts;
}

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

const BULLET_COLOR = new RegExp(`${BULLET_MARK}([0-9A-F]{6})`, "g");

/**
 * The writer puts a paragraph-properties element before every run of a paragraph, where the format allows one, first.
 * Keep the first and drop the rest. A bulleted paragraph's marker is given the color the first run's mark names, and a
 * numbered one is set in the text's face and not the theme's heading face. Runs whose capitals the stylesheet draws
 * become PowerPoint's "all caps", so the words keep the case they were written in.
 */
function tidySlide(xml: string, headers: readonly string[]): string {
  const paragraphs = xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_whole, inner: string) => {
    let kept = inner.replace(PARAGRAPH_PROPERTIES, (match, at: number) => (at === 0 ? match : ""));
    const marker = [...kept.matchAll(BULLET_COLOR)][0]?.[1];
    kept = kept.replace(BULLET_COLOR, "");
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
  return tables.replace(
    new RegExp(`lang="([^"]*?)${CAPS_MARK}" altLang="en-US"`, "g"),
    'lang="$1" altLang="en-US" cap="all"',
  );
}

/** What the package step needs to know that the slides themselves do not say. */
export interface Hints {
  /** For each slide, the names of its tables that have a header row. */
  headers: readonly (readonly string[])[];
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

/** A chart's workbook is a zip of its own, with its own dates. */
async function tidyWorkbook(bytes: Uint8Array): Promise<Uint8Array> {
  const parts = await readParts(bytes);
  const core = parts.get("docProps/core.xml");
  if (core) parts.set("docProps/core.xml", encode(fixDates(decode(core))));
  return writeParts(parts);
}

/**
 * A doughnut's series-level label style is written in Arial whatever the options say, under the labels of each part,
 * which carry the chart's own face. A part added in PowerPoint would take the Arial, and the file would name a face the
 * deck does not use, so it takes the chart's own.
 */
function tidyChart(xml: string): string {
  const own = [...xml.matchAll(/<a:latin typeface="([^"]*)"/g)]
    .map((match) => match[1])
    .find((face) => face !== "Arial");
  return own === undefined
    ? xml
    : xml.replaceAll('<a:latin typeface="Arial"/>', `<a:latin typeface="${own}"/>`);
}

async function tidy(name: string, bytes: Uint8Array, hints: Hints): Promise<Uint8Array> {
  const slide = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
  if (slide) return encode(tidySlide(decode(bytes), hints.headers[Number(slide[1]) - 1] ?? []));
  if (CHART_PART.test(name)) return encode(tidyChart(decode(bytes)));
  if (name === "docProps/core.xml") return encode(fixDates(decode(bytes)));
  if (name.endsWith(".xlsx")) return tidyWorkbook(bytes);
  return bytes;
}

const markerXml = (digest: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="${MARKER_NAME}"><vt:lpwstr>${MARKER_VERSION}:${digest}</vt:lpwstr></property></Properties>`;

/** The file the writer made, tidied so the same deck gives the same bytes, and marked as Depthcue's. */
export async function finishPackage(raw: Uint8Array, hints: Hints = { headers: [] }): Promise<Buffer> {
  const parts = renumbered(await readParts(raw));
  for (const [name, bytes] of parts) parts.set(name, await tidy(name, bytes, hints));

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
    const parts = await readParts(readFileSync(path));
    const marker = parts.get(MARKER_PART);
    if (!marker) return "foreign";
    const found = new RegExp(
      `name="${MARKER_NAME}"[^>]*><vt:lpwstr>${MARKER_VERSION}:([0-9a-f]{64})</vt:lpwstr>`,
    ).exec(decode(marker));
    if (!found) return "foreign";
    return digestOf(parts) === found[1] ? "ours" : "edited";
  } catch {
    return "foreign";
  }
}
