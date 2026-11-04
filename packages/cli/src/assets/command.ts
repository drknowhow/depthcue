/**
 * The `asset` command: the images in a deck's assets folder from the command line. `add` copies files in through the
 * same type check, size limit and naming as the editor's upload and the agent's deck_asset tool; `list` and `unused`
 * read; `remove` deletes a file nothing names. Loaded only when it runs.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDeck } from "../deck-api.ts";
import {
  addImage,
  ImageRefused,
  type ListedImage,
  listImages,
  readImageFile,
  removeImage,
} from "../images.ts";
import { type Io, report, summary } from "../report.ts";

type Usage = (message: string) => number;

export interface AssetFlags {
  json: boolean;
  /** Any option that no asset subcommand takes. */
  stray: boolean;
}

const kb = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const sizeOf = (image: { width?: number; height?: number }) =>
  image.width && image.height ? `${image.width}x${image.height}` : "size unknown";
const where = (image: ListedImage) =>
  image.usedBy.length === 0
    ? "unused"
    : `used ${image.usedBy.length} time${image.usedBy.length === 1 ? "" : "s"}: ${[
        ...new Set(image.usedBy.map((use) => use.scene ?? "deck links")),
      ].join(", ")}`;

function add(folder: string, files: readonly string[], flags: AssetFlags, io: Io): number {
  const added: Array<ReturnType<typeof addImage>> = [];
  const refused: Array<{ file: string; code: string; message: string }> = [];
  for (const file of files) {
    try {
      const { bytes, name } = readImageFile(file);
      added.push(addImage(folder, bytes, name));
    } catch (error) {
      if (!(error instanceof ImageRefused)) throw error;
      refused.push({ file, code: error.code, message: error.message });
    }
  }
  if (flags.json) {
    io.out(JSON.stringify({ ok: refused.length === 0, added, refused }, null, 2));
  } else {
    for (const image of added) io.out(`${image.asset}  ${sizeOf(image)}  ${kb(image.bytes)}`);
    for (const item of refused) io.err(`${item.file}: ${item.message}`);
  }
  return refused.length === 0 ? 0 : 1;
}

/** `depthcue asset add|list|unused|remove`. */
export async function assetCommand(
  positional: readonly string[],
  flags: AssetFlags,
  io: Io,
  usage: Usage,
): Promise<number> {
  const [sub, folder, ...rest] = positional;
  if (sub !== "add" && sub !== "list" && sub !== "unused" && sub !== "remove") {
    return usage("asset needs a subcommand: add, list, unused or remove.");
  }
  if (!folder) return usage(`asset ${sub} needs a deck folder.`);
  if (flags.stray) return usage(`asset ${sub} does not take that option.`);
  if (sub === "add") {
    if (rest.length === 0) return usage("asset add needs a deck folder and at least one file.");
    if (!existsSync(join(folder, "deck.json"))) {
      io.err(`${folder} is not a deck folder: it has no deck.json.`);
      return 1;
    }
    return add(folder, rest, flags, io);
  }
  if (sub === "remove") {
    if (rest.length === 0)
      return usage("asset remove needs a deck folder and an asset, such as assets/photo-1a2b3c4d.png.");
    if (rest.length > 1) return usage(`Unexpected argument ${rest[1]}.`);
  } else if (rest.length > 0) {
    return usage(`Unexpected argument ${rest[0]}.`);
  }
  const opened = openDeck(folder);
  if (!opened.ok) {
    report(io, opened.diagnostics, flags.json);
    if (!flags.json) io.out(summary(opened.diagnostics));
    return 1;
  }
  const { doc } = opened;
  if (sub === "remove") {
    const outcome = removeImage(folder, doc, rest[0] as string);
    if (flags.json) io.out(JSON.stringify(outcome, null, 2));
    else if (outcome.ok) io.out(`Removed ${outcome.asset}.`);
    else io.err(outcome.message);
    return outcome.ok ? 0 : 1;
  }
  const images = listImages(folder, doc);
  const shown = sub === "unused" ? images.filter((image) => image.usedBy.length === 0) : images;
  if (flags.json) {
    io.out(JSON.stringify({ ok: true, assets: shown }, null, 2));
    return 0;
  }
  if (shown.length === 0) {
    io.out(sub === "unused" ? "Every image in this deck is used." : "This deck has no images.");
    return 0;
  }
  for (const image of shown) {
    io.out(
      `${image.asset}  ${sizeOf(image)}  ${kb(image.bytes)}${sub === "list" ? `  ${where(image)}` : ""}`,
    );
  }
  return 0;
}
