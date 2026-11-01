/**
 * Depthcue's own templates and component styles, which every deck may use, drawn in its brand's colors and fonts. A
 * brand's template or style with the same id replaces one of these, and a brand can hide them (`hideBuiltIn`). The
 * player never imports this file: the server and the export hand it the templates a deck uses (see `lookOf`).
 */
import type { BlockStyle, Template } from "./types.ts";

/** Every kind of block but a heading: what a column of a slide takes. */
const column = (): Template["slots"][number]["accepts"] => [
  "body",
  "quote",
  "caption",
  "image",
  "table",
  "chart",
  "clip",
];

export const BUILT_IN_TEMPLATES: Readonly<Record<string, Template>> = {
  section: {
    schemaVersion: "0.4",
    id: "section",
    name: "Section",
    description:
      "Opens a part of the deck: its name large on a full color, with a label above and a line below.",
    background: { color: "text" },
    chrome: "minimal",
    slots: [
      {
        id: "kicker",
        frame: { x: 8, y: 24, w: 84, h: 8 },
        accepts: ["caption"],
        hint: "A short label above the name, such as Part 2.",
      },
      {
        id: "title",
        frame: { x: 8, y: 34, w: 84, h: 22 },
        accepts: ["heading"],
        required: true,
        hint: "The name of the section, in a few words.",
      },
      {
        id: "lede",
        frame: { x: 8, y: 60, w: 70, h: 16 },
        accepts: ["body"],
        hint: "One sentence on what the section covers.",
      },
    ],
  },
  "two-column": {
    schemaVersion: "0.4",
    id: "two-column",
    name: "Two columns",
    description:
      "A heading over two columns read left to right: text beside a picture, or two things compared.",
    slots: [
      {
        id: "title",
        frame: { x: 6, y: 6, w: 88, h: 14 },
        accepts: ["heading"],
        required: true,
        hint: "What the two columns show together.",
      },
      {
        id: "left",
        frame: { x: 6, y: 24, w: 42, h: 68 },
        accepts: column(),
        max: 3,
        required: true,
        hint: "The first column: text, a picture, a table or a chart.",
      },
      {
        id: "right",
        frame: { x: 52, y: 24, w: 42, h: 68 },
        accepts: column(),
        max: 3,
        hint: "The second column, read after the first.",
      },
    ],
  },
};

export const BUILT_IN_STYLES: Readonly<Record<string, BlockStyle>> = {
  callout: {
    name: "Callout",
    for: ["body", "quote", "caption"],
    fill: "surface",
    edge: "start",
    radius: "s",
    pad: "m",
  },
  stat: {
    name: "Stat",
    for: ["heading", "body"],
    font: "display",
    size: "xl",
    weight: "bold",
    tone: "action",
  },
};
