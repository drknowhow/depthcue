/**
 * Reads a brand folder, the one `brand init` makes or `brand import` writes, for `brand use` to copy and `brand check`
 * to check: brand.json, the templates, and the fonts, logos and images beside them. Only those are read; anything else
 * in the folder (the import's marker, a readme) is the author's own and stays where it is. A link inside the folder is
 * refused, so a copy holds the bytes the author sees and never a file from somewhere else.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The folder cannot be read as a brand. The message says what to change. */
export class BrandFolderError extends Error {}

/** The folders whose files a brand carries. */
export const BINARY_DIRS = ["fonts", "logos", "images"] as const;

/** A name inside those folders: letters, digits, dot, dash and underscore, never starting with a dot. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Names Windows keeps for devices, with or without an extension, in any letter case: `con`, `NUL.svg`, `lpt1.png`. */
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A name a brand can carry: the pattern above, not a device name, and not ending in a dot or a space. */
export const carriable = (name: string): boolean =>
  SEGMENT.test(name) && !DEVICE.test(name) && !/[. ]$/.test(name);

export const MAX_FILES = 200;
export const MAX_BYTES = 64 * 1024 * 1024;

export interface BrandSource {
  readonly dir: string;
  /** brand.json as written, not yet checked. */
  readonly brand: unknown;
  /** Each file of templates/ as written, by the name it is saved under without `.json`, not yet checked. */
  readonly templates: Readonly<Record<string, unknown>>;
  /** The files under fonts/, logos/ and images/, by path from the brand folder with forward slashes. */
  readonly binaries: ReadonlyMap<string, Uint8Array>;
}

const kindOf = (path: string): "file" | "directory" | "link" | "missing" | "other" => {
  try {
    const found = lstatSync(path);
    if (found.isSymbolicLink()) return "link";
    if (found.isDirectory()) return "directory";
    return found.isFile() ? "file" : "other";
  } catch {
    return "missing";
  }
};

function readJson(file: string, shown: string): unknown {
  if (kindOf(file) === "link") {
    throw new BrandFolderError(`${shown} is a link. Replace it with the file itself.`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new BrandFolderError(`Could not read ${shown} as JSON: ${(error as Error).message}`);
  }
}

/** Reads the brand folder, or throws a BrandFolderError that says why it cannot be read. */
export function readBrandFolder(dir: string): BrandSource {
  const root = kindOf(dir);
  if (root === "missing") throw new BrandFolderError(`${dir} does not exist.`);
  if (root !== "directory" && root !== "link") throw new BrandFolderError(`${dir} is not a folder.`);
  if (kindOf(join(dir, "brand.json")) === "missing") {
    throw new BrandFolderError(
      kindOf(join(dir, "brand", "brand.json")) === "file"
        ? `${dir} has no brand.json. It looks like a deck folder: give its brand folder, ${join(dir, "brand")}.`
        : `${dir} has no brand.json, so it is not a brand folder. Make one with: depthcue brand init <dir>`,
    );
  }
  const brand = readJson(join(dir, "brand.json"), "brand.json");

  const templates: Record<string, unknown> = {};
  const templatesDir = join(dir, "templates");
  const templatesKind = kindOf(templatesDir);
  if (templatesKind === "link") {
    throw new BrandFolderError("templates is a link. Replace it with a copy of the folder.");
  }
  if (templatesKind === "directory") {
    for (const name of readdirSync(templatesDir).sort()) {
      if (!name.endsWith(".json")) continue;
      // Own-property definition, so a file named __proto__.json is a template the checks refuse, never a prototype.
      Object.defineProperty(templates, name.slice(0, -".json".length), {
        value: readJson(join(templatesDir, name), `templates/${name}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  const binaries = new Map<string, Uint8Array>();
  let bytes = 0;
  const take = (path: string): void => {
    const full = join(dir, ...path.split("/"));
    const kind = kindOf(full);
    if (kind === "link") {
      throw new BrandFolderError(`${path} is a link. A brand copied into a deck holds real files only.`);
    }
    if (kind === "directory") {
      for (const name of readdirSync(full).sort()) {
        if (!carriable(name)) {
          throw new BrandFolderError(
            `${path}/${name} has a name a brand cannot carry. Use letters, digits, dots, dashes and underscores, not starting with a dot or ending in one, and not a name Windows keeps for a device, such as con, nul, aux, prn, com1 or lpt1.`,
          );
        }
        take(`${path}/${name}`);
      }
      return;
    }
    if (kind !== "file") throw new BrandFolderError(`${path} is not a plain file.`);
    // The size is read before the file, so a file over the limit is never held in memory.
    const size = lstatSync(full).size;
    if (binaries.size >= MAX_FILES || bytes + size > MAX_BYTES) {
      throw new BrandFolderError(
        `The brand carries more than ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB of fonts, logos and images.`,
      );
    }
    bytes += size;
    binaries.set(path, readFileSync(full));
  };
  for (const name of BINARY_DIRS) {
    const kind = kindOf(join(dir, name));
    if (kind === "missing") continue;
    if (kind !== "directory" && kind !== "link") throw new BrandFolderError(`${name} is not a folder.`);
    take(name);
  }
  return { dir, brand, templates, binaries };
}
