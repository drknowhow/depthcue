/**
 * Writes the brand folder. A folder this command wrote before is replaced, and only the files it wrote; a folder with
 * anything else in it is refused before a file is touched. The marker file lists what was written, as the offline export's
 * does, so a person's own files beside the brand are never overwritten or removed.
 */
import {
  existsSync,
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

export type WriteErrorCode = "out-is-file" | "out-not-ours" | "out-in-source" | "write-failed";

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

/** A path a marker may list: relative, forward slashes, no way up and out. */
const safeListed = (path: unknown): path is string =>
  typeof path === "string" &&
  path !== "" &&
  !/[\\:]/.test(path) &&
  !path.split("/").some((part) => part === "" || part === "." || part === "..");

/** What an earlier import wrote into `out`, or undefined when the folder is not one. */
function readMarker(out: string): string[] | undefined {
  try {
    const marker = JSON.parse(readFileSync(join(out, IMPORT_MARKER), "utf8")) as {
      format?: unknown;
      files?: unknown;
    };
    if (marker.format !== IMPORT_FORMAT || !Array.isArray(marker.files)) return undefined;
    return marker.files.every(safeListed) ? (marker.files as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks that `out` can take the brand, before anything is written or removed: a new or empty folder, or an earlier
 * import. Returns the files the earlier import wrote that this one will not.
 */
function claim(out: string, writing: ReadonlySet<string>): string[] {
  if (!existsSync(out)) return [];
  if (!statSync(out).isDirectory()) {
    throw new WriteError("out-is-file", `${out} is a file. Pick a folder for --out.`);
  }
  if (readdirSync(out).length === 0) return [];
  const earlier = readMarker(out);
  if (!earlier) {
    throw new WriteError(
      "out-not-ours",
      `${out} has files in it and was not made by depthcue brand import, so nothing was written. Pick another --out, or empty it first.`,
    );
  }
  const mine = new Set(earlier);
  for (const path of writing) {
    if (existsSync(join(out, path)) && !mine.has(path)) {
      throw new WriteError(
        "out-not-ours",
        `${join(out, path)} exists and the earlier import did not write it, so nothing was written. Move it, or pick another --out.`,
      );
    }
  }
  return earlier.filter((path) => !writing.has(path));
}

/** Removes what an earlier import wrote that this one does not, and the folders that leaves empty. */
function sweep(out: string, stale: readonly string[]): void {
  for (const path of stale) {
    rmSync(join(out, path), { force: true });
    for (let dir = dirname(join(out, path)); dir !== out && within(out, dir); dir = dirname(dir)) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    }
  }
}

/** Writes the files, replacing an earlier import's. `files` are by path from the folder, with forward slashes. */
export function writeBrand(
  out: string,
  source: string,
  files: ReadonlyMap<string, Uint8Array | string>,
): void {
  if (within(out, source)) {
    throw new WriteError(
      "out-in-source",
      `The file being imported is inside ${out}. Pick a folder that does not hold it for --out.`,
    );
  }
  const writing = new Set(files.keys());
  const stale = claim(out, writing);
  try {
    mkdirSync(out, { recursive: true });
    // The marker goes first, so an import that stops half-way can still be replaced by the next one.
    writeFileSync(
      join(out, IMPORT_MARKER),
      `${JSON.stringify({ format: IMPORT_FORMAT, files: [...writing].sort() }, null, 2)}\n`,
    );
    sweep(out, stale);
    for (const [path, data] of files) {
      const to = join(out, ...path.split("/"));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, data);
    }
  } catch (error) {
    throw new WriteError("write-failed", `Could not write ${out}: ${(error as Error).message}`);
  }
}
