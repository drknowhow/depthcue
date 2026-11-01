import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Doc, docToFiles, loadDoc, MANIFEST_FILE, revisionOf } from "@depthcue/core";
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

/**
 * Writes the difference between `before` and `after` into the deck folder. Only files whose normalised text
 * changed are touched, so a hand-formatted scene that was not edited keeps its formatting. The order never leaves
 * a dangling reference if the process dies halfway: new and changed scenes first, then deck.json, then removals.
 * Just before writing it re-reads the folder and refuses if it no longer matches `before`.
 */
export function saveDeckDir(dir: string, before: Doc, after: Doc): string[] {
  const onDisk = loadDoc(loadDeckDir(dir)).doc;
  if (!onDisk || revisionOf(onDisk) !== revisionOf(before)) {
    throw new ChangedOnDiskError(
      "The deck changed on disk while the edit was being applied. Read it again and retry.",
    );
  }

  const was = docToFiles(before);
  const now = docToFiles(after);
  const written: string[] = [];
  const write = (path: string) => {
    writeAtomic(dir, path, now[path] as string);
    written.push(path);
  };

  for (const path of Object.keys(now)) {
    if (path !== MANIFEST_FILE && now[path] !== was[path]) write(path);
  }
  if (now[MANIFEST_FILE] !== was[MANIFEST_FILE]) write(MANIFEST_FILE);
  for (const path of Object.keys(was)) {
    if (!(path in now)) {
      rmSync(join(dir, path), { force: true });
      written.push(path);
    }
  }
  return written;
}
