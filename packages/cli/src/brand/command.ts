/**
 * The `brand` and `new` commands, past argument parsing: which subcommand, what it takes, and what it refuses. Loaded
 * only when one of them runs, so printing usage or running `check` loads none of the brand code.
 */
import { statSync } from "node:fs";
import type { Io } from "../index.ts";
import { brandCheckCommand } from "./check.ts";
import { brandInitCommand } from "./init.ts";
import { newCommand } from "./newdeck.ts";
import { printUse } from "./print.ts";
import { BrandFolderError, readBrandFolder } from "./source.ts";
import { useBrand } from "./use.ts";

/** The flags the CLI parsed, for the command to say which ones it takes. */
export interface BrandFlags {
  out: string | undefined;
  name: string | undefined;
  brand: string | undefined;
  force: boolean;
  json: boolean;
  /** Any of --base-rev, --port, --step, --width or --height, which no brand command takes. */
  stray: boolean;
}

type Usage = (message: string) => number;

function refuse(
  sub: string,
  flags: BrandFlags,
  allowed: readonly string[],
  usage: Usage,
): number | undefined {
  const given = [
    ["out", flags.out !== undefined],
    ["name", flags.name !== undefined],
    ["brand", flags.brand !== undefined],
    ["force", flags.force],
    ["json", flags.json],
  ] as const;
  const takes = `${sub} takes ${allowed.map((name) => `--${name}`).join(" and ")}`;
  for (const [flag, present] of given) {
    if (present && !allowed.includes(flag)) return usage(`${takes}, not --${flag}.`);
  }
  return flags.stray ? usage(`${takes}.`) : undefined;
}

/** `depthcue brand init|use|check|import`. */
export async function brandCommand(
  positional: readonly string[],
  flags: BrandFlags,
  io: Io,
  usage: Usage,
): Promise<number> {
  const [sub, first, second, ...more] = positional;
  if (sub === "import") {
    if (!first) return usage("brand import needs a PowerPoint file: a .potx, .pptx or .thmx.");
    if (second !== undefined) return usage(`Unexpected argument ${second}.`);
    const refused = refuse("brand import", flags, ["out", "json"], usage);
    if (refused !== undefined) return refused;
    const { brandImportCommand } = await import("../brand-import/command.ts");
    return brandImportCommand(first, flags.out, flags.json, io);
  }
  if (sub === "init") {
    if (!first) return usage("brand init needs a folder to make the brand in.");
    if (second !== undefined) return usage(`Unexpected argument ${second}.`);
    const refused = refuse("brand init", flags, ["name", "json"], usage);
    if (refused !== undefined) return refused;
    return brandInitCommand(first, flags.name, flags.json, io);
  }
  if (sub === "check") {
    if (!first) return usage("brand check needs a brand folder or a deck folder.");
    if (second !== undefined) return usage(`Unexpected argument ${second}.`);
    const refused = refuse("brand check", flags, ["json"], usage);
    if (refused !== undefined) return refused;
    return brandCheckCommand(first, flags.json, io);
  }
  if (sub === "use") {
    if (!first || !second) return usage("brand use needs a brand folder and a deck folder.");
    if (more.length > 0) return usage(`Unexpected argument ${more[0]}.`);
    const refused = refuse("brand use", flags, ["force", "json"], usage);
    if (refused !== undefined) return refused;
    const unreadable = (message: string): number => {
      if (flags.json) io.out(JSON.stringify({ ok: false, message }, null, 2));
      else io.err(message);
      return 2;
    };
    if (!statSync(second, { throwIfNoEntry: false })?.isDirectory())
      return unreadable(`${second} is not a folder.`);
    try {
      return printUse(
        useBrand(second, readBrandFolder(first), { force: flags.force }),
        second,
        flags.json,
        io,
      );
    } catch (error) {
      if (error instanceof BrandFolderError) return unreadable(error.message);
      throw error;
    }
  }
  return usage("brand needs a subcommand: brand init, brand use, brand check or brand import.");
}

/** `depthcue new <dir> [--brand <brand-folder>] [--name <title>]`. */
export async function newDeckCommand(
  positional: readonly string[],
  flags: BrandFlags,
  io: Io,
  usage: Usage,
): Promise<number> {
  const [dir, extra] = positional;
  if (!dir) return usage("new needs a folder to make the deck in.");
  if (extra !== undefined) return usage(`Unexpected argument ${extra}.`);
  const refused = refuse("new", flags, ["brand", "name", "json"], usage);
  if (refused !== undefined) return refused;
  return newCommand(dir, flags.brand, flags.name, flags.json, io);
}
