/**
 * Adding and removing a brand's files: its fonts, logos and background images, in the deck's brand/ folder. The edit
 * API's upload route and `depthcue brand add/remove` both come here, so a file gets the same checks and the same name
 * whichever way it arrives, and the same bytes give the same path.
 *
 * Nothing the sender says about the file is trusted. The kind of file comes from its bytes, and so does its extension;
 * the name keeps only the base name, in the characters a brand.json may name. A font is unpacked by the same guard the
 * PowerPoint export uses, within its limits, and an SVG is read as XML and refused for anything that could run, load or
 * reach outside the file. A file is written whole, by a rename, or not at all. Replacing one with other bytes needs the
 * deck's current revision, and removing one is refused while brand.json or a template names it.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  BRAND_DIR,
  BRAND_FILE,
  type DeckFiles,
  type Diagnostic,
  type Doc,
  loadDoc,
  revisionOf,
  templatePath,
} from "@depthcue/core";
import { svgProblem } from "../brand-import/svg.ts";
import { parseXmlCounted, XmlError, type XmlNode, XmlTooLarge } from "../brand-import/xml.ts";
import { MAX_ASSET_BYTES, sniffImage } from "../edit-api.ts";
import { isNameableBrandFile, loadDeckDir } from "../loader.ts";
import { FONT_LIMITS, FontError, factsOf, fontKind, unpackFont } from "../pptx/sfnt.ts";
import { recordAgentWrite, recordPersonWrite } from "../review-file.ts";
import { sha256 } from "./record.ts";
import { carriable } from "./source.ts";

export type BrandFileKind = "font" | "logo" | "image";
export const BRAND_FILE_KINDS: readonly BrandFileKind[] = ["font", "logo", "image"];
const FOLDER: Readonly<Record<BrandFileKind, string>> = { font: "fonts", logo: "logos", image: "images" };
/** The formats each kind may be, as a brand.json may name them. */
const FORMATS: Readonly<Record<BrandFileKind, readonly string[]>> = {
  font: ["woff2", "woff", "ttf", "otf"],
  logo: ["svg", "png"],
  image: ["png", "jpg", "webp", "svg"],
};

/** An SVG for a logo or a background is a drawing of a few hundred elements; these are far past any real one. */
export const MAX_SVG_BYTES = 1024 * 1024;
export const MAX_SVG_ELEMENTS = 20_000;
/**
 * Real WOFF2 fonts state tables about three times the size of their compressed data. One that states a hundred times
 * more, and over a megabyte, is refused before it is decompressed, so a bomb costs nothing to turn away.
 */
const MAX_WOFF2_RATIO = 100;
/** Longer than any font or logo name; the whole path stays under brand.json's limit of 200. */
const MAX_STEM = 100;

/** The byte limit of an upload of this kind. */
export const brandFileLimit = (kind: BrandFileKind): number =>
  kind === "font" ? FONT_LIMITS.file : MAX_ASSET_BYTES;

export const isBrandFileKind = (value: unknown): value is BrandFileKind =>
  typeof value === "string" && (BRAND_FILE_KINDS as readonly string[]).includes(value);

/** What the bytes were found to be. */
export type Sniffed =
  | {
      format: "woff2" | "woff" | "ttf" | "otf";
      family: string;
      style: string;
      weight: number;
      italic: boolean;
    }
  | { format: "png" | "jpg" | "webp" }
  | { format: "svg"; elements: number };

export type BrandFileCode =
  | "bad-request"
  | "bad-name"
  | "too-large"
  | "not-a-font"
  | "unsupported"
  | "unsafe-svg"
  | "unreadable-deck"
  | "linked-brand-folder"
  | "exists"
  | "stale"
  | "not-found"
  | "in-use"
  | "write-failed";

const STATUS: Readonly<Record<BrandFileCode, number>> = {
  "bad-request": 400,
  "bad-name": 400,
  "too-large": 413,
  "not-a-font": 415,
  unsupported: 415,
  "unsafe-svg": 422,
  "unreadable-deck": 422,
  "linked-brand-folder": 422,
  exists: 409,
  stale: 409,
  "not-found": 404,
  "in-use": 409,
  "write-failed": 500,
};

/** The exit code of a refusal from the command line: 3 when the deck moved on, so a caller reads it again and retries. */
export const brandFileExit = (code: BrandFileCode): number =>
  code === "stale" ? 3 : STATUS[code] >= 422 && code !== "in-use" && code !== "unsafe-svg" ? 2 : 1;

/** Where a brand.json or a template names a file. */
export interface Naming {
  file: string;
  path: string;
}

export interface BrandFileRefusal {
  ok: false;
  status: number;
  error: BrandFileCode;
  message: string;
  /** The deck's revision now, for `stale`. */
  rev?: string;
  /** The file already there, for `exists`. */
  existing?: string;
  /** What names the file, for `in-use`. */
  usedBy?: Naming[];
  diagnostics?: Diagnostic[];
}

export interface BrandFileAdded {
  ok: true;
  /** The file's path in brand/, which is how brand.json names it. */
  path: string;
  kind: BrandFileKind;
  sniffed: Sniffed;
  bytes: number;
  sha256: string;
  /** False when the file was there with these bytes already, and nothing was written. */
  written: boolean;
  /** A file with other bytes was replaced. */
  replaced: boolean;
  /** The revision before; null when the deck had errors that this file fixes, so it had none. */
  prevRev: string | null;
  rev: string;
  /** Warnings, such as a review that could not be updated. */
  diagnostics: Diagnostic[];
}

export interface BrandFileRemoved {
  ok: true;
  path: string;
  removed: true;
  prevRev: string;
  rev: string;
  diagnostics: Diagnostic[];
}

/** Who made the change, which decides how the review takes it: a person's is theirs, an agent's is listed. */
export type Writer = "person" | "agent";

const refuse = (
  error: BrandFileCode,
  message: string,
  extra: Partial<Omit<BrandFileRefusal, "ok" | "status" | "error" | "message">> = {},
): BrandFileRefusal => ({ ok: false, status: STATUS[error], error, message, ...extra });

/** The refusal of a file past its kind's limit, which the route also gives when the body runs past it. */
export const tooLarge = (kind: BrandFileKind): BrandFileRefusal =>
  refuse("too-large", `A ${kind} can be up to ${brandFileLimit(kind) / 1024 / 1024} MB. Nothing was added.`);

/** An outcome as the route sends it and `depthcue brand add/remove --json` prints it: the HTTP status left out. */
export const brandFileBody = (
  outcome: BrandFileAdded | BrandFileRemoved | BrandFileRefusal,
): BrandFileAdded | BrandFileRemoved | Omit<BrandFileRefusal, "status"> => {
  if (outcome.ok) return outcome;
  const { status: _status, ...body } = outcome;
  return body;
};

// ---------------------------------------------------------------------------------------------------------- naming

/**
 * The name a file is stored under in its kind's folder: the base name only, without its extension, reduced to the
 * characters a brand.json may name, with the extension of what the bytes are. A problem when nothing usable is left or
 * the name is one Windows keeps for a device.
 */
export function storedName(original: string, format: string): { name: string } | { problem: string } {
  const base = original.split(/[\\/]/).pop() ?? "";
  const stem = base
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, MAX_STEM)
    .replace(/[._-]+$/, "");
  if (stem === "") {
    return { problem: `"${shown(original)}" has no letter or digit to name the file by. Give it a name.` };
  }
  const name = `${stem}.${format}`;
  if (!carriable(name)) {
    return {
      problem: `"${name}" is a name Windows keeps for a device, so the file could not be opened there. Give it another name.`,
    };
  }
  return { name };
}

/** A name as a message shows it: one line, not long. */
const shown = (value: string): string => {
  const plain = value.replace(/\p{Cc}+/gu, " ").trim();
  return plain.length > 60 ? `${plain.slice(0, 57)}...` : plain;
};

// ---------------------------------------------------------------------------------------------------------- sniffing

/** The tables a WOFF2 file states, added up, and its compressed data's size, read without decompressing anything. */
function woff2Stated(bytes: Uint8Array): { stated: number; compressed: number } | undefined {
  if (bytes.length < 48) return undefined;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = data.getUint16(12);
  const compressed = data.getUint32(20);
  let at = 48;
  const base128 = (): number | undefined => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = bytes[at++];
      if (byte === undefined) return undefined;
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    return undefined;
  };
  let stated = 0;
  for (let i = 0; i < count; i++) {
    const flags = bytes[at++];
    if (flags === undefined) return undefined;
    const index = flags & 0x3f;
    if (index === 63) at += 4;
    const version = flags >> 6;
    const original = base128();
    if (original === undefined) return undefined;
    // glyf (10) and loca (11) are transformed unless the version is 3; every other table unless it is 0.
    const transformed = index === 10 || index === 11 ? version !== 3 : version !== 0;
    const length = transformed ? base128() : original;
    if (length === undefined) return undefined;
    stated += length;
  }
  return { stated, compressed };
}

function sniffFont(bytes: Uint8Array): Sniffed | string {
  const format = fontKind(bytes);
  if (format === "unknown") return "The file is not a font (TrueType, OpenType, WOFF or WOFF2).";
  if (format === "woff2") {
    const stated = woff2Stated(bytes);
    if (
      stated &&
      stated.stated > 1024 * 1024 &&
      stated.stated > MAX_WOFF2_RATIO * Math.max(1, stated.compressed)
    ) {
      return "The WOFF2 file states tables far larger than its data could hold, which no font does.";
    }
  }
  try {
    const facts = factsOf(unpackFont(bytes));
    return { format, family: facts.family, style: facts.style, weight: facts.weight, italic: facts.italic };
  } catch (error) {
    // The guard's own words for a font it refuses; anything else it threw is a font it could not read.
    return error instanceof FontError ? error.message : "The font could not be read.";
  }
}

const CSS_URL = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;

/** What a piece of CSS loads that is not a place in the file, as a phrase, or undefined. */
function cssProblem(css: string): string | undefined {
  for (const match of css.matchAll(CSS_URL)) {
    const target = (match[2] ?? "").trim();
    if (!target.startsWith("#")) return `a url() to "${shown(target)}", which is not a place in the file`;
  }
  if (/url\s*\(/i.test(css.replace(CSS_URL, ""))) return "a url() that cannot be read";
  return undefined;
}

/**
 * What is wrong with an SVG for a brand, as a phrase that follows "The SVG has", or the number of its elements. Read
 * strictly: no DOCTYPE or entity, no script or foreignObject, no event handler, every link and url() to a place in the
 * file (`#id`), and no @import in a style element; then whatever step 4's check of imported SVGs refuses besides.
 */
export function strictSvg(bytes: Uint8Array): { elements: number } | { problem: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { problem: "bytes that are not UTF-8 text" };
  }
  if (text.includes("\0")) return { problem: "a NUL character" };
  if (/<!DOCTYPE/i.test(text)) return { problem: "a DOCTYPE, which can define entities" };
  if (/<!ENTITY/i.test(text)) return { problem: "an entity declaration" };
  if (/<\?xml-stylesheet/i.test(text)) return { problem: "a linked style sheet" };
  let root: XmlNode;
  let elements: number;
  try {
    ({ root, nodes: elements } = parseXmlCounted(text, { keepAttributes: true, maxNodes: MAX_SVG_ELEMENTS }));
  } catch (error) {
    if (error instanceof XmlTooLarge) return { problem: `more than ${MAX_SVG_ELEMENTS} elements` };
    if (error instanceof XmlError) return { problem: "markup that is not valid XML" };
    throw error;
  }
  if (root.name.toLowerCase() !== "svg")
    return { problem: `"${shown(root.name)}" as its root element, not "svg"` };
  const pending: XmlNode[] = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    const name = node.name.toLowerCase();
    if (name === "script" || name === "foreignobject") return { problem: `a "${shown(node.name)}" element` };
    if (name === "style") {
      if (/@import/i.test(node.text)) return { problem: "an @import in a style element" };
      const problem = cssProblem(node.text);
      if (problem) return { problem };
    }
    for (const [attribute, value] of Object.entries(node.attrs)) {
      const local = attribute.slice(attribute.lastIndexOf(":") + 1).toLowerCase();
      if (local.startsWith("on")) return { problem: `an event handler ("${shown(attribute)}")` };
      if (local === "href" && !value.trim().startsWith("#")) {
        return { problem: `a link to "${shown(value)}", which is not a place in the file` };
      }
      const problem = cssProblem(value);
      if (problem) return { problem };
    }
    for (const next of node.children) pending.push(next);
  }
  const imported = svgProblem(text);
  return imported === undefined ? { elements } : { problem: imported };
}

/** Text that starts like markup is read as an SVG, whatever else it may claim to be. */
const looksLikeMarkup = (bytes: Uint8Array): boolean =>
  /^(﻿)?\s*</.test(Buffer.from(bytes.subarray(0, 64)).toString("utf8"));

function sniff(kind: BrandFileKind, bytes: Uint8Array): Sniffed | BrandFileRefusal {
  if (kind === "font") {
    const found = sniffFont(bytes);
    return typeof found === "string" ? refuse("not-a-font", `${found} Nothing was added.`) : found;
  }
  const allowed = FORMATS[kind].join(", ");
  if (looksLikeMarkup(bytes)) {
    if (bytes.length > MAX_SVG_BYTES) {
      return refuse("too-large", `An SVG can be up to ${MAX_SVG_BYTES / 1024 / 1024} MB. Nothing was added.`);
    }
    const checked = strictSvg(bytes);
    if ("problem" in checked) {
      return refuse(
        "unsafe-svg",
        `The SVG has ${checked.problem}, so it was not added. A brand's SVG may draw, and link only to places in itself.`,
      );
    }
    return { format: "svg", elements: checked.elements };
  }
  const format = sniffImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (format === "png" || format === "jpg" || format === "webp") {
    if (FORMATS[kind].includes(format)) return { format };
    return refuse("unsupported", `The file is a ${format.toUpperCase()}; a ${kind} is one of ${allowed}.`);
  }
  return refuse(
    "unsupported",
    `The file is not ${kind === "logo" ? "a logo" : "an image"} this can add: a ${kind} is one of ${allowed}, found from its bytes.`,
  );
}

// ---------------------------------------------------------------------------------------------------------- the deck

/** What stops a file from being written to or removed from a kind's folder: a link on the way, or not a folder. */
function folderProblem(deck: string, folder: string): string | undefined {
  const root = realpathSync(deck);
  for (const part of [BRAND_DIR, `${BRAND_DIR}/${folder}`]) {
    const full = join(deck, ...part.split("/"));
    const found = lstatSync(full, { throwIfNoEntry: false });
    if (found === undefined) return undefined;
    if (found.isSymbolicLink() || !realpathSync(full).startsWith(root + sep)) {
      return `${part}/ is a link to a folder outside the deck, so writing there would change files elsewhere. Replace the link with a copy of the folder.`;
    }
    if (!found.isDirectory()) return `${part} is not a folder.`;
  }
  return undefined;
}

/** The name a file of the folder has that is `name` in other letters, or `name` itself when it is there. */
function sameName(deck: string, folder: string, name: string): string | undefined {
  try {
    const wanted = name.toLowerCase();
    return readdirSync(join(deck, BRAND_DIR, folder)).find((entry) => entry.toLowerCase() === wanted);
  } catch {
    return undefined;
  }
}

/** Every place brand.json and the templates name `path` (in brand/), compared without case. */
export function namings(doc: Doc, path: string): Naming[] {
  const wanted = path.toLowerCase();
  const out: Naming[] = [];
  const walk = (value: unknown, file: string, at: string): void => {
    if (typeof value === "string") {
      if (value.toLowerCase() === wanted) out.push({ file, path: at });
    } else if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) walk(item, file, `${at}/${i}`);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        walk(item, file, `${at}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
      }
    }
  };
  if (doc.brand !== undefined) walk(doc.brand, BRAND_FILE, "");
  for (const [id, template] of Object.entries(doc.templates ?? {})) walk(template, templatePath(id), "");
  return out;
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Retries a step a reader of the file can block on Windows for a moment: a rename over it, or its removal. */
function retried(step: () => void): void {
  for (let tries = 0; ; tries++) {
    try {
      step();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (tries >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      sleep(20 * (tries + 1));
    }
  }
}

/**
 * Writes the file whole or not at all: into a temporary file at the deck's top, outside brand/ so that nothing reads it
 * half written as a font or a logo, then renamed into place.
 */
function writeWhole(deck: string, target: string, bytes: Uint8Array): void {
  const temporary = join(deck, `.depthcue-brand-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    retried(() => renameSync(temporary, target));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The deck's files with one brand file's hash put in, or taken out, as a load of the deck after the change reads it. */
function withFile(files: DeckFiles, path: string, hash: string | undefined): DeckFiles {
  const text = { ...files.text };
  const listed = [...(files.brandFiles ?? [])].filter((file) => file !== path);
  if (hash === undefined) delete text[path];
  else {
    text[path] = hash;
    listed.push(path);
  }
  return listed.length > 0 ? { ...files, text, brandFiles: listed } : { text, assets: files.assets };
}

const record = (writer: Writer, deck: string, before: Doc, after: Doc): Diagnostic[] => {
  if (writer === "agent") return recordAgentWrite(deck, before, after);
  recordPersonWrite(deck, before, after);
  return [];
};

const errors = (diagnostics: readonly Diagnostic[]) => diagnostics.filter((d) => d.severity === "error");

export interface AddRequest {
  kind: BrandFileKind;
  /** What the sender called the file; only its base name is used. */
  name: string;
  bytes: Uint8Array;
  /** Replace a file of the same name with other bytes. Needs `baseRev`. */
  replace?: boolean;
  /** The deck's revision the sender read. A stale one refuses any write. */
  baseRev?: string;
}

/** Adds a font, a logo or an image to the deck's brand folder, or says why not and leaves the deck as it was. */
export function addBrandFile(
  deck: string,
  request: AddRequest,
  writer: Writer,
): BrandFileAdded | BrandFileRefusal {
  const { kind, bytes } = request;
  if (bytes.length === 0) return refuse("bad-request", "The file is empty. Nothing was added.");
  if (bytes.length > brandFileLimit(kind)) return tooLarge(kind);
  const sniffed = sniff(kind, bytes);
  if ("ok" in sniffed) return sniffed;
  const named = storedName(request.name, sniffed.format);
  if ("problem" in named) return refuse("bad-name", named.problem);
  const folder = FOLDER[kind];
  const blocked = folderProblem(deck, folder);
  if (blocked !== undefined) return refuse("linked-brand-folder", `${blocked} Nothing was added.`);

  // A file there under the same name in other letters is the same file where case does not count, and is kept by its name.
  const there = sameName(deck, folder, named.name);
  const name = there ?? named.name;
  const relative = `${folder}/${name}`;
  const path = `${BRAND_DIR}/${relative}`;
  const target = join(deck, BRAND_DIR, folder, name);
  const hash = sha256(bytes);
  const files = loadDeckDir(deck);
  const before = loadDoc(files);
  const prevRev = before.doc ? revisionOf(before.doc) : null;
  const found = there === undefined ? undefined : lstatSync(target);
  if (found !== undefined && !found.isFile()) {
    return refuse("bad-name", `${path} is in the deck and is not a plain file, so it was left alone.`);
  }
  const current = found === undefined ? undefined : files.text[path];
  const added = (
    written: boolean,
    replaced: boolean,
    rev: string,
    diagnostics: Diagnostic[] = [],
  ): BrandFileAdded => ({
    ok: true,
    path: relative,
    kind,
    sniffed,
    bytes: bytes.length,
    sha256: hash,
    written,
    replaced,
    prevRev,
    rev,
    diagnostics,
  });
  if (current === hash && prevRev !== null) return added(false, false, prevRev);

  if (current !== undefined && current !== hash) {
    if (request.replace !== true) {
      return refuse(
        "exists",
        `${path} is in the brand already, with other bytes. Nothing was added. To replace it, send replace with the deck's revision.`,
        { existing: relative },
      );
    }
    if (request.baseRev === undefined) {
      return refuse(
        "bad-request",
        `Replacing ${path} needs the deck's revision as baseRev. Nothing was added.`,
      );
    }
  }
  if (request.baseRev !== undefined && request.baseRev !== prevRev) {
    return refuse("stale", "The deck changed after the revision that was sent. Nothing was added.", {
      ...(prevRev === null ? {} : { rev: prevRev }),
    });
  }
  // The deck as it will be. One that had errors is taken only when this file is what it lacked.
  const after = loadDoc(withFile(files, path, hash));
  if (!after.doc) {
    return refuse(
      "unreadable-deck",
      `The deck has errors that this file does not fix, so nothing was added. Run depthcue check on it.`,
      { diagnostics: errors(after.diagnostics) },
    );
  }
  if (before.doc === null && current !== undefined) {
    return refuse(
      "unreadable-deck",
      "The deck has errors, so no file of it is replaced. Run depthcue check on it.",
      {
        diagnostics: errors(before.diagnostics),
      },
    );
  }
  try {
    mkdirSync(join(deck, BRAND_DIR, folder), { recursive: true });
    writeWhole(deck, target, bytes);
  } catch (error) {
    return refuse(
      "write-failed",
      `${path} could not be written: ${(error as Error).message} Nothing was added.`,
    );
  }
  const diagnostics = before.doc === null ? [] : record(writer, deck, before.doc, after.doc);
  return added(true, current !== undefined, revisionOf(after.doc), diagnostics);
}

export interface RemoveRequest {
  /** The file's path in brand/, as brand.json names it: `fonts/Acme-Bold.woff2`. `brand/` before it is allowed. */
  path: string;
  baseRev: string;
}

/** Removes a font, a logo or an image from the deck's brand folder, unless the brand still names it. */
export function removeBrandFile(
  deck: string,
  request: RemoveRequest,
  writer: Writer,
): BrandFileRemoved | BrandFileRefusal {
  const given = request.path.startsWith(`${BRAND_DIR}/`)
    ? request.path.slice(BRAND_DIR.length + 1)
    : request.path;
  const parts = given.split("/");
  const folder = parts[0] as string;
  if (!isNameableBrandFile(given) || parts.length !== 2 || !carriable(parts[1] as string)) {
    return refuse(
      "bad-request",
      `"${shown(request.path)}" is not a brand file: name one as brand.json does, such as "fonts/Acme-Bold.woff2", "logos/acme.svg" or "images/cover.png".`,
    );
  }
  const blocked = folderProblem(deck, folder);
  if (blocked !== undefined) return refuse("linked-brand-folder", `${blocked} Nothing was removed.`);
  const name = sameName(deck, folder, parts[1] as string);
  if (name === undefined) return refuse("not-found", `There is no ${BRAND_DIR}/${given} in the deck.`);
  const relative = `${folder}/${name}`;
  const path = `${BRAND_DIR}/${relative}`;
  const target = join(deck, BRAND_DIR, folder, name);
  if (!lstatSync(target).isFile()) {
    return refuse("bad-request", `${path} is not a plain file, so it was left alone.`);
  }
  const files = loadDeckDir(deck);
  const before = loadDoc(files);
  if (!before.doc) {
    return refuse(
      "unreadable-deck",
      "The deck has errors, so nothing was removed. Run depthcue check on it.",
      {
        diagnostics: errors(before.diagnostics),
      },
    );
  }
  const prevRev = revisionOf(before.doc);
  if (request.baseRev !== prevRev) {
    return refuse("stale", "The deck changed after the revision that was sent. Nothing was removed.", {
      rev: prevRev,
    });
  }
  const usedBy = namings(before.doc, relative);
  if (usedBy.length > 0) {
    return refuse(
      "in-use",
      `${path} is named by ${usedBy.map((at) => `${at.file} at ${at.path}`).join(", ")}, so it was not removed. Point those at another file or remove them first.`,
      { usedBy },
    );
  }
  const after = loadDoc(withFile(files, path, undefined));
  if (!after.doc) {
    return refuse("unreadable-deck", "The deck would not load without this file, so it was not removed.", {
      diagnostics: errors(after.diagnostics),
    });
  }
  try {
    retried(() => rmSync(target));
  } catch (error) {
    return refuse("write-failed", `${path} could not be removed: ${(error as Error).message}`);
  }
  return {
    ok: true,
    path: relative,
    removed: true,
    prevRev,
    rev: revisionOf(after.doc),
    diagnostics: record(writer, deck, before.doc, after.doc),
  };
}
