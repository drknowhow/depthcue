/**
 * The record `brand use` leaves in a deck: which files of the brand folder it copied, with a SHA-256 of each as it
 * was written. A later `brand use` replaces the deck's brand only while every file is still as recorded, so a template
 * a person or an agent changed in the deck (`apply` edits brand.json and the templates) is never overwritten unseen.
 * The record sits in the brand folder, so it goes wherever the folder goes, and it is never part of the deck's
 * revision. A marker somebody else wrote cannot name a file of theirs to be removed: it lists only the names a brand
 * folder holds.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND_DIR } from "@depthcue/core";

export const USE_RECORD = `${BRAND_DIR}/.depthcue-brand-use`;
export const USE_FORMAT = "depthcue-brand-use/1";

/** A file's content a record accepts: one hash, or two while a copy is under way (the old content and the new). */
export type Accepted = readonly string[];

/** The names a record may list, as paths from the brand folder. */
const LISTED =
  /^(?:brand\.json|templates\/[a-z][a-z0-9-]{1,63}\.json|(?:fonts|logos|images)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+)$/;
const HASH = /^[0-9a-f]{64}$/;

export const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** The files a `.json` name in the brand folder makes: brand.json and the templates, which the deck's save writes. */
export const isJsonFile = (path: string): boolean => path.endsWith(".json");

export interface UseRecord {
  /** The id of the brand that was copied. */
  readonly brand: string;
  readonly files: ReadonlyMap<string, Accepted>;
}

/** The record in a deck folder, or undefined when there is none this trusts. */
export function readUseRecord(deck: string): UseRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(join(deck, ...USE_RECORD.split("/")), "utf8")) as {
      format?: unknown;
      brand?: unknown;
      files?: unknown;
    };
    const { files } = record;
    if (
      record.format !== USE_FORMAT ||
      typeof record.brand !== "string" ||
      typeof files !== "object" ||
      files === null ||
      Array.isArray(files)
    ) {
      return undefined;
    }
    const listed = new Map<string, Accepted>();
    for (const [path, value] of Object.entries(files)) {
      const hashes: unknown = Array.isArray(value) ? value : [value];
      if (
        !LISTED.test(path) ||
        !Array.isArray(hashes) ||
        hashes.length === 0 ||
        hashes.length > 2 ||
        !hashes.every((hash) => typeof hash === "string" && HASH.test(hash))
      ) {
        return undefined;
      }
      listed.set(path, hashes as string[]);
    }
    return { brand: record.brand, files: listed };
  } catch {
    return undefined;
  }
}

/** The record's text for `files`, sorted by path so equal content is equal text. */
export function recordText(brand: string, files: ReadonlyMap<string, string | Accepted>): string {
  const sorted = Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ format: USE_FORMAT, brand, files: sorted }, null, 2)}\n`;
}
