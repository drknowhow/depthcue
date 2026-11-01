/**
 * Writes the brand folder. A folder this command wrote before is replaced, and only the files it wrote, and only while
 * every one of them is still as it was written; a folder with anything else in it is refused before a file is touched.
 * The marker file lists what was written with a SHA-256 of each file, so what an import may replace or remove is what it
 * can vouch for, byte for byte: a file a person edited (a deck's `apply` adds styles to `brand.json`) stops the import,
 * and a marker somebody else wrote cannot name a file of theirs to be removed.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** Names the file in an imported brand folder that lists what the import wrote. */
export const IMPORT_MARKER = ".depthcue-brand-import";
export const IMPORT_FORMAT = "depthcue-brand-import/1";

export type WriteErrorCode = "out-is-file" | "out-not-ours" | "out-edited" | "out-in-source" | "write-failed";

/** The folder cannot be written. The message says what to change. */
export class WriteError extends Error {
  constructor(
    readonly code: WriteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const within = (parent: string, child: string): boolean => {
  const way = relative(parent, child);
  return way !== ".." && !way.startsWith(`..${sep}`) && !isAbsolute(way);
};

/**
 * The only names an import writes: the brand, its templates, the logo and the pictures of template backgrounds. A marker
 * may list nothing else, so it cannot name a thesis or a photo of somebody's to be removed.
 */
const WRITTEN =
  /^(?:brand\.json|templates\/[a-z][a-z0-9-]*\.json|logos\/logo\.(?:png|svg)|images\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpg|jpeg|png|webp|svg))$/;

const HASH = /^[0-9a-f]{64}$/;

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** A file's content a marker accepts: one hash, or two while an import is under way (the old content and the new). */
type Accepted = readonly string[];

/**
 * What an earlier import wrote into `out`: each file, with the hashes its content may have, or undefined when the folder
 * has no marker this trusts.
 */
function readMarker(out: string): Map<string, Accepted> | undefined {
  try {
    const marker = JSON.parse(readFileSync(join(out, IMPORT_MARKER), "utf8")) as {
      format?: unknown;
      files?: unknown;
    };
    const { files } = marker;
    if (
      marker.format !== IMPORT_FORMAT ||
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
        !WRITTEN.test(path) ||
        !Array.isArray(hashes) ||
        hashes.length === 0 ||
        hashes.length > 2 ||
        !hashes.every((hash) => typeof hash === "string" && HASH.test(hash))
      ) {
        return undefined;
      }
      listed.set(path, hashes as string[]);
    }
    return listed;
  } catch {
    return undefined;
  }
}

interface Claim {
  /** Files the earlier import wrote that this one will not, and that are still there as they were written. */
  stale: string[];
  /** The hash of each file of the earlier import that is still there. */
  current: Map<string, string>;
}

const full = (out: string, path: string): string => join(out, ...path.split("/"));

/**
 * Checks that `out` can take the brand, before anything is written or removed: a new or empty folder, or an earlier
 * import with every file it wrote still as it wrote it.
 */
function claim(out: string, writing: ReadonlySet<string>): Claim {
  const none: Claim = { stale: [], current: new Map() };
  if (!existsSync(out)) return none;
  if (!statSync(out).isDirectory()) {
    throw new WriteError("out-is-file", `${out} is a file. Pick a folder for --out.`);
  }
  if (readdirSync(out).length === 0) return none;
  const earlier = readMarker(out);
  if (!earlier) {
    throw new WriteError(
      "out-not-ours",
      `${out} has files in it and was not made by depthcue brand import, so nothing was written. Pick another --out, or empty it first.`,
    );
  }
  const current = new Map<string, string>();
  for (const [path, accepted] of earlier) {
    let hash: string;
    try {
      // Not a plain file (a folder, a link) is not what an import wrote.
      if (!lstatSync(full(out, path)).isFile()) throw new Error("not a file");
      hash = sha256(readFileSync(full(out, path)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue; // Gone: nothing to protect, nothing to remove.
      throw edited(out, path);
    }
    if (!accepted.includes(hash)) throw edited(out, path);
    current.set(path, hash);
  }
  for (const path of writing) {
    if (existsSync(full(out, path)) && !earlier.has(path)) {
      throw new WriteError(
        "out-not-ours",
        `${full(out, path)} exists and the earlier import did not write it, so nothing was written. Move it, or pick another --out.`,
      );
    }
  }
  return { stale: [...current.keys()].filter((path) => !writing.has(path)).sort(), current };
}

const edited = (out: string, path: string): WriteError =>
  new WriteError(
    "out-edited",
    `${full(out, path)} is not as the earlier import wrote it (it was changed, for example by depthcue apply, or it is not a plain file), so nothing was written and nothing was removed. Move it out of the way, or pick another --out.`,
  );

/** Removes what an earlier import wrote that this one does not, and the folders that leaves empty. */
function sweep(out: string, stale: readonly string[]): void {
  for (const path of stale) {
    rmSync(full(out, path), { force: true });
    for (let dir = dirname(full(out, path)); dir !== out && within(out, dir); dir = dirname(dir)) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    }
  }
}

function writeMarker(out: string, files: ReadonlyMap<string, string | Accepted>): void {
  const sorted = Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(
    join(out, IMPORT_MARKER),
    `${JSON.stringify({ format: IMPORT_FORMAT, files: sorted }, null, 2)}\n`,
  );
}

/**
 * Writes the files, replacing an earlier import's, and says which of its files were removed. `files` are by path from
 * the folder, with forward slashes.
 */
export function writeBrand(
  out: string,
  source: string,
  files: ReadonlyMap<string, Uint8Array | string>,
): { removed: string[] } {
  if (within(out, source)) {
    throw new WriteError(
      "out-in-source",
      `The file being imported is inside ${out}. Pick a folder that does not hold it for --out.`,
    );
  }
  for (const path of files.keys()) {
    // A name the marker could not list would leave the file behind for good; this is a fault in the import.
    if (!WRITTEN.test(path)) {
      throw new WriteError(
        "write-failed",
        `The import made a file named "${path}", which it does not write.`,
      );
    }
  }
  const writing = new Set(files.keys());
  const { stale, current } = claim(out, writing);
  const hashes = new Map([...files].map(([path, data]) => [path, sha256(data)] as const));
  try {
    mkdirSync(out, { recursive: true });
    // The marker goes first, so an import that stops half-way can still be replaced by the next one. Until it is done
    // the marker accepts a file as it was or as it will be, and a file to be removed as it is.
    const under = new Map<string, string | Accepted>();
    for (const [path, hash] of hashes) {
      const before = current.get(path);
      under.set(path, before === undefined || before === hash ? hash : [before, hash]);
    }
    for (const path of stale) under.set(path, current.get(path) as string);
    writeMarker(out, under);
    sweep(out, stale);
    for (const [path, data] of files) {
      const to = full(out, path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data);
    }
    writeMarker(out, hashes);
  } catch (error) {
    throw new WriteError("write-failed", `Could not write ${out}: ${(error as Error).message}`);
  }
  return { removed: stale };
}
