/**
 * Images in a deck's `assets/` folder: what counts as one, what to call it, how large it is, and where it is used.
 * The editor's upload route, `depthcue asset` and the MCP tool `deck_asset` all come in through here, so a file is
 * judged and named the same way whichever way it arrives.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { assetRefs, type Diagnostic, type Doc, deckAssetRefs } from "@depthcue/core";

export const MAX_ASSET_BYTES = 15 * 1024 * 1024;
/** An image over this slows loading and grows exports; `asset-large` warns about one a scene uses. */
export const LARGE_ASSET_BYTES = 4 * 1024 * 1024;

export type ImageKind = "png" | "jpg" | "gif" | "webp" | "svg";

/** The image type from the bytes themselves; the file name and the declared type are not trusted. */
export function sniffImage(bytes: Buffer): ImageKind | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")))
    return "gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  const head = bytes.subarray(0, 2048).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    const all = bytes.toString("utf8").toLowerCase();
    // An image shown in <img> cannot run script, but an exported deck may be opened some other way. Keep it inert.
    if (/<script|<foreignobject|\son[a-z]+\s*=|javascript:|<iframe|<embed|<object/.test(all))
      return undefined;
    return "svg";
  }
  return undefined;
}

const EXTENSION: Record<ImageKind, string> = { png: "png", jpg: "jpg", gif: "gif", webp: "webp", svg: "svg" };

/** The file extensions of the image kinds, as they appear in an asset's name. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;
export const isImageName = (name: string): boolean => IMAGE_FILE.test(name);

/** A safe file name from what the visitor called it: lower case letters, digits and hyphens. */
export function assetName(original: string, kind: ImageKind, bytes: Buffer): string {
  const stem =
    original
      .replace(/\.[A-Za-z0-9]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image";
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return `${stem}-${hash}.${EXTENSION[kind]}`;
}

export interface ImageSize {
  width: number;
  height: number;
}

const positive = (width: number, height: number): ImageSize | undefined =>
  Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1
    ? { width: Math.round(width), height: Math.round(height) }
    : undefined;

function pngSize(b: Buffer): ImageSize | undefined {
  if (b.length < 24 || b.subarray(12, 16).toString("latin1") !== "IHDR") return undefined;
  return positive(b.readUInt32BE(16), b.readUInt32BE(20));
}

function jpegSize(b: Buffer): ImageSize | undefined {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    let marker = b[i + 1] as number;
    // Any number of 0xFF fill bytes may come before a marker's code.
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = b[i + 1] as number;
    }
    // Markers that stand alone, with no length: the start of image, TEM and the restart markers.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = b.readUInt16BE(i + 2);
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) {
      if (i + 9 > b.length) return undefined;
      return positive(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
    }
    if (length < 2) return undefined;
    i += 2 + length;
  }
  return undefined;
}

function gifSize(b: Buffer): ImageSize | undefined {
  return b.length < 10 ? undefined : positive(b.readUInt16LE(6), b.readUInt16LE(8));
}

function webpSize(b: Buffer): ImageSize | undefined {
  if (b.length < 30) return undefined;
  const chunk = b.subarray(12, 16).toString("latin1");
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return positive(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return undefined;
    const b0 = b[21] as number;
    const b1 = b[22] as number;
    const b2 = b[23] as number;
    const b3 = b[24] as number;
    return positive(1 + (b0 | ((b1 & 0x3f) << 8)), 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)));
  }
  if (chunk === "VP8X") {
    return positive(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
  }
  return undefined;
}

const UNITS: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
};

/** An SVG length in pixels; a percentage or a font-relative unit has no size of its own. */
function svgLength(value: string | undefined): number | undefined {
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)\s*([a-z%]*)\s*$/i.exec(value ?? "");
  if (!m) return undefined;
  const factor = UNITS[(m[2] as string).toLowerCase()];
  return factor === undefined ? undefined : Number(m[1]) * factor;
}

function svgSize(b: Buffer): ImageSize | undefined {
  const text = b.subarray(0, 8192).toString("utf8");
  const tag = /<svg\b([^>]*)>/i.exec(text)?.[1];
  if (tag === undefined) return undefined;
  const attribute = (name: string) =>
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag)?.slice(1).find(Boolean);
  const width = svgLength(attribute("width"));
  const height = svgLength(attribute("height"));
  const box = (attribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const fromBox = box.length === 4 ? positive(box[2] as number, box[3] as number) : undefined;
  if (width !== undefined && height !== undefined) {
    const own = positive(width, height);
    if (own) return own;
  }
  if (fromBox && width !== undefined) return positive(width, (width * fromBox.height) / fromBox.width);
  if (fromBox && height !== undefined) return positive((height * fromBox.width) / fromBox.height, height);
  return fromBox;
}

/** The picture's size in pixels, read from its header with no decoding; undefined when the header does not say. */
export function imageSize(bytes: Buffer, kind: ImageKind): ImageSize | undefined {
  try {
    if (kind === "png") return pngSize(bytes);
    if (kind === "jpg") return jpegSize(bytes);
    if (kind === "gif") return gifSize(bytes);
    if (kind === "webp") return webpSize(bytes);
    return svgSize(bytes);
  } catch {
    // A header cut short reads past the end of the buffer.
    return undefined;
  }
}

export type ImageRefusalCode = "too-large" | "unsupported" | "not-a-file" | "unreadable" | "bad-folder";

/** A file that cannot be added, with a code a caller can switch on and a message it can show. */
export class ImageRefused extends Error {
  readonly code: ImageRefusalCode;
  constructor(code: ImageRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const UNSUPPORTED_MESSAGE =
  "Only PNG, JPEG, GIF, WebP and plain SVG images can be added. SVG with script is refused.";
export const TOO_LARGE_MESSAGE = `Images can be up to ${MAX_ASSET_BYTES / (1024 * 1024)} MB.`;

export interface AddedImage {
  /** The deck-relative path to put in an image block's `asset`, for example `assets/chart-1a2b3c4d.png`. */
  asset: string;
  kind: ImageKind;
  bytes: number;
  width?: number;
  height?: number;
}

const sizeFields = (size: ImageSize | undefined) => (size ? { width: size.width, height: size.height } : {});

/**
 * Stores an image in the folder's `assets/` under a name made from `name` and a hash of the bytes. The same bytes under
 * the same name are the same file, so adding twice changes nothing. The file appears whole or not at all.
 */
export function addImage(folder: string, bytes: Buffer, name: string): AddedImage {
  if (bytes.length > MAX_ASSET_BYTES) throw new ImageRefused("too-large", TOO_LARGE_MESSAGE);
  const kind = sniffImage(bytes);
  if (!kind) throw new ImageRefused("unsupported", UNSUPPORTED_MESSAGE);
  const dir = join(folder, "assets");
  // An assets folder that is a link could send the file anywhere.
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new ImageRefused("bad-folder", "The deck's assets folder is a link, so nothing was added.");
  }
  const file = assetName(name, kind, bytes);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, file);
  if (!existsSync(target)) {
    const temporary = `${target}.depthcue-${process.pid}.tmp`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, target);
  }
  return { asset: `assets/${file}`, kind, bytes: bytes.length, ...sizeFields(imageSize(bytes, kind)) };
}

/**
 * Reads a local file to add. Only a regular file qualifies, not a link and not a folder, and only up to the size limit:
 * the file is never read first and measured after.
 */
export function readImageFile(path: string): { bytes: Buffer; name: string } {
  if (!isAbsolute(path)) throw new ImageRefused("not-a-file", `${path} is not an absolute path.`);
  // A network share: reading there would also sign in to whatever server the path names.
  if (/^[\\/]{2}/.test(path) && !/^[\\/]{2}[?.][\\/][a-z]:[\\/]/i.test(path)) {
    throw new ImageRefused(
      "not-a-file",
      `${path} is on a network share. Copy the file to this machine first.`,
    );
  }
  const full = resolve(path);
  const info = lstatSync(full, { throwIfNoEntry: false });
  if (!info) throw new ImageRefused("unreadable", `${path} does not exist.`);
  if (!info.isFile()) {
    throw new ImageRefused(
      "not-a-file",
      `${path} is not a regular file (a link or a folder is not accepted).`,
    );
  }
  if (info.size > MAX_ASSET_BYTES) throw new ImageRefused("too-large", TOO_LARGE_MESSAGE);
  let bytes: Buffer;
  try {
    const fd = openSync(full, "r");
    try {
      const buffer = Buffer.alloc(MAX_ASSET_BYTES + 1);
      const got = readSync(fd, buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, got);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    throw new ImageRefused("unreadable", `${path} could not be read: ${(error as Error).message}`);
  }
  if (bytes.length > MAX_ASSET_BYTES) throw new ImageRefused("too-large", TOO_LARGE_MESSAGE);
  return { bytes, name: basename(full) };
}

/** Where a file is named: a scene (or null for deck.json, which holds the saved links) and the JSON pointer. */
export interface ImageUse {
  scene: string | null;
  path: string;
}

export interface ListedImage {
  asset: string;
  kind: ImageKind;
  bytes: number;
  width?: number;
  height?: number;
  usedBy: ImageUse[];
}

/** Every place the deck names each asset file: scene blocks, sources, and the deck's saved links. */
export function usesOf(doc: Doc): Map<string, ImageUse[]> {
  const uses = new Map<string, ImageUse[]>();
  const add = (asset: string, use: ImageUse) => {
    const list = uses.get(asset) ?? [];
    list.push(use);
    uses.set(asset, list);
  };
  for (const id of doc.deck.scenes) {
    for (const ref of assetRefs(doc.scenes[id] as Doc["scenes"][string]))
      add(ref.asset, { scene: id, path: ref.path });
  }
  for (const ref of deckAssetRefs(doc.deck)) add(ref.asset, { scene: null, path: ref.path });
  return uses;
}

/** One asset file as an image: undefined when it is not a regular file of a kind we know. */
function readListed(folder: string, asset: string): { kind: ImageKind; bytes: Buffer } | undefined {
  if (!isImageName(asset)) return undefined;
  const full = join(folder, asset);
  const info = lstatSync(full, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size > MAX_ASSET_BYTES) return undefined;
  const bytes = readFileSync(full);
  const kind = sniffImage(bytes);
  return kind ? { kind, bytes } : undefined;
}

/** Every image file under `assets/`, with its size and where the deck names it, in path order. */
export function listImages(folder: string, doc: Doc): ListedImage[] {
  const uses = usesOf(doc);
  const out: ListedImage[] = [];
  for (const asset of [...doc.assets].sort()) {
    const read = readListed(folder, asset);
    if (!read) continue;
    out.push({
      asset,
      kind: read.kind,
      bytes: read.bytes.length,
      ...sizeFields(imageSize(read.bytes, read.kind)),
      usedBy: uses.get(asset) ?? [],
    });
  }
  return out;
}

export type RemoveOutcome =
  | { ok: true; asset: string }
  | { ok: false; code: "not-an-image" | "in-use"; message: string; usedBy?: ImageUse[] };

/** Deletes an unused image from `assets/`. Anything else, and anything the deck names, is refused. */
export function removeImage(folder: string, doc: Doc, asset: string): RemoveOutcome {
  if (!doc.assets.has(asset) || !asset.startsWith("assets/") || readListed(folder, asset) === undefined) {
    return {
      ok: false,
      code: "not-an-image",
      message: `${asset} is not an image file in the deck's assets folder, so it was not removed.`,
    };
  }
  const usedBy = usesOf(doc).get(asset) ?? [];
  if (usedBy.length > 0) {
    return {
      ok: false,
      code: "in-use",
      message: `${asset} is used ${usedBy.length} time${usedBy.length === 1 ? "" : "s"}, so it was not removed. Point those uses at another file first.`,
      usedBy,
    };
  }
  unlinkSync(join(folder, asset));
  return { ok: true, asset };
}

/** `asset-large`: a warning for an image a scene uses that is over 4 MB. One per place it is used. */
export function largeImageDiagnostics(folder: string, doc: Doc): Diagnostic[] {
  const sizes = new Map<string, number>();
  const sizeOf = (asset: string): number => {
    let size = sizes.get(asset);
    if (size === undefined) {
      size = isImageName(asset) ? (statSync(join(folder, asset), { throwIfNoEntry: false })?.size ?? 0) : 0;
      sizes.set(asset, size);
    }
    return size;
  };
  const out: Diagnostic[] = [];
  for (const id of doc.deck.scenes) {
    for (const ref of assetRefs(doc.scenes[id] as Doc["scenes"][string])) {
      const size = sizeOf(ref.asset);
      if (size <= LARGE_ASSET_BYTES) continue;
      out.push({
        severity: "warning",
        code: "asset-large",
        file: `scenes/${id}.json`,
        path: ref.path,
        message: `${ref.asset} is ${(size / (1024 * 1024)).toFixed(1)} MB. Images over 4 MB slow the page and make exports larger.`,
        fix: "Export the picture again at the size it is shown (1920 pixels wide is enough for a full slide), or as JPEG or WebP, and use that file instead.",
      });
    }
  }
  return out;
}
