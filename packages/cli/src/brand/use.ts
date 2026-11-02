/**
 * `depthcue brand use`: copies a brand folder into a deck as real files and makes it the deck's brand. The brand's
 * JSON goes in as the operations `apply` would run (`brand.set`, `style.set`, `template.set`), against the revision the
 * deck has now, saved by the same code, so it meets the same guards: a deck that changed meanwhile is refused, and a
 * brand folder that is a link is too. The fonts, logos and images are copied byte for byte before that, and put back
 * if the save is refused or anything fails before it is done. Their hashes are part of the deck's revision, so the save
 * is checked against the deck as it will be with them copied, and the revision reported is the one with all of them. A
 * record beside them (see record.ts) lets the next `use` replace what it copied and refuse what someone changed.
 *
 * What the earlier brand had that this one does not is removed only when it is safe to: not through a link, not when it
 * was changed since, not when a file of the new brand has the same name in other letter case, and not while the review
 * of the deck still holds the earlier brand, which a revert would need.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  applyOps,
  BRAND_DIR,
  type Brand,
  type BrandChanges,
  type BrandPart,
  brandFilePath,
  type Diagnostic,
  type Doc,
  docToFiles,
  type NewTemplate,
  type Op,
  retemplate,
  revisionOf,
  type Scene,
  templatesOf,
} from "@depthcue/core";
import { openDeck } from "../deck-api.ts";
import { brandHashEntries, isNameableBrandFile, loadDeckDir } from "../loader.ts";
import { loadReviewDir, recordAgentWrite } from "../review-file.ts";
import { ChangedOnDiskError, RefusedSaveError, saveDeckDir } from "../save.ts";
import { checkBrandSource } from "./check.ts";
import { isJsonFile, readUseRecord, recordText, sha256, USE_RECORD } from "./record.ts";
import type { BrandSource } from "./source.ts";

/** A scene that uses a template the new brand does not have, and the operations that would move it to one it has. */
export interface MissingTemplate {
  scene: string;
  template: string;
  move: { template: string; ops: Op[]; unplaced: string[] } | null;
}

/** A file of the deck's brand folder that the replacement would overwrite or remove, or left alone, and why. */
export interface ChangedFile {
  path: string;
  why: string;
}

export type UseFailureCode =
  | "brand-invalid"
  | "unreadable-deck"
  | "linked-brand-folder"
  | "changed-files"
  | "missing-templates"
  | "after-failed"
  | "bad-op"
  | "invalid-deck"
  | "changed-on-disk"
  | "refused-save"
  | "write-failed"
  | "incomplete";

export type UseResult =
  | {
      ok: true;
      brand: { id: string; name: string };
      /** The brand the deck had, when the deck had one. */
      replaced: { id: string; name: string } | null;
      /** Nothing in the deck differs from the brand folder, so nothing was written. */
      upToDate: boolean;
      prevRev: string;
      rev: string;
      /** The JSON files the save wrote or removed, from the deck folder. */
      written: string[];
      /** Fonts, logos and images written, from the deck folder. */
      copied: string[];
      /** Fonts, logos and images already there with the same bytes. */
      unchanged: string[];
      /** Files an earlier copy made that this brand does not have, removed. */
      removed: string[];
      /** Files an earlier copy made that this brand does not have, left where they are, and why. */
      kept: ChangedFile[];
      /** What `--force` replaced although it was not as copied. */
      overwrote: ChangedFile[];
      /** The brand-wide findings, and a warning for each step after the save that did not finish. */
      diagnostics: Diagnostic[];
    }
  | {
      ok: false;
      code: UseFailureCode;
      message: string;
      diagnostics: Diagnostic[];
      files?: ChangedFile[];
      scenes?: MissingTemplate[];
      /** The deck's revision, when it was read. */
      rev?: string;
    };

export interface UseOptions {
  /** Replace a deck brand whose files are not as the last copy left them. Never lifts the missing-template refusal. */
  force: boolean;
  /**
   * More operations for the same transaction, after the brand's: `new` moves its first scene onto the brand's title
   * template with them. A string refuses the use, naming why.
   */
  after?: (part: BrandPart, doc: Doc) => Op[] | string;
  /** False for a deck being made, which has no review to start. */
  review?: boolean;
}

const isError = (found: Diagnostic): boolean => found.severity === "error";

const fail = (
  code: UseFailureCode,
  message: string,
  rest: { diagnostics?: Diagnostic[]; files?: ChangedFile[]; scenes?: MissingTemplate[]; rev?: string } = {},
): UseResult => ({ ok: false, code, message, diagnostics: rest.diagnostics ?? [], ...rest });

/** The exit code of each failure. */
export const USE_EXIT: Readonly<Record<UseFailureCode, number>> = {
  "brand-invalid": 1,
  "unreadable-deck": 2,
  "linked-brand-folder": 2,
  "changed-files": 1,
  "missing-templates": 1,
  "after-failed": 1,
  "bad-op": 1,
  "invalid-deck": 1,
  "changed-on-disk": 3,
  "refused-save": 2,
  "write-failed": 2,
  incomplete: 2,
};

/** The first place on the way to a path where the deck has a link, or not the kind of thing a brand's file goes in. */
interface Blocker {
  at: string;
  link: boolean;
  /** The place is a folder in the path, not its last name. */
  folder: boolean;
}

/** What stops a copy from writing into the deck, or a removal from reaching outside it: a link on the way to a path. */
function blockerOf(deck: string, paths: Iterable<string>): Blocker | undefined {
  const seen = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join("/");
      if (seen.has(at)) continue;
      seen.add(at);
      let found: Stats;
      try {
        found = lstatSync(join(deck, ...at.split("/")));
      } catch {
        break; // Nothing there yet, and nothing under it.
      }
      const folder = i < parts.length;
      if (found.isSymbolicLink()) return { at, link: true, folder };
      if (folder ? !found.isDirectory() : !found.isFile()) return { at, link: false, folder };
    }
  }
  return undefined;
}

const copyProblem = ({ at, link, folder }: Blocker): string =>
  link
    ? `${at} in the deck is a link, so copying the brand would write outside the deck. Replace the link with a copy of the folder.`
    : `${at} in the deck is not ${folder ? "a folder" : "a plain file"}, so the brand cannot be copied there.`;

/** The scenes that name a template the brand does not have, each with the move to one it has that leaves fewest blocks over. */
function missingTemplates(part: BrandPart, doc: Doc): MissingTemplate[] {
  const kit = templatesOf(part);
  const out: MissingTemplate[] = [];
  for (const id of doc.deck.scenes) {
    const template = (doc.scenes[id] as Scene).template;
    if (template === undefined || Object.hasOwn(kit, template)) continue;
    let best: MissingTemplate["move"] = null;
    for (const candidate of Object.keys(kit)) {
      const found = retemplate({ ...part, scenes: doc.scenes }, id, { template: candidate });
      if (best === null || found.unplaced.length < best.unplaced.length) {
        best = { template: candidate, ops: found.ops, unplaced: found.unplaced };
      }
    }
    out.push({ scene: id, template, move: best });
  }
  return out;
}

/** Writes a file whole or not at all: a temporary file beside it, renamed over it, and removed if either step fails. */
function writeWhole(abs: string, data: Uint8Array | string): void {
  const temporary = `${abs}.depthcue-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, abs);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The error that matters is the one below.
    }
    throw error;
  }
}

interface Touched {
  abs: string;
  before: Buffer | undefined;
}

/** Writes files whole, and remembers what was there, so that a failure or a refused save can put it back. */
function writer() {
  const touched: Touched[] = [];
  const made: string[] = [];
  return {
    put(abs: string, data: Uint8Array | string): void {
      const before = existsSync(abs) ? readFileSync(abs) : undefined;
      const fresh: string[] = [];
      for (let dir = dirname(abs); !existsSync(dir); dir = dirname(dir)) fresh.push(dir);
      mkdirSync(dirname(abs), { recursive: true });
      made.push(...fresh);
      writeWhole(abs, data);
      touched.push({ abs, before });
    },
    /** Removes a file, remembering its bytes. */
    remove(abs: string): void {
      const before = existsSync(abs) ? readFileSync(abs) : undefined;
      rmSync(abs, { force: true });
      if (before !== undefined) touched.push({ abs, before });
    },
    /** Puts back every file written, as it was, and returns the ones that could not be. */
    undo(): string[] {
      const stuck: string[] = [];
      for (const { abs, before } of touched.reverse()) {
        try {
          if (before === undefined) rmSync(abs, { force: true });
          else writeWhole(abs, before);
        } catch {
          stuck.push(abs);
        }
      }
      for (const folder of [...new Set(made)].sort((a, b) => b.length - a.length)) {
        try {
          rmdirSync(folder);
        } catch {
          // Something else is in it now; it stays.
        }
      }
      return stuck;
    },
  };
}

/**
 * `doc` with its brand files' hashes as they are once `put` (path in brand/ to bytes) is written, counting only the
 * files a brand.json can name, as the loader does.
 */
function withHashes(doc: Doc, put: Iterable<readonly [string, Uint8Array]>): Doc {
  const hashes: Record<string, string> = { ...doc.brandHashes };
  for (const [path, data] of put) if (isNameableBrandFile(path)) hashes[brandFilePath(path)] = sha256(data);
  return { ...doc, brandHashes: Object.keys(hashes).length > 0 ? hashes : undefined };
}

/** Removes empty folders from `file`'s up to, not including, `stop`. */
function sweepEmpty(stop: string, file: string): void {
  for (let dir = dirname(file); dir !== stop && dir.startsWith(stop); dir = dirname(dir)) {
    if (!existsSync(dir) || readdirSync(dir).length > 0) break;
    rmdirSync(dir);
  }
}

/** Every string in the brand and the templates a review holds as the reviewed deck's, which name the files it needs. */
function reviewedNames(deck: string): (name: string) => boolean {
  try {
    const read = loadReviewDir(deck);
    if (!read.ok || read.review?.brand === undefined) return () => false;
    const names = new Set<string>();
    const walk = (value: unknown): void => {
      if (typeof value === "string") names.add(value);
      else if (typeof value === "object" && value !== null)
        for (const item of Object.values(value)) walk(item);
    };
    walk(read.review.brand);
    walk(read.review.templates);
    return (name) => names.has(name);
  } catch {
    // Not knowing what the review holds, nothing it might need is removed.
    return () => true;
  }
}

const unfinished = (message: string, fix: string): Diagnostic => ({
  severity: "warning",
  code: "brand-use-incomplete",
  file: BRAND_DIR,
  path: "",
  message,
  fix,
});

/** Copies the brand into the deck folder and makes it the deck's brand, or says why not and leaves the deck as it was. */
export function useBrand(deck: string, source: BrandSource, options: UseOptions): UseResult {
  const checked = checkBrandSource(source);
  const part = checked.part;
  if (checked.diagnostics.some(isError) || part?.brand === undefined) {
    return fail(
      "brand-invalid",
      `${source.dir} fails brand check, so nothing was copied. Fix the errors it names (depthcue brand check ${source.dir}) and run this again.`,
      { diagnostics: checked.diagnostics },
    );
  }
  const brand = part.brand;
  const templates = part.templates ?? {};
  const opened = openDeck(deck);
  if (!opened.ok) {
    return fail(
      "unreadable-deck",
      `${deck} has errors that must be fixed first, so nothing was copied. Run depthcue check on it.`,
      { diagnostics: opened.diagnostics },
    );
  }
  const doc = opened.doc;
  const base = revisionOf(doc);
  const deckBrandFolder = join(deck, BRAND_DIR);
  const incoming = [...source.binaries.keys()];

  const linked = blockerOf(deck, [USE_RECORD, ...incoming.map(brandFilePath)]);
  if (linked !== undefined) return fail("linked-brand-folder", copyProblem(linked), { rev: base });

  const missing = missingTemplates(part, doc);
  if (missing.length > 0) {
    return fail(
      "missing-templates",
      `${missing.length === 1 ? "A scene uses" : `${missing.length} scenes use`} a template the brand "${brand.id}" does not have, so nothing was copied.`,
      { scenes: missing, rev: base },
    );
  }

  // What the deck's brand files are now, to compare with what the last copy left. A file is there only under the name
  // it was written with, in every letter of it: on a computer that ignores case, `Bold.woff2` also answers to
  // `bold.woff2`, and a deck that holds one must not be read as holding the other.
  const place = (path: string): string => join(deckBrandFolder, ...path.split("/"));
  const exact = (path: string): boolean => {
    let dir = deckBrandFolder;
    for (const segment of path.split("/")) {
      try {
        if (!readdirSync(dir).includes(segment)) return false;
      } catch {
        return false;
      }
      dir = join(dir, segment);
    }
    return true;
  };
  const diskHash = (path: string): string | undefined => {
    try {
      if (!exact(path)) return undefined;
      return lstatSync(place(path)).isFile() ? sha256(readFileSync(place(path))) : "not-a-file";
    } catch {
      return undefined;
    }
  };
  /** The name a file of the deck has that differs from `path` only in letter case, when there is such a file. */
  const caseMate = (path: string): string | undefined => {
    if (exact(path)) return undefined;
    try {
      const parts = path.split("/");
      const last = parts.pop() as string;
      const mate = readdirSync(dirname(place(path))).find(
        (name) => name !== last && name.toLowerCase() === last.toLowerCase(),
      );
      return mate === undefined ? undefined : [...parts, mate].join("/");
    } catch {
      return undefined;
    }
  };
  const currentJson = new Map<string, string>();
  if (doc.brand !== undefined) {
    for (const [path, text] of Object.entries(docToFiles(doc))) {
      if (path.startsWith(`${BRAND_DIR}/`)) currentJson.set(path.slice(BRAND_DIR.length + 1), sha256(text));
    }
  }
  const record = readUseRecord(deck);
  const changed = new Map<string, string>();
  if (doc.brand !== undefined) {
    if (record === undefined) {
      for (const path of currentJson.keys()) {
        changed.set(path, "has no record of being copied by brand use, so it may have been edited");
      }
    } else {
      for (const [path, accepted] of record.files) {
        const now = isJsonFile(path) ? currentJson.get(path) : diskHash(path);
        if (now === undefined) changed.set(path, "was removed after it was copied");
        else if (!accepted.includes(now)) changed.set(path, "was changed after it was copied");
      }
      for (const path of currentJson.keys()) {
        if (!record.files.has(path)) changed.set(path, "was added after the brand was copied");
      }
    }
  }
  // A file of the brand's that is already in the deck's brand folder with other bytes, or under another case, is overwritten.
  const mates = new Map<string, string>();
  for (const [path, data] of source.binaries) {
    const mate = caseMate(path);
    if (mate !== undefined) {
      mates.set(path, mate);
      if (!record?.files.get(mate)?.includes(diskHash(mate) as string) && !changed.has(path)) {
        changed.set(
          path,
          `differs only in letter case from ${mate}, which is in the deck and was not copied by brand use`,
        );
      }
      continue;
    }
    const there = diskHash(path);
    if (there === undefined || there === sha256(data)) continue;
    if (record?.files.get(path)?.includes(there)) continue;
    if (!changed.has(path)) {
      changed.set(
        path,
        record?.files.has(path)
          ? "was changed after it was copied"
          : "is in the deck already, was not copied by brand use and differs from the brand's",
      );
    }
  }
  const overwrote: ChangedFile[] = [...changed].map(([path, why]) => ({ path: brandFilePath(path), why }));
  if (overwrote.length > 0 && !options.force) {
    return fail(
      "changed-files",
      doc.brand === undefined
        ? `Files in ${deckBrandFolder} would be overwritten and are not as brand use copied them, so nothing was copied.`
        : `The deck's brand "${doc.brand.id}" is not as brand use left it, so nothing was replaced.`,
      { files: overwrote, rev: base },
    );
  }

  const {
    schemaVersion: _version,
    $schema: _schema,
    styles,
    ...rest
  } = brand as Brand & { $schema?: string };
  const ops: Op[] = [];
  if (doc.brand !== undefined) ops.push({ op: "brand.set", set: null });
  ops.push({ op: "brand.set", set: rest as BrandChanges });
  for (const [id, style] of Object.entries(styles ?? {})) ops.push({ op: "style.set", id, style });
  for (const [id, template] of Object.entries(templates)) {
    ops.push({ op: "template.set", id, template: template as NewTemplate });
  }
  const more = options.after?.(part, doc);
  if (typeof more === "string") return fail("after-failed", more, { rev: base });
  if (more !== undefined) ops.push(...more);

  // The brand's files are in the deck's list before they are on disk, so the checks see the fonts and logos it names.
  const withFiles: Doc = {
    ...doc,
    brandFiles: new Set([...(doc.brandFiles ?? []), ...incoming.map(brandFilePath)]),
  };
  const result = applyOps(withFiles, ops, base);
  if (!result.ok) {
    return fail(
      result.code === "invalid-deck"
        ? "invalid-deck"
        : result.code === "bad-op"
          ? "bad-op"
          : "changed-on-disk",
      result.code === "invalid-deck"
        ? `The brand does not fit this deck (see below), so nothing was copied.`
        : result.code === "bad-op"
          ? "The brand could not be turned into operations, so nothing was copied."
          : "The deck changed while the brand was being prepared. Nothing was copied; run it again.",
      { diagnostics: result.diagnostics, rev: result.rev },
    );
  }

  const nextJson = new Map<string, string>();
  for (const [path, text] of Object.entries(docToFiles(result.doc))) {
    if (path.startsWith(`${BRAND_DIR}/`)) nextJson.set(path.slice(BRAND_DIR.length + 1), sha256(text));
  }
  const final = new Map<string, string>(nextJson);
  const toCopy: string[] = [];
  const unchanged: string[] = [];
  for (const [path, data] of source.binaries) {
    final.set(path, sha256(data));
    (diskHash(path) === final.get(path) ? unchanged : toCopy).push(path);
  }
  // What an earlier copy made and this brand does not have goes, unless it was changed since, is behind a link, or has
  // the name of a file of this brand in other letters, which is that file on a computer that ignores case.
  const incomingLower = new Set(incoming.map((path) => path.toLowerCase()));
  const stale: string[] = [];
  const kept: ChangedFile[] = [];
  const sameName: string[] = [];
  for (const [path, accepted] of record?.files ?? []) {
    if (isJsonFile(path) || source.binaries.has(path)) continue;
    const there = diskHash(path);
    if (there === undefined) continue;
    if (incomingLower.has(path.toLowerCase())) {
      sameName.push(path);
      continue;
    }
    const blocked = blockerOf(deck, [brandFilePath(path)]);
    if (blocked !== undefined) {
      kept.push({
        path: brandFilePath(path),
        why: blocked.link
          ? `is behind the link ${blocked.at}, so it was left where it is`
          : `is behind ${blocked.at}, which is not as it was copied, so it was left where it is`,
      });
    } else if (!accepted.includes(there)) {
      kept.push({ path: brandFilePath(path), why: "was changed after it was copied" });
    } else {
      stale.push(path);
    }
  }
  // Until the copy is done the record accepts a file as it was or as it will be, and a file to go as it is.
  const under = new Map<string, string | readonly string[]>();
  for (const [path, hash] of final) {
    const before = isJsonFile(path) ? currentJson.get(path) : diskHash(path);
    under.set(path, before === undefined || before === hash ? hash : [before, hash]);
  }
  for (const path of stale) under.set(path, diskHash(path) as string);

  // A file that takes the place of one with the same name in other letters is written after the save. Where case does
  // not count it is the same file, and the brand.json on disk until then names it by the old letters.
  const early = toCopy.filter((path) => !mates.has(path));
  const late = toCopy.filter((path) => mates.has(path));
  /** The files the brand carries that are not in the deck under the name brand.json gives them, with their bytes. */
  const notThere = (): string[] =>
    [...source.binaries]
      .filter(([path, data]) => diskHash(path) !== sha256(data))
      .map(([path]) => brandFilePath(path));

  const files = writer();
  const recordFile = join(deck, ...USE_RECORD.split("/"));
  let written: string[];
  try {
    files.put(recordFile, recordText(brand.id, under));
    for (const path of early) files.put(place(path), source.binaries.get(path) as Uint8Array);
    const absent = notThere().filter((path) => !late.map(brandFilePath).includes(path));
    if (absent.length > 0) throw new Error(`${absent.join(", ")} is not in the deck as it was written.`);
    // The save's own steps go through the writer too, so that a step that fails halfway is undone with the rest. It
    // checks the deck against the one read with the files just copied, which are part of its revision.
    const copied = early.map((path) => [path, source.binaries.get(path) as Uint8Array] as const);
    written = saveDeckDir(deck, withHashes(doc, copied), result.doc, {
      write: (dir, path, text) => files.put(join(dir, ...path.split("/")), text),
      remove: (dir, path) => files.remove(join(dir, ...path.split("/"))),
    });
  } catch (error) {
    const stuck = files.undo();
    if (error instanceof ChangedOnDiskError) {
      return fail("changed-on-disk", `${error.message} Nothing was copied.`, { rev: base });
    }
    if (error instanceof RefusedSaveError) {
      return fail("refused-save", `${error.message} Nothing was copied.`, {
        diagnostics: error.diagnostics,
        rev: base,
      });
    }
    return fail(
      "write-failed",
      `The brand could not be copied into ${deck}: ${(error as Error).message} ${
        stuck.length === 0
          ? "Nothing was changed."
          : `These files could not be put back: ${stuck.join(", ")}. Run depthcue check ${deck}.`
      }`,
      { rev: base },
    );
  }

  // The deck is saved. From here an error is a warning, and the record and the review are still written.
  const warnings: Diagnostic[] = [];
  for (const path of late) {
    try {
      files.put(place(path), source.binaries.get(path) as Uint8Array);
      // Replacing a file keeps the letters it had on some computers: set them as the brand gives them.
      if (!exact(path)) {
        renameSync(place(path), `${place(path)}.depthcue-${process.pid}.tmp`);
        renameSync(`${place(path)}.depthcue-${process.pid}.tmp`, place(path));
      }
    } catch (error) {
      warnings.push(
        unfinished(
          `${brandFilePath(path)} could not be written: ${(error as Error).message}`,
          "Copy it from the brand folder by hand, or run brand use again with --force.",
        ),
      );
    }
  }
  // The brand files' hashes as they are now, read back rather than worked out: where letter case counts, a file that
  // replaced one in other letters sits beside it.
  const hashesNow = (): Doc["brandHashes"] => {
    const hashes = brandHashEntries(loadDeckDir(deck));
    return Object.keys(hashes).length > 0 ? hashes : undefined;
  };
  const saved: Doc = { ...result.doc, brandHashes: hashesNow() };
  const recorded: Diagnostic[] = options.review === false ? [] : recordAgentWrite(deck, doc, saved);
  const needed = options.review === false ? () => false : reviewedNames(deck);
  const removed: string[] = [];
  for (const path of stale) {
    // The review still holds the earlier brand, and a revert would need its fonts, logos and images back.
    if (needed(path)) {
      kept.push({
        path: brandFilePath(path),
        why: "is named by the brand under review, which a revert brings back",
      });
      final.set(path, diskHash(path) as string);
      continue;
    }
    try {
      rmSync(place(path), { force: true });
      removed.push(path);
      sweepEmpty(deckBrandFolder, place(path));
    } catch (error) {
      final.set(path, diskHash(path) ?? sha256(""));
      warnings.push(
        unfinished(
          `${brandFilePath(path)} could not be removed: ${(error as Error).message}`,
          "Remove it by hand, or run brand use again.",
        ),
      );
    }
  }
  for (const path of sameName) {
    if (exact(path)) {
      kept.push({
        path: brandFilePath(path),
        why: "differs only in letter case from a file of the new brand, so it was left",
      });
    }
  }
  // A template file the save removed can leave its folder empty.
  for (const path of written) {
    const at = join(deck, ...path.split("/"));
    try {
      if (path.startsWith(`${BRAND_DIR}/`) && !existsSync(at)) sweepEmpty(deckBrandFolder, at);
    } catch {
      // An empty folder left behind is harmless.
    }
  }
  try {
    writeWhole(recordFile, recordText(brand.id, final));
  } catch (error) {
    warnings.push(
      unfinished(
        `The record of the files brand use copied could not be written: ${(error as Error).message}`,
        "Run brand use again with --force.",
      ),
    );
  }
  // The files removed after the save are the agent's changes too.
  const ended: Doc =
    removed.length === 0
      ? saved
      : {
          ...saved,
          brandFiles: new Set(
            [...(saved.brandFiles ?? [])].filter((path) => !removed.map(brandFilePath).includes(path)),
          ),
          brandHashes: hashesNow(),
        };
  if (removed.length > 0 && options.review !== false) recorded.push(...recordAgentWrite(deck, saved, ended));
  // Whatever happened above, the deck must still pass its own checks before this says it is done.
  const again = openDeck(deck);
  if (!again.ok) {
    return fail(
      "incomplete",
      `The brand was copied, but ${deck} no longer passes depthcue check (see below). Nothing was undone.`,
      { diagnostics: again.diagnostics, rev: revisionOf(ended) },
    );
  }
  return {
    ok: true,
    brand: { id: brand.id, name: brand.name },
    replaced: doc.brand === undefined ? null : { id: doc.brand.id, name: doc.brand.name },
    upToDate: written.length === 0 && toCopy.length === 0 && removed.length === 0,
    prevRev: result.prevRev,
    rev: revisionOf(ended),
    written,
    copied: toCopy.map(brandFilePath),
    unchanged: unchanged.map(brandFilePath),
    removed: removed.map(brandFilePath),
    kept,
    // A file that --force allowed for but that was left where it is, being the earlier brand's, was not replaced.
    overwrote: overwrote.filter((file) => !kept.some((left) => left.path === file.path)),
    diagnostics: [...result.diagnostics, ...recorded, ...warnings],
  };
}
