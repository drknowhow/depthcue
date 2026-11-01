import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BRAND_DIR,
  BRAND_FILE,
  type Brand,
  type Doc,
  docToFiles,
  loadDoc,
  MANIFEST_FILE,
  revisionOf,
} from "@depthcue/core";
import { loadDeckDir } from "./loader.ts";

/** The deck on disk changed after it was read, so writing now would overwrite someone else's edit. */
export class ChangedOnDiskError extends Error {}

export function writeAtomic(dir: string, path: string, text: string): void {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.depthcue-${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, target);
}

/** How a save touches the folder, one file at a time. Tests pass their own to stop a save halfway. */
export interface SaveIo {
  write(dir: string, path: string, text: string): void;
  remove(dir: string, path: string): void;
}

const DISK: SaveIo = {
  write: writeAtomic,
  remove: (dir, path) => rmSync(join(dir, path), { force: true }),
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * brand.json as it is written before the scenes, when that differs from how it ends: the new brand.json still holding
 * every style it loses, hiding no built-in set and locking nothing that the old one did not. A scene that stops using
 * a style in the same save is written after this, and still finds it.
 */
function keeping(before: Brand | undefined, after: Brand | undefined): string | undefined {
  if (before === undefined) return undefined;
  const brand: Record<string, unknown> = { ...(after ?? before) };
  const styles = { ...before.styles, ...after?.styles };
  if (Object.keys(styles).length > 0) brand.styles = styles;
  const hidden = after?.hideBuiltIn?.filter((set) => before.hideBuiltIn?.includes(set)) ?? [];
  if (hidden.length > 0) brand.hideBuiltIn = hidden;
  else delete brand.hideBuiltIn;
  if (!(before.lock && after?.lock)) delete brand.lock;
  return json(brand);
}

/** One file to write, with its text, or to remove. */
interface Step {
  path: string;
  text?: string;
}

/**
 * The writes and removals that turn `before`'s files into `after`'s, in an order that leaves a deck that loads at
 * every stop between them, for what one batch of operations does to references: a scene that starts to use a template
 * or style finds it already written, and one a scene stops using goes only after the scene. So: the brand's new and
 * changed files, brand.json in its `keeping` form; the scenes; deck.json; brand.json as it ends; the removals. A brand
 * made or taken off is a folder deck.json does not name for the stops in between, which a load leaves unread. Not
 * covered: a template or style whose content changes under a scene that uses it, colors checked across the two files,
 * and a brand made in the same save as a scene that uses it.
 */
export function savePlan(before: Doc, after: Doc): Step[] {
  const was = docToFiles(before);
  const now = docToFiles(after);
  const changed = (path: string) => now[path] !== was[path];
  const inBrand = (path: string) => path.startsWith(`${BRAND_DIR}/`);
  // brand.json that loses something is written first as `keeping` has it, unless that is the file already on disk,
  // and as it ends only after deck.json.
  const middle =
    Object.hasOwn(was, BRAND_FILE) && changed(BRAND_FILE) ? keeping(before.brand, after.brand) : undefined;
  const late = middle !== undefined && middle !== now[BRAND_FILE];
  const steps: Step[] = [];
  const write = (path: string) => steps.push({ path, text: now[path] as string });
  if (late && middle !== was[BRAND_FILE]) steps.push({ path: BRAND_FILE, text: middle });
  for (const path of Object.keys(now))
    if (inBrand(path) && changed(path) && !(late && path === BRAND_FILE)) write(path);
  for (const path of Object.keys(now))
    if (!inBrand(path) && path !== MANIFEST_FILE && changed(path)) write(path);
  if (changed(MANIFEST_FILE)) write(MANIFEST_FILE);
  if (late && Object.hasOwn(now, BRAND_FILE)) write(BRAND_FILE);
  for (const path of Object.keys(was)) if (!Object.hasOwn(now, path)) steps.push({ path });
  return steps;
}

/**
 * Writes the difference between `before` and `after` into the deck folder. Only files whose normalised text
 * changed are touched, so a hand-formatted scene that was not edited keeps its formatting. `savePlan` gives the order,
 * which leaves a deck that loads if the process dies halfway. Just before writing it re-reads the folder and refuses
 * if it no longer matches `before`. Returns each path written or removed, once.
 */
export function saveDeckDir(dir: string, before: Doc, after: Doc, io: SaveIo = DISK): string[] {
  const onDisk = loadDoc(loadDeckDir(dir)).doc;
  if (!onDisk || revisionOf(onDisk) !== revisionOf(before)) {
    throw new ChangedOnDiskError(
      "The deck changed on disk while the edit was being applied. Read it again and retry.",
    );
  }
  const written: string[] = [];
  for (const { path, text } of savePlan(before, after)) {
    if (text === undefined) io.remove(dir, path);
    else io.write(dir, path, text);
    if (!written.includes(path)) written.push(path);
  }
  return written;
}
