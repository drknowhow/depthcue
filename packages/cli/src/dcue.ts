/**
 * The file a person double-clicks to open a deck: `<folder>.dcue`, beside deck.json in the deck folder. The deck stays
 * the folder of plain files that agents, git and every command read; the .dcue file only marks the folder, and is what
 * Windows opens with `depthcue open` once `depthcue register` has run.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Io } from "./report.ts";

export const DCUE_EXTENSION = ".dcue";
export const DCUE_FORMAT = "depthcue-file/1";

/** What a .dcue file holds. The note is for a person who opens it in a text editor. */
export const dcueText = (): string =>
  `${JSON.stringify(
    {
      format: DCUE_FORMAT,
      note: "Double-click this file to open the deck in the Depthcue editor. The deck is the folder this file is in.",
    },
    null,
    2,
  )}\n`;

/** The name of the .dcue file a deck folder gets: the folder's own name. */
export const dcueName = (folder: string): string => `${basename(resolve(folder))}${DCUE_EXTENSION}`;

const isDcue = (name: string): boolean => extname(name).toLowerCase() === DCUE_EXTENSION;

/** The .dcue files at the top of a folder, by name. */
export function dcueFiles(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isDcue(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export type DeckFolder = { ok: true; folder: string } | { ok: false; message: string };

/** The deck folder a path names: a .dcue file (the folder it is in), deck.json (the same), or the folder itself. */
export function deckFolderOf(path: string): DeckFolder {
  const full = resolve(path);
  const found = statSync(full, { throwIfNoEntry: false });
  if (found === undefined) return { ok: false, message: `${path} is not there.` };
  let folder = full;
  if (found.isFile()) {
    if (isDcue(full)) {
      let format: unknown;
      try {
        format = (JSON.parse(readFileSync(full, "utf8")) as { format?: unknown } | null)?.format;
      } catch {
        format = undefined;
      }
      if (format !== DCUE_FORMAT) {
        return {
          ok: false,
          message: `${path} is not a Depthcue file. Make one with: depthcue file <deck-folder>`,
        };
      }
    } else if (basename(full).toLowerCase() !== "deck.json") {
      return {
        ok: false,
        message: `${path} is not a deck. Name a .dcue file, a deck folder or its deck.json.`,
      };
    }
    folder = dirname(full);
  }
  if (!existsSync(join(folder, "deck.json"))) {
    return {
      ok: false,
      message: isDcue(full)
        ? `${path} is not beside a deck: ${folder} has no deck.json. A .dcue file opens the deck folder it is in, so keep it there.`
        : `${folder} is not a deck folder: it has no deck.json.`,
    };
  }
  return { ok: true, folder };
}

/** `depthcue file`: gives a deck folder its .dcue file, unless it has one. */
export function fileCommand(path: string, json: boolean, io: Io): number {
  const deck = deckFolderOf(path);
  if (!deck.ok) {
    if (json) io.out(JSON.stringify({ ok: false, message: deck.message }, null, 2));
    else io.err(deck.message);
    return 2;
  }
  const there = dcueFiles(deck.folder);
  const name = there[0] ?? dcueName(deck.folder);
  if (there.length === 0) {
    try {
      writeFileSync(join(deck.folder, name), dcueText());
    } catch (error) {
      io.err(`Could not write ${join(deck.folder, name)}: ${(error as Error).message}`);
      return 2;
    }
  }
  const file = join(deck.folder, name);
  if (json) io.out(JSON.stringify({ ok: true, file, written: there.length === 0 }, null, 2));
  else io.out(there.length === 0 ? `Wrote ${file}.` : `${file} is there already; nothing was written.`);
  return 0;
}
