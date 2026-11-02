/**
 * The `brand` and `new` commands, past argument parsing: which subcommand, what it takes, and what it refuses. Loaded
 * only when one of them runs, so printing usage or running `check` loads none of the brand code.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Io } from "../index.ts";
import { brandCheckCommand } from "./check.ts";
import {
  addBrandFile,
  type BrandFileAdded,
  type BrandFileRefusal,
  type BrandFileRemoved,
  brandFileBody,
  brandFileExit,
  brandFileLimit,
  isBrandFileKind,
  removeBrandFile,
  tooLarge,
} from "./files.ts";
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
  /** brand add's kind of file, its --replace, and the revision brand add and brand remove check against. */
  kind?: string | undefined;
  replace?: boolean;
  baseRev?: string | undefined;
  /** Any of --port, --step, --width or --height, which no brand command takes. */
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
    ["kind", flags.kind !== undefined],
    ["out", flags.out !== undefined],
    ["name", flags.name !== undefined],
    ["brand", flags.brand !== undefined],
    ["force", flags.force],
    ["replace", flags.replace === true],
    ["json", flags.json],
  ] as const;
  const takes = `${sub} takes ${allowed.map((name) => `--${name}`).join(" and ")}`;
  for (const [flag, present] of given) {
    if (present && !allowed.includes(flag)) return usage(`${takes}, not --${flag}.`);
  }
  const strayRev = flags.baseRev !== undefined && !allowed.includes("base-rev");
  return flags.stray || strayRev ? usage(`${takes}.`) : undefined;
}

/** Prints what brand add or brand remove did, or why not. */
function printBrandFile(
  outcome: BrandFileAdded | BrandFileRemoved | BrandFileRefusal,
  json: boolean,
  io: Io,
): number {
  if (json) io.out(JSON.stringify(brandFileBody(outcome), null, 2));
  if (!outcome.ok) {
    if (!json) {
      io.err(outcome.message);
      for (const at of outcome.usedBy ?? []) io.err(`  named by ${at.file} at ${at.path}`);
      for (const diagnostic of outcome.diagnostics ?? [])
        io.err(`  ${diagnostic.file}: ${diagnostic.message}`);
      if (outcome.rev !== undefined) io.err(`The deck's revision is ${outcome.rev}.`);
    }
    return brandFileExit(outcome.error);
  }
  if (json) return 0;
  const path = `brand/${outcome.path}`;
  if ("removed" in outcome) {
    io.out(`Removed ${path}. Revision ${outcome.prevRev} -> ${outcome.rev}.`);
  } else if (!outcome.written) {
    io.out(`${path} is in the brand with these bytes already. Nothing was written; revision ${outcome.rev}.`);
  } else {
    const found = outcome.sniffed;
    const what =
      "family" in found
        ? `${found.format}, ${found.family} ${found.style}, weight ${found.weight}`
        : found.format;
    io.out(
      `${outcome.replaced ? "Replaced" : "Added"} ${path} (${what}). Revision ${outcome.prevRev ?? "none"} -> ${outcome.rev}.`,
    );
  }
  for (const diagnostic of outcome.diagnostics) io.err(`warning: ${diagnostic.message}`);
  return 0;
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
  if (sub === "add") {
    if (!first || !second) return usage("brand add needs a file and a deck folder.");
    if (more.length > 0) return usage(`Unexpected argument ${more[0]}.`);
    const refused = refuse("brand add", flags, ["kind", "name", "replace", "base-rev", "json"], usage);
    if (refused !== undefined) return refused;
    if (!isBrandFileKind(flags.kind))
      return usage("brand add needs --kind font, --kind logo or --kind image.");
    if (flags.replace === true && flags.baseRev === undefined) {
      return usage("brand add --replace needs --base-rev, the deck's revision.");
    }
    const unreadable = (message: string): number => {
      if (flags.json) io.out(JSON.stringify({ ok: false, error: "unreadable", message }, null, 2));
      else io.err(message);
      return 2;
    };
    const file = statSync(first, { throwIfNoEntry: false });
    if (!file?.isFile()) return unreadable(`${first} is not a file.`);
    if (!statSync(second, { throwIfNoEntry: false })?.isDirectory())
      return unreadable(`${second} is not a folder.`);
    // The size is known before the file is read, so a file far past the limit is never read.
    if (file.size > brandFileLimit(flags.kind)) return printBrandFile(tooLarge(flags.kind), flags.json, io);
    const outcome = addBrandFile(
      second,
      {
        kind: flags.kind,
        name: flags.name ?? basename(first),
        bytes: new Uint8Array(readFileSync(first)),
        replace: flags.replace === true,
        ...(flags.baseRev === undefined ? {} : { baseRev: flags.baseRev }),
      },
      "agent",
    );
    return printBrandFile(outcome, flags.json, io);
  }
  if (sub === "remove") {
    if (!first || !second) return usage("brand remove needs the file's path in brand/ and a deck folder.");
    if (more.length > 0) return usage(`Unexpected argument ${more[0]}.`);
    const refused = refuse("brand remove", flags, ["base-rev", "json"], usage);
    if (refused !== undefined) return refused;
    if (flags.baseRev === undefined) return usage("brand remove needs --base-rev, the deck's revision.");
    if (!statSync(second, { throwIfNoEntry: false })?.isDirectory()) {
      const message = `${second} is not a folder.`;
      if (flags.json) io.out(JSON.stringify({ ok: false, error: "unreadable", message }, null, 2));
      else io.err(message);
      return 2;
    }
    return printBrandFile(
      removeBrandFile(second, { path: first, baseRev: flags.baseRev }, "agent"),
      flags.json,
      io,
    );
  }
  // The usage printed under this names brand add and brand remove too; brand-commands.test.ts pins this sentence.
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
