/**
 * The deck's fonts in the PowerPoint file. Every family the slides draw in that has files (the brand's faces, and the
 * built-in pair's faces the player ships) is embedded as PowerPoint embeds a font: one Embedded OpenType part per face,
 * listed in `presentation.xml`. Nothing about a font is changed: a file that may not be embedded, has CFF outlines, or
 * does not say it is the face it stands for is left out and named in the report.
 *
 * PowerPoint knows an embedded font by the family name inside its file, which is not always the name the deck gives it:
 * a brand may call a file "Harbor Sans" whose own name is "Space Grotesk". Renaming the font would change it (and some
 * licenses reserve their names), so the file's text is written with the font's own name instead, and the report says so.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DeckLook } from "@depthcue/core";
import { eotOf } from "./eot.ts";
import { FontError, type FontFacts, factsOf, unpackFont, writeSfnt } from "./sfnt.ts";

/** One file the page may load for a family. */
export interface FaceFile {
  /** The family the page loads it for. */
  family: string;
  weight: number;
  italic: boolean;
  /** Where it is on disk, and how the report names it. */
  file: string;
  label: string;
  /** The characters the page loads it for, when the family is split into several files. */
  ranges?: Array<[number, number]>;
}

/** The four faces PowerPoint keeps for a family. */
export const SLOTS = ["regular", "bold", "italic", "boldItalic"] as const;
export type Slot = (typeof SLOTS)[number];
const SLOT_WORDS: Record<Slot, string> = {
  regular: "regular",
  bold: "bold",
  italic: "italic",
  boldItalic: "bold italic",
};

const slotOf = (bold: boolean, italic: boolean): Slot =>
  bold ? (italic ? "boldItalic" : "bold") : italic ? "italic" : "regular";

/** How a family's files went into the file, for the report. */
export interface FontReport {
  /** The family as the deck names it. */
  family: string;
  /** The name PowerPoint knows it by, when that is another one. */
  as?: string;
  /** The faces that are in the file. */
  embedded: string[];
  /** Why a face the slides draw, or the whole family, is not. */
  notes: string[];
}

export interface FontParts {
  /** `ppt/fonts/fontN.fntdata`, in order. */
  parts: Array<{ name: string; bytes: Uint8Array }>;
  /** One entry per PowerPoint family: its name, its PANOSE and the part each face is in. */
  list: Array<{ typeface: string; panose: string; faces: Array<{ slot: Slot; part: number }> }>;
  /** Deck family to the name PowerPoint knows it by, where they differ. */
  rename: Map<string, string>;
  /** Families the page draws only in a bold file, so a run in them is bold in the file too. */
  boldOnly: Set<string>;
  report: FontReport[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Where the files are.
// ---------------------------------------------------------------------------------------------------------------------

const CSS_RULE = /@font-face\s*\{([^}]*)\}/g;
const declaration = (body: string, name: string) =>
  new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

/** `U+0020-007E, U+00A0` as ranges of code points. */
export function parseUnicodeRange(text: string): Array<[number, number]> {
  return text.split(",").flatMap((part) => {
    const match = /U\+([0-9A-F?]+)(?:-([0-9A-F]+))?/i.exec(part.trim());
    if (!match) return [];
    const [start, end] = match[1]?.includes("?")
      ? [
          Number.parseInt((match[1] as string).replaceAll("?", "0"), 16),
          Number.parseInt((match[1] as string).replaceAll("?", "F"), 16),
        ]
      : [Number.parseInt(match[1] as string, 16), Number.parseInt(match[2] ?? (match[1] as string), 16)];
    return [[start, end] as [number, number]];
  });
}

/** The files a built-in pair's stylesheet loads, by family. */
export function pairFaces(css: string, dir: string): FaceFile[] {
  const out: FaceFile[] = [];
  for (const [, body = ""] of css.matchAll(CSS_RULE)) {
    const family = declaration(body, "font-family")?.replace(/^["']|["']$/g, "");
    const src = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(declaration(body, "src") ?? "")?.[1];
    if (!family || !src) continue;
    const ranges = declaration(body, "unicode-range");
    out.push({
      family,
      weight: Number(declaration(body, "font-weight") ?? 400) || 400,
      italic: (declaration(body, "font-style") ?? "normal") !== "normal",
      file: join(dir, src),
      label: src,
      ...(ranges ? { ranges: parseUnicodeRange(ranges) } : {}),
    });
  }
  return out;
}

/** Every file the page may load, by family: the brand's faces, then the built-in pair's. */
export function faceFiles(look: DeckLook, folder: string, fontsDir: string): Map<string, FaceFile[]> {
  const byFamily = new Map<string, FaceFile[]>();
  const add = (face: FaceFile) => byFamily.set(face.family, [...(byFamily.get(face.family) ?? []), face]);
  for (const face of [look.faces?.display, look.faces?.body, look.faces?.mono]) {
    if (!face || byFamily.has(face.family)) continue;
    byFamily.set(face.family, []);
    for (const entry of face.files) {
      add({
        family: face.family,
        weight: entry.weight,
        italic: entry.style !== "normal",
        file: resolve(folder, entry.path),
        label: entry.path,
      });
    }
  }
  const css = join(fontsDir, `${look.fonts}.css`);
  if (existsSync(css)) {
    for (const face of pairFaces(readFileSync(css, "utf8"), fontsDir)) {
      // A brand face of the same name is the one the page loads.
      const brand = [look.faces?.display, look.faces?.body, look.faces?.mono].some(
        (own) => own?.family === face.family,
      );
      if (!brand) add(face);
    }
  }
  return byFamily;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the slides draw.
// ---------------------------------------------------------------------------------------------------------------------

/** What the slides draw in one family: in which faces, and which characters. */
export interface Usage {
  slots: Set<Slot>;
  chars: Set<number>;
}

const unescapeXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#x([0-9a-f]+);/gi, (_whole, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_whole, digits: string) => String.fromCodePoint(Number(digits)))
    .replaceAll("&amp;", "&");

const RUN = /<a:r>([\s\S]*?)<\/a:r>/g;
const RUN_PROPERTIES = /<a:(?:rPr|defRPr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:(?:rPr|defRPr)>)/g;
const LATIN = /<a:latin typeface="([^"]*)"/;
const flag = (attributes: string, name: string) => new RegExp(`\\b${name}="(1|true)"`).test(attributes);

/** The families a part's runs are set in, with their faces and characters, added to `usage`. */
export function scanUsage(xml: string, usage: Map<string, Usage>, chart = false): void {
  const entry = (family: string) => {
    const known = usage.get(family);
    if (known) return known;
    const made: Usage = { slots: new Set(), chars: new Set() };
    usage.set(family, made);
    return made;
  };
  const named = new Set<string>();
  for (const [, attributes = "", inner = ""] of xml.matchAll(RUN_PROPERTIES)) {
    const family = LATIN.exec(inner)?.[1];
    if (!family || family.startsWith("+")) continue;
    const name = unescapeXml(family);
    named.add(name);
    entry(name).slots.add(slotOf(flag(attributes, "b"), flag(attributes, "i")));
  }
  for (const [, run = ""] of xml.matchAll(RUN)) {
    const family = LATIN.exec(run)?.[1];
    const text = /<a:t>([\s\S]*?)<\/a:t>/.exec(run)?.[1];
    if (!family || text === undefined || family.startsWith("+")) continue;
    const chars = entry(unescapeXml(family)).chars;
    for (const character of unescapeXml(text)) chars.add(character.codePointAt(0) as number);
  }
  if (chart) {
    // A chart draws its categories and numbers from its cache, each in the faces the chart names.
    const words = [...xml.matchAll(/<c:v>([^<]*)<\/c:v>/g), ...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
      .map((match) => unescapeXml(match[1] ?? ""))
      .join("");
    for (const family of named) {
      const chars = entry(family).chars;
      for (const character of words) chars.add(character.codePointAt(0) as number);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Choosing and packing the faces.
// ---------------------------------------------------------------------------------------------------------------------

interface Chosen {
  slot: Slot;
  file: FaceFile;
  bytes: Uint8Array;
  facts: FontFacts;
}

const RESTRICTED = 0x0002;
const BITMAP_ONLY = 0x0200;
const PREVIEW_AND_PRINT = 0x0004;

const describe = (code: number) =>
  `${String.fromCodePoint(code)} (U+${code.toString(16).toUpperCase().padStart(4, "0")})`;

/** The file a face comes from: the right slant, the weight nearest the slot's, the one covering most of `chars`. */
function pick(
  files: readonly FaceFile[],
  slot: Slot,
  decoded: (file: FaceFile) => FontFacts | undefined,
  chars: Set<number>,
) {
  const italic = slot === "italic" || slot === "boldItalic";
  const bold = slot === "bold" || slot === "boldItalic";
  const target = bold ? 700 : 400;
  const fitting = files.filter((file) => file.italic === italic && file.weight >= 600 === bold);
  if (fitting.length === 0) return undefined;
  const nearest = Math.min(...fitting.map((file) => Math.abs(file.weight - target)));
  const candidates = fitting.filter((file) => Math.abs(file.weight - target) === nearest);
  if (candidates.length === 1) return candidates[0];
  let best: FaceFile | undefined;
  let score = -1;
  for (const file of candidates) {
    const facts = decoded(file);
    if (!facts) continue;
    let covered = 0;
    for (const code of chars) if (facts.covers(code)) covered++;
    if (covered > score) {
      score = covered;
      best = file;
    }
  }
  return best ?? candidates[0];
}

/**
 * The embedded fonts for the families the slides draw (`usage`), from the files the page loads (`files`). Pure but for
 * reading the files, and in a fixed order, so the same deck gives the same parts.
 */
export function planFonts(
  usage: ReadonlyMap<string, Usage>,
  files: ReadonlyMap<string, readonly FaceFile[]>,
): FontParts {
  const cache = new Map<string, { bytes: Uint8Array; facts: FontFacts } | { error: string }>();
  const load = (file: FaceFile) => {
    const known = cache.get(file.file);
    if (known) return known;
    let made: { bytes: Uint8Array; facts: FontFacts } | { error: string };
    try {
      const font = unpackFont(new Uint8Array(readFileSync(file.file)));
      made = { bytes: writeSfnt(font), facts: factsOf(font) };
    } catch (error) {
      // Said inside a sentence of the report: "<file>: the file is not a font ..., so it is not embedded."
      const reason = error instanceof FontError ? error.message.replace(/\.$/, "") : "";
      made = {
        error:
          error instanceof FontError
            ? `${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
            : `it could not be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`,
      };
    }
    cache.set(file.file, made);
    return made;
  };
  const factsFor = (file: FaceFile) => {
    const loaded = load(file);
    return "facts" in loaded ? loaded.facts : undefined;
  };

  const report: FontReport[] = [];
  const rename = new Map<string, string>();
  const boldOnly = new Set<string>();
  /** The faces each PowerPoint family gets, by its own name. */
  const families = new Map<string, Map<Slot, Chosen>>();
  const hashes = new Map<string, string>();

  const names = [...usage.keys()].sort();
  for (const family of names) {
    const use = usage.get(family) as Usage;
    const own = files.get(family) ?? [];
    const line: FontReport = { family, embedded: [], notes: [] };
    report.push(line);
    if (own.length === 0) {
      line.notes.push("no font file, so a viewer needs it installed to see it as drawn.");
      continue;
    }
    if (own.every((file) => file.weight >= 600 && !file.italic)) boldOnly.add(family);
    const wanted = new Set<Slot>(use.slots);
    if (boldOnly.has(family)) {
      wanted.delete("regular");
      wanted.add("bold");
    } else wanted.add("regular");
    let base: string | undefined;
    for (const slot of SLOTS) {
      if (!wanted.has(slot)) continue;
      const file = pick(own, slot, factsFor, use.chars);
      if (!file) {
        if (use.slots.has(slot))
          line.notes.push(
            `no ${SLOT_WORDS[slot]} file, so PowerPoint draws ${SLOT_WORDS[slot]} text from another face, as the player does.`,
          );
        continue;
      }
      const loaded = load(file);
      if ("error" in loaded) {
        line.notes.push(`${file.label}: ${loaded.error}, so it is not embedded.`);
        continue;
      }
      const { facts, bytes } = loaded;
      if (facts.outlines === "cff") {
        line.notes.push(
          `${file.label} has CFF outlines, which PowerPoint does not embed, so it is not embedded.`,
        );
        continue;
      }
      if (facts.fsType & RESTRICTED || facts.fsType & BITMAP_ONLY) {
        line.notes.push(
          `${file.label} says it may not be embedded (OS/2 fsType ${facts.fsType}), so it is not; a viewer needs it installed.`,
        );
        continue;
      }
      if (
        facts.bold !== (slot === "bold" || slot === "boldItalic") ||
        facts.italic !== (slot === "italic" || slot === "boldItalic")
      ) {
        line.notes.push(
          `${file.label} is "${facts.family} ${facts.style}" by its own name, not a ${SLOT_WORDS[slot]} face of a family, so PowerPoint cannot take it as one and draws ${SLOT_WORDS[slot]} text from the ${slot === "regular" ? "nearest" : "regular"} face.`,
        );
        continue;
      }
      base ??= facts.family;
      if (facts.family !== base) {
        line.notes.push(
          `${file.label} is named "${facts.family}" inside, not "${base}" as the family's other faces are, so it is not embedded.`,
        );
        continue;
      }
      if (facts.fsType & PREVIEW_AND_PRINT && !line.notes.some((note) => note.includes("preview")))
        line.notes.push(
          "its files allow embedding for preview and print only, so PowerPoint may open the file read-only.",
        );
      const faces = families.get(base) ?? new Map<Slot, Chosen>();
      families.set(base, faces);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const taken = faces.get(slot);
      if (taken && hashes.get(`${base}|${slot}`) !== hash) {
        line.notes.push(
          `its ${SLOT_WORDS[slot]} face shares the name "${base}" with another family's file, and PowerPoint keeps one: ${taken.file.label}.`,
        );
      } else if (!taken) {
        faces.set(slot, { slot, file, bytes, facts });
        hashes.set(`${base}|${slot}`, hash);
      }
      line.embedded.push(SLOT_WORDS[slot]);
      // A family split into files by script: say what the embedded file does not have.
      if (
        file.ranges &&
        own.some((other) => other !== file && other.weight === file.weight && other.italic === file.italic)
      ) {
        const missing = [...use.chars]
          .filter((code) => code > 0x20 && !facts.covers(code))
          .sort((a, b) => a - b);
        if (missing.length > 0) {
          line.notes.push(
            `only ${file.label} of its files is embedded for ${SLOT_WORDS[slot]}; ${missing.slice(0, 12).map(describe).join(", ")}${missing.length > 12 ? ` and ${missing.length - 12} more` : ""} come from another face.`,
          );
        }
      }
    }
    if (base !== undefined && base !== family) {
      rename.set(family, base);
      line.as = base;
      line.notes.push(
        `its file names itself "${base}", which is the name PowerPoint knows it by, so the slides use that name.`,
      );
    }
    if (line.embedded.length === 0 && line.notes.length === 0) line.notes.push("not embedded.");
  }

  const parts: FontParts["parts"] = [];
  const list: FontParts["list"] = [];
  for (const typeface of [...families.keys()].sort()) {
    const faces = families.get(typeface) as Map<Slot, Chosen>;
    const entry: FontParts["list"][number] = { typeface, panose: "", faces: [] };
    for (const slot of SLOTS) {
      const chosen = faces.get(slot);
      if (!chosen) continue;
      if (entry.panose === "")
        entry.panose = [...chosen.facts.panose]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")
          .toUpperCase();
      parts.push({
        name: `ppt/fonts/font${parts.length + 1}.fntdata`,
        bytes: eotOf(chosen.bytes, chosen.facts),
      });
      entry.faces.push({ slot, part: parts.length });
    }
    list.push(entry);
  }
  return { parts, list, rename, boldOnly, report };
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing them into the package.
// ---------------------------------------------------------------------------------------------------------------------

const escapeAttribute = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const FONT_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";

/** Runs set in a family drawn only in bold become bold, and every family is written by the name PowerPoint knows. */
export function applyNames(xml: string, fonts: Pick<FontParts, "rename" | "boldOnly">): string {
  let out = xml;
  if (fonts.boldOnly.size > 0) {
    out = out.replace(RUN_PROPERTIES, (whole, attributes: string, inner?: string) => {
      const family = inner === undefined ? undefined : LATIN.exec(inner)?.[1];
      if (family === undefined || !fonts.boldOnly.has(unescapeXml(family)) || flag(attributes, "b"))
        return whole;
      const tag = /^<a:(rPr|defRPr)/.exec(whole)?.[1] as string;
      const bolded = attributes.replace(/\sb="[^"]*"/, "");
      return whole.replace(`<a:${tag}${attributes}`, `<a:${tag}${bolded} b="1"`);
    });
  }
  for (const [from, to] of fonts.rename) {
    out = out.replaceAll(`typeface="${escapeAttribute(from)}"`, `typeface="${escapeAttribute(to)}"`);
  }
  return out;
}

/** `presentation.xml`, its relationships and the content types, with the fonts listed. */
export function listFonts(
  presentation: string,
  rels: string,
  types: string,
  fonts: Pick<FontParts, "parts" | "list">,
): { presentation: string; rels: string; types: string } {
  if (fonts.parts.length === 0) return { presentation, rels, types };
  const entries = fonts.list
    .filter((entry) => entry.faces.length > 0)
    .map(
      (entry) =>
        `<p:embeddedFont><p:font typeface="${escapeAttribute(entry.typeface)}"${entry.panose ? ` panose="${entry.panose}"` : ""} charset="0"/>${entry.faces
          .map((face) => `<p:${face.slot} r:id="rIdFont${face.part}"/>`)
          .join("")}</p:embeddedFont>`,
    )
    .join("");
  let list = presentation.replace(
    /(<p:notesSz\b[^>]*\/>)/,
    `$1<p:embeddedFontLst>${entries}</p:embeddedFontLst>`,
  );
  list = list.replace(/<p:presentation\b([^>]*)>/, (whole, attributes: string) =>
    attributes.includes("embedTrueTypeFonts")
      ? whole
      : `<p:presentation${attributes} embedTrueTypeFonts="1">`,
  );
  const links = fonts.parts
    .map(
      (part, at) =>
        `<Relationship Id="rIdFont${at + 1}" Type="${FONT_RELATIONSHIP}" Target="${part.name.replace("ppt/", "")}"/>`,
    )
    .join("");
  return {
    presentation: list,
    rels: rels.replace("</Relationships>", `${links}</Relationships>`),
    types: types.includes('Extension="fntdata"')
      ? types
      : types.replace(
          /(<Types\b[^>]*>)/,
          '$1<Default Extension="fntdata" ContentType="application/x-fontdata"/>',
        ),
  };
}
