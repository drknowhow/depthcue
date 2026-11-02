/**
 * `depthcue brand use`: copies a brand folder into a deck as real files and makes it the deck's brand. The brand's
 * JSON goes in as the operations `apply` would run (`brand.set`, `style.set`, `template.set`), against the revision the
 * deck has now, saved by the same code, so it meets the same guards: a deck that changed meanwhile is refused, and a
 * brand folder that is a link is too. The fonts, logos and images are copied byte for byte before that, and put back
 * if the save is refused. They are not part of the deck's revision: the revision is the token for edits by operations,
 * which never touch these files, and the editor does not hold their bytes. A record beside them (see record.ts) lets the
 * next `use` replace what it copied and refuse what someone changed.
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
import { recordAgentWrite } from "../review-file.ts";
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

/** A file of the deck's brand folder that the replacement would overwrite or remove, and why it is not safe to. */
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
  | "refused-save";

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
      /** Files an earlier copy made that this brand does not have, left because they were changed since. */
      kept: string[];
      /** What `--force` replaced although it was not as copied. */
      overwrote: ChangedFile[];
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
};

/** What stops a copy from writing into the deck: a link where a folder or a file of the brand goes. */
function linkProblem(deck: string, paths: Iterable<string>): string | undefined {
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
      if (found.isSymbolicLink()) {
        return `${at} in the deck is a link, so copying the brand would write outside the deck. Replace the link with a copy of the folder.`;
      }
      if (i < parts.length ? !found.isDirectory() : !found.isFile()) {
        return `${at} in the deck is not ${i < parts.length ? "a folder" : "a plain file"}, so the brand cannot be copied there.`;
      }
    }
  }
  return undefined;
}

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

interface Touched {
  abs: string;
  before: Buffer | undefined;
}

/** Writes a file whole or not at all, and remembers what was there, so a refused save can put it back. */
function writer() {
  const touched: Touched[] = [];
  const made: string[] = [];
  return {
    put(abs: string, data: Uint8Array | string): void {
      touched.push({ abs, before: existsSync(abs) ? readFileSync(abs) : undefined });
      const first = mkdirSync(dirname(abs), { recursive: true });
      if (first !== undefined) made.push(first);
      const temporary = `${abs}.depthcue-${process.pid}.tmp`;
      writeFileSync(temporary, data);
      renameSync(temporary, abs);
    },
    undo(): void {
      for (const { abs, before } of touched.reverse()) {
        if (before === undefined) rmSync(abs, { force: true });
        else writeFileSync(abs, before);
      }
      for (const folder of made.reverse()) {
        try {
          rmdirSync(folder);
        } catch {
          // Something else is in it now; it stays.
        }
      }
    },
  };
}

/** Removes empty folders from `file`'s up to, not including, `stop`. */
function sweepEmpty(stop: string, file: string): void {
  for (let dir = dirname(file); dir !== stop && dir.startsWith(stop); dir = dirname(dir)) {
    if (!existsSync(dir) || readdirSync(dir).length > 0) break;
    rmdirSync(dir);
  }
}

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

  const linked = linkProblem(deck, [USE_RECORD, ...incoming.map(brandFilePath)]);
  if (linked !== undefined) return fail("linked-brand-folder", linked, { rev: base });

  const missing = missingTemplates(part, doc);
  if (missing.length > 0) {
    return fail(
      "missing-templates",
      `${missing.length === 1 ? "A scene uses" : `${missing.length} scenes use`} a template the brand "${brand.id}" does not have, so nothing was copied.`,
      { scenes: missing, rev: base },
    );
  }

  // What the deck's brand files are now, to compare with what the last copy left.
  const diskHash = (path: string): string | undefined => {
    try {
      const at = join(deckBrandFolder, ...path.split("/"));
      return lstatSync(at).isFile() ? sha256(readFileSync(at)) : "not-a-file";
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
  // A file of the brand's that is already in the deck's brand folder with other bytes is overwritten.
  for (const [path, data] of source.binaries) {
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
  // What an earlier copy made and this brand does not have goes, unless it was changed since.
  const stale: string[] = [];
  const kept: string[] = [];
  for (const [path, accepted] of record?.files ?? []) {
    if (isJsonFile(path) || source.binaries.has(path)) continue;
    const there = diskHash(path);
    if (there === undefined) continue;
    (accepted.includes(there) ? stale : kept).push(path);
  }
  // Until the copy is done the record accepts a file as it was or as it will be, and a file to go as it is.
  const under = new Map<string, string | readonly string[]>();
  for (const [path, hash] of final) {
    const before = isJsonFile(path) ? currentJson.get(path) : diskHash(path);
    under.set(path, before === undefined || before === hash ? hash : [before, hash]);
  }
  for (const path of stale) under.set(path, diskHash(path) as string);

  const files = writer();
  const recordFile = join(deck, ...USE_RECORD.split("/"));
  let written: string[];
  try {
    files.put(recordFile, recordText(brand.id, under));
    for (const path of toCopy) {
      files.put(join(deckBrandFolder, ...path.split("/")), source.binaries.get(path) as Uint8Array);
    }
    written = saveDeckDir(deck, doc, result.doc);
  } catch (error) {
    if (error instanceof ChangedOnDiskError) {
      files.undo();
      return fail("changed-on-disk", `${error.message} Nothing was copied.`, { rev: base });
    }
    if (error instanceof RefusedSaveError) {
      files.undo();
      return fail("refused-save", `${error.message} Nothing was copied.`, {
        diagnostics: error.diagnostics,
        rev: base,
      });
    }
    throw error;
  }
  for (const path of stale) {
    const at = join(deckBrandFolder, ...path.split("/"));
    rmSync(at, { force: true });
    sweepEmpty(deckBrandFolder, at);
  }
  // A template file the save removed can leave its folder empty.
  for (const path of written) {
    const at = join(deck, ...path.split("/"));
    if (path.startsWith(`${BRAND_DIR}/`) && !existsSync(at)) sweepEmpty(deckBrandFolder, at);
  }
  files.put(recordFile, recordText(brand.id, final));
  const recorded = options.review === false ? [] : recordAgentWrite(deck, doc, result.doc);
  return {
    ok: true,
    brand: { id: brand.id, name: brand.name },
    replaced: doc.brand === undefined ? null : { id: doc.brand.id, name: doc.brand.name },
    upToDate: written.length === 0 && toCopy.length === 0 && stale.length === 0,
    prevRev: result.prevRev,
    rev: result.rev,
    written,
    copied: toCopy.map(brandFilePath),
    unchanged: unchanged.map(brandFilePath),
    removed: stale.map(brandFilePath),
    kept: kept.map(brandFilePath),
    overwrote,
    diagnostics: [...result.diagnostics, ...recorded],
  };
}
