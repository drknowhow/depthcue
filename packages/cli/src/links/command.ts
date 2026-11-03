/**
 * The `link` command: the deck's link library from the command line. `list` and `check` read; `add`, `set` and
 * `remove` apply a `link.*` operation against the revision they just read, so the checks of the operations (a
 * well-formed target, no removing a link in use) are the ones the editor and an agent get. Loaded only when it runs.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkLinkAssets,
  checkLinks,
  type Deck,
  type Diagnostic,
  type Doc,
  linkUses,
  parseTarget,
  revisionOf,
} from "@depthcue/core";
import { applyToFolder, openDeck } from "../deck-api.ts";
import { count, type Io, report, summary } from "../report.ts";

type Usage = (message: string) => number;

/** The flags the CLI parsed that the link command reads. */
export interface LinkFlags {
  json: boolean;
  /** The link's title: `--name`. */
  name: string | undefined;
  target: string | undefined;
  note: string | undefined;
  /** For remove: the link whose uses take the removed link's place. */
  to: string | undefined;
  online: boolean;
  /** Any option that no link subcommand takes. */
  stray: boolean;
}

type Entry = NonNullable<Deck["links"]>[number];

const uses = (doc: Doc, id: string) =>
  doc.deck.scenes.flatMap((sceneId) =>
    linkUses(doc.scenes[sceneId] as Doc["scenes"][string])
      .filter((use) => use.id === id)
      .map((use) => ({ scene: sceneId, path: use.path })),
  );

const kindOf = (entry: Entry) => parseTarget(entry.target)?.kind ?? "invalid";

function list(doc: Doc, json: boolean, io: Io): number {
  const links = (doc.deck.links ?? []).map((entry) => ({
    ...entry,
    kind: kindOf(entry),
    uses: uses(doc, entry.id),
  }));
  if (json) {
    io.out(JSON.stringify({ ok: true, links }, null, 2));
    return 0;
  }
  if (links.length === 0) {
    io.out("This deck has no saved links. Add one with: depthcue link add <deck-folder> <id> <target>");
    return 0;
  }
  for (const link of links) {
    io.out(`${link.id}  ${link.kind}  ${link.target}`);
    io.out(
      `  ${link.title}${link.note ? ` (${link.note})` : ""}; used ${link.uses.length} time${link.uses.length === 1 ? "" : "s"}`,
    );
  }
  return 0;
}

async function reachable(href: string): Promise<string | undefined> {
  try {
    let response = await fetch(href, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    // Some servers refuse HEAD and answer a plain request.
    if (response.status === 405 || response.status === 501) {
      response = await fetch(href, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(8000) });
    }
    return response.ok ? undefined : `answered ${response.status}`;
  } catch (error) {
    return (error as Error).name === "TimeoutError" ? "did not answer in 8 seconds" : "could not be reached";
  }
}

/** The library's own checks, a warning for a link nothing uses and for a path that is not there, and with `online`, for an address that does not answer. */
async function check(folder: string, doc: Doc, flags: LinkFlags, io: Io): Promise<number> {
  const file = "deck.json";
  const found: Diagnostic[] = [...checkLinks(doc.deck, file), ...checkLinkAssets(doc.deck, doc.assets, file)];
  const links = doc.deck.links ?? [];
  const warn = (i: number, code: string, message: string, fix: string): Diagnostic => ({
    severity: "warning",
    code,
    file,
    path: `/links/${i}/target`,
    message,
    fix,
  });
  const pending: Array<Promise<void>> = [];
  links.forEach((entry, i) => {
    if (uses(doc, entry.id).length === 0) {
      found.push(
        warn(
          i,
          "link-unused",
          `"${entry.id}" is used by no block or source.`,
          "Use it, or remove it with link remove.",
        ),
      );
    }
    const target = parseTarget(entry.target);
    if (target?.kind === "path" && !existsSync(resolve(folder, target.path))) {
      found.push(
        warn(
          i,
          "link-path-missing",
          `"${entry.id}" names ${target.path}, which is not there.`,
          "Fix the path or remove the link.",
        ),
      );
    }
    if (flags.online && target?.kind === "address" && /^https?:/.test(target.href)) {
      pending.push(
        reachable(target.href).then((why) => {
          if (why)
            found.push(
              warn(
                i,
                "link-unreachable",
                `"${entry.id}" ${why}.`,
                "Check the address; the site may be down or may have moved.",
              ),
            );
        }),
      );
    }
  });
  await Promise.all(pending);
  found.sort((a, b) => a.path.localeCompare(b.path));
  report(io, found, flags.json);
  if (!flags.json) io.out(`${links.length} link${links.length === 1 ? "" : "s"} checked. ${summary(found)}`);
  return count(found, "error") === 0 ? 0 : 1;
}

/** Applies one operation to the folder against the revision just read, and says what it did. */
function change(folder: string, doc: Doc, op: object, done: string, flags: LinkFlags, io: Io): number {
  const outcome = applyToFolder(folder, [op], revisionOf(doc));
  if (!outcome.ok) {
    report(io, outcome.diagnostics, flags.json, { applied: false, code: outcome.code });
    if (!flags.json)
      io.out(`Rejected (${outcome.code}); nothing was written. ${summary(outcome.diagnostics)}`);
    return outcome.code === "changed-on-disk" || outcome.code === "stale-revision" ? 3 : 1;
  }
  if (flags.json) {
    io.out(JSON.stringify({ ok: true, applied: true, prevRev: outcome.prevRev, rev: outcome.rev }, null, 2));
  } else {
    io.out(`${done} Revision ${outcome.prevRev} -> ${outcome.rev}.`);
    for (const diagnostic of outcome.diagnostics) io.err(`warning: ${diagnostic.message}`);
  }
  return 0;
}

/** `depthcue link list|add|set|remove|check`. */
export async function linkCommand(
  positional: readonly string[],
  flags: LinkFlags,
  io: Io,
  usage: Usage,
): Promise<number> {
  const [sub, folder, id, targetArg, ...more] = positional;
  if (sub !== "list" && sub !== "add" && sub !== "set" && sub !== "remove" && sub !== "check") {
    return usage("link needs a subcommand: list, add, set, remove or check.");
  }
  if (!folder) return usage(`link ${sub} needs a deck folder.`);
  const takes = (allowed: readonly string[]) => {
    const given = [
      ["name", flags.name],
      ["target", flags.target],
      ["note", flags.note],
      ["to", flags.to],
    ] as const;
    const wrong = given.find(([flag, value]) => value !== undefined && !allowed.includes(flag));
    if (wrong) return usage(`link ${sub} does not take --${wrong[0]}.`);
    if (flags.online && sub !== "check") return usage("--online belongs to link check.");
    return flags.stray ? usage(`link ${sub} does not take that option.`) : undefined;
  };
  const opened = openDeck(folder);
  if (!opened.ok) {
    report(io, opened.diagnostics, flags.json);
    if (!flags.json) io.out(summary(opened.diagnostics));
    return 1;
  }
  const { doc } = opened;
  if (sub === "list" || sub === "check") {
    if (id !== undefined) return usage(`Unexpected argument ${id}.`);
    const refused = takes([]);
    if (refused !== undefined) return refused;
    return sub === "list" ? list(doc, flags.json, io) : check(folder, doc, flags, io);
  }
  if (!id) return usage(`link ${sub} needs a link id.`);
  if (sub === "add") {
    if (!targetArg) return usage("link add needs a deck folder, an id and a target.");
    if (more.length > 0) return usage(`Unexpected argument ${more[0]}.`);
    const refused = takes(["name", "note"]);
    if (refused !== undefined) return refused;
    const link = {
      id,
      title: flags.name ?? id,
      target: targetArg,
      ...(flags.note === undefined ? {} : { note: flags.note }),
    };
    return change(folder, doc, { op: "link.add", link }, `Added link "${id}".`, flags, io);
  }
  if (targetArg !== undefined) return usage(`Unexpected argument ${targetArg}.`);
  if (sub === "set") {
    const refused = takes(["name", "target", "note"]);
    if (refused !== undefined) return refused;
    const set: Record<string, string> = {};
    if (flags.name !== undefined) set.title = flags.name;
    if (flags.target !== undefined) set.target = flags.target;
    if (flags.note !== undefined) set.note = flags.note;
    if (Object.keys(set).length === 0) return usage("link set needs --name, --target or --note.");
    return change(folder, doc, { op: "link.set", id, set }, `Changed link "${id}".`, flags, io);
  }
  const refused = takes(["to"]);
  if (refused !== undefined) return refused;
  const op = flags.to === undefined ? { op: "link.remove", id } : { op: "link.remove", id, to: flags.to };
  return change(folder, doc, op, `Removed link "${id}".`, flags, io);
}
