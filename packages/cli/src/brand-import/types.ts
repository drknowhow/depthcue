/** The shapes the import's pieces hand to each other and to the report. */
import type { Diagnostic, TemplateSlot, ThemeName } from "@depthcue/core";
import type { PaletteName } from "./palette.ts";

/** Something in the file that did not come across, and why. */
export interface Left {
  what: string;
  why: string;
}

export type SlotRole = TemplateSlot["role"];

export interface SlotReport {
  id: string;
  role: SlotRole;
  accepts: string[];
  /** The frame in percent of the slide. */
  frame: { x: number; y: number; w: number; h: number };
  valign?: string;
  hint: string;
  /** The placeholder's type in the file (`title`, `body`, `obj`), and its name. */
  placeholder: string;
}

export interface TemplateReport {
  id: string;
  name: string;
  /** The layout's name in the file. */
  layout: string;
  slots: SlotReport[];
  background?: string;
  chrome?: string;
}

export interface ColorLineReport {
  name: PaletteName;
  value: string;
  source: "theme" | "derived" | "preset";
  from: string;
}

export interface KeptReport {
  name: PaletteName;
  wanted: string;
  from: string;
  ratio: string;
  need: number;
  against: PaletteName;
  againstValue: string;
  used: string;
}

/** What `depthcue brand import` did, as the report prints it and `--json` gives it. */
export interface ImportReport {
  source: {
    file: string;
    kind: "potx" | "pptx" | "thmx";
    theme?: string;
    /** The slide size in EMU, and its shape as a ratio such as "16:9". */
    slide: { width: number; height: number; ratio: string };
  };
  out: string;
  brand: { id: string; name: string };
  /** Which preset the colors are for, and why. A deck must use this theme to show them. */
  preset: { name: ThemeName; why: string };
  colors: ColorLineReport[];
  /** Theme colors that failed a contrast rule, and the preset's color that stayed. */
  kept: KeptReport[];
  chart: { colors: string[]; from: string[] } | null;
  fonts: {
    display: { family: string; kind: string; rule: string };
    body: { family: string; kind: string; rule: string };
    fallback: string;
    fallbackRule: string;
  } | null;
  logo: { file: string; corner: string; size: string; alt: string; from: string } | null;
  chrome: { logo?: string; footer?: string; number?: string };
  templates: TemplateReport[];
  /** Files written, relative to the brand folder. */
  files: string[];
  left: Left[];
  /** Facts that are neither taken nor left out: the slide was scaled, a color was worked out, and the like. */
  notes: string[];
}

export type { Diagnostic };
