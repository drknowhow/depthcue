/**
 * `depthcue new`: a deck in an empty folder, with one opening scene on the title template. With `--brand` the brand
 * is copied in by the code `brand use` runs, in the same transaction that moves the scene onto the brand's title
 * template, so a brand that cannot take the scene leaves no deck behind.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  type Block,
  type BrandPart,
  type Op,
  retemplate,
  type Scene,
  type Template,
  templatesOf,
} from "@depthcue/core";
import { dcueName, dcueText } from "../dcue.ts";
import type { Io } from "../index.ts";
import { checkBrandSource } from "./check.ts";
import { idFromName, nameFromFolder } from "./init.ts";
import { printUse } from "./print.ts";
import { BrandFolderError, type BrandSource, readBrandFolder } from "./source.ts";
import { useBrand } from "./use.ts";

const SCENE_ID = "opening";
const TEXT_KINDS = ["body", "caption", "quote", "heading"] as const;

const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The opening scene on the layout `title`, with a heading, and a block for each required slot of the template the
 * heading does not fill, so the scene passes the template's own checks. A string says why a required slot cannot be filled.
 */
function openingScene(title: string, part: BrandPart): { scene: Scene; ops: Op[] } | string {
  const template = templatesOf(part).title as Template | undefined;
  if (template === undefined) {
    return "The brand has no title template and hides Depthcue's own, so the first scene has no template to take. Add templates/title.json to the brand.";
  }
  const blocks: Block[] = [{ id: `${SCENE_ID}-title`, type: "text", role: "heading", text: title }];
  const make = (): Scene => ({ schemaVersion: "0.4", id: SCENE_ID, title, layout: "title", blocks }) as Scene;
  const filled = new Set(
    retemplate({ ...part, scenes: { [SCENE_ID]: make() } }, SCENE_ID, { template: "title" }).ops.flatMap(
      (op) => (op.op === "block.set" && typeof op.set.slot === "string" ? [op.set.slot] : []),
    ),
  );
  for (const slot of template.slots) {
    if (!slot.required || filled.has(slot.id)) continue;
    const kind = TEXT_KINDS.find((candidate) =>
      (slot.accepts as readonly string[] | undefined)?.includes(candidate),
    );
    if (kind === undefined) {
      return `The brand's title template needs something in "${slot.id}" that a new deck cannot start with. Make the slot optional, or let it take text.`;
    }
    blocks.push({
      id: `${SCENE_ID}-${slot.id}`,
      type: "text",
      role: kind,
      text: slot.hint.slice(0, 80),
    } as Block);
  }
  const scene = make();
  return {
    scene,
    ops: retemplate({ ...part, scenes: { [SCENE_ID]: scene } }, SCENE_ID, { template: "title" }).ops,
  };
}

const opener = (dir: string, file: string): string =>
  `Open it by double-clicking ${file} (once depthcue register has run), or with: depthcue open ${dir}`;

/** The scene after the operations that move it, for a deck with no brand to apply them to. */
function moved(scene: Scene, ops: readonly Op[]): Scene {
  let template: unknown;
  const slots = new Map<string, string>();
  for (const op of ops) {
    if (op.op === "scene.set") template = op.set.template;
    else if (op.op === "block.set" && typeof op.set.slot === "string") slots.set(op.id, op.set.slot);
  }
  const { layout: _layout, blocks, ...head } = scene;
  return {
    ...head,
    template,
    blocks: blocks.map((block) => (slots.has(block.id) ? { ...block, slot: slots.get(block.id) } : block)),
  } as unknown as Scene;
}

/** Makes the deck. Exit codes as `brand use`: 0 done, 1 refused, 2 a folder could not be read or written. */
export function newCommand(
  dir: string,
  brandDir: string | undefined,
  title: string | undefined,
  json: boolean,
  io: Io,
): number {
  const fail = (message: string, code = 2): number => {
    if (json) io.out(JSON.stringify({ ok: false, message }, null, 2));
    else io.err(message);
    return code;
  };
  const chosen = (title ?? nameFromFolder(dir)).trim();
  if (chosen.length === 0 || chosen.length > 120) return fail("--name needs 1 to 120 characters.");
  const found = statSync(dir, { throwIfNoEntry: false });
  if (found !== undefined && !found.isDirectory()) return fail(`${dir} is a file. Pick a folder.`);
  if (found !== undefined && readdirSync(dir).length > 0) {
    return fail(`${dir} has files in it, so nothing was written. Pick an empty or new folder.`);
  }

  let source: BrandSource | undefined;
  let part: BrandPart = {};
  if (brandDir !== undefined) {
    try {
      source = readBrandFolder(brandDir);
    } catch (error) {
      if (error instanceof BrandFolderError) return fail(error.message);
      throw error;
    }
    const checked = checkBrandSource(source);
    if (
      checked.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
      checked.part === undefined
    ) {
      return printUse(
        {
          ok: false,
          code: "brand-invalid",
          message: `${brandDir} fails brand check, so no deck was made. Fix the errors it names (depthcue brand check ${brandDir}) and run this again.`,
          diagnostics: checked.diagnostics,
        },
        dir,
        json,
        io,
      );
    }
    part = checked.part;
  }

  const opening = openingScene(chosen, part);
  if (typeof opening === "string") return fail(opening, 1);
  const deckId = idFromName(basename(resolve(dir)));
  const deck = {
    schemaVersion: "0.4",
    id: deckId,
    title: chosen,
    language: "en",
    theme: "paper",
    scenes: [SCENE_ID],
  };
  const scenePath = join(dir, "scenes", `${SCENE_ID}.json`);
  const file = dcueName(dir);
  const wipe = (): void => {
    if (found === undefined) rmSync(dir, { recursive: true, force: true });
    else for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
  };
  try {
    mkdirSync(join(dir, "scenes"), { recursive: true });
    writeFileSync(join(dir, "deck.json"), text(deck));
    writeFileSync(join(dir, file), dcueText());
    // With a brand the scene starts on the layout and the brand's operations move it, in the transaction that copies it.
    writeFileSync(scenePath, text(source === undefined ? moved(opening.scene, opening.ops) : opening.scene));
  } catch (error) {
    wipe();
    return fail(`Could not write ${dir}: ${(error as Error).message}`);
  }
  if (source === undefined) {
    if (json)
      io.out(
        JSON.stringify(
          { ok: true, dir, files: ["deck.json", `scenes/${SCENE_ID}.json`, file], file, brand: null },
          null,
          2,
        ),
      );
    else {
      io.out(
        `Made the deck "${chosen}" in ${dir}: deck.json, scenes/${SCENE_ID}.json and ${file}, on Depthcue's title template.`,
      );
      io.out(opener(dir, file));
    }
    return 0;
  }
  let result: ReturnType<typeof useBrand>;
  try {
    result = useBrand(dir, source, { force: false, review: false, after: () => opening.ops });
  } catch (error) {
    wipe();
    throw error;
  }
  if (!result.ok) {
    wipe();
    return printUse(result, dir, json, io);
  }
  if (json) {
    io.out(
      JSON.stringify(
        { ok: true, dir, file, brand: result.brand, copied: result.copied, written: result.written },
        null,
        2,
      ),
    );
  } else {
    io.out(`Made the deck "${chosen}" in ${dir}, in the brand "${result.brand.name}" (${result.brand.id}).`);
    io.out(
      `  the opening scene is on the brand's title template; ${result.copied.length} font, logo and image files copied`,
    );
    io.out(opener(dir, file));
  }
  return 0;
}
