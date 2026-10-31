// Draws the logo, the mark and the social card as SVG. Colors come from brand/tokens.json and every letter is an
// outline taken from the OFL font files in brand/fonts, so the files look the same on a machine without the fonts.
import opentype from "opentype.js";

/**
 * Three planes that recede up and to the right. Each one is smaller and fainter than the one in front, which is the
 * depth cue the name points at (size, overlap, fade). The front plane carries the cue dot.
 */
const PLANES = [
  { x: 26, y: 2, size: 32, fade: 0.38 },
  { x: 16, y: 10, size: 38, fade: 0.68 },
  { x: 6, y: 18, size: 44, fade: 1 },
];
const RADIUS = 7;
const STROKE = 3;
const CUE = { x: 19, y: 49, r: 5.5 };
/** The mark is drawn on a 64 by 64 grid. */
const GRID = 64;

const round = (value) => Math.round(value * 100) / 100;

/** Parses a font file read as a Node Buffer. */
export function parseFont(buffer) {
  return opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/** The colors one theme draws with. `cue` is the brand vermilion, the one color that is the same in both. */
export function palette(tokens, name) {
  const theme = tokens.color.theme[name];
  return {
    text: theme.text.$value,
    muted: theme.muted.$value,
    bg: theme.bg.$value,
    cue: tokens.color.brand.vermilion.$value,
  };
}

const rect = (plane) =>
  `x="${plane.x}" y="${plane.y}" width="${plane.size}" height="${plane.size}" rx="${RADIUS}"`;

/** One rounded square, grown by `grow` on every side, as a sub-path, so planes in front can be cut out of those behind. */
function squarePath(plane, grow = 0) {
  const x = plane.x - grow;
  const y = plane.y - grow;
  const s = plane.size + 2 * grow;
  const r = RADIUS + grow;
  return [
    `M${x + r} ${y}H${x + s - r}A${r} ${r} 0 0 1 ${x + s} ${y + r}V${y + s - r}`,
    `A${r} ${r} 0 0 1 ${x + s - r} ${y + s}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + s - r}`,
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`,
  ].join("");
}

/**
 * The mark as the inside of an `<svg>`: no background, so it sits on any surface. `id` keeps the clip paths of
 * several marks in one document apart.
 */
export function markBody(colors, id = "m") {
  const out = ["<defs>"];
  PLANES.slice(0, -1).forEach((_, index) => {
    // Everything in front of this plane is cut out of it, so a plane behind shows only its visible edge. A stroked
    // plane in front is cut at its outer edge, so two faint strokes never overlap and darken where they cross.
    const holes = PLANES.slice(index + 1)
      .map((plane, offset) => squarePath(plane, index + 1 + offset === PLANES.length - 1 ? 0 : STROKE / 2))
      .join("");
    const clip = `M-10 -10H${GRID + 10}V${GRID + 10}H-10Z${holes}`;
    out.push(`<clipPath id="${id}${index}"><path clip-rule="evenodd" d="${clip}"/></clipPath>`);
  });
  out.push("</defs>");
  PLANES.forEach((plane, index) => {
    const front = index === PLANES.length - 1;
    out.push(
      front
        ? `<rect ${rect(plane)} fill="${colors.text}"/>`
        : `<rect ${rect(plane)} fill="none" stroke="${colors.text}" stroke-opacity="${plane.fade}" stroke-width="${STROKE}" clip-path="url(#${id}${index})"/>`,
    );
  });
  out.push(`<circle cx="${CUE.x}" cy="${CUE.y}" r="${CUE.r}" fill="${colors.cue}"/>`);
  return out.join("");
}

const svg = (width, height, label, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">${body}</svg>\n`;

/** The mark alone, for a favicon or an avatar. */
export function markSvg(colors) {
  return svg(GRID, GRID, "Depthcue", markBody(colors));
}

/** Text as one `<path>`, with its left edge at x and its baseline at y. */
export function textPath(font, text, size, x, y, fill) {
  const path = font.getPath(text, x, y, size, { kerning: true });
  return `<path fill="${fill}" d="${path.toPathData(1)}"/>`;
}

const widthOf = (font, text, size) => font.getAdvanceWidth(text, size, { kerning: true });

/** Distance from the baseline up to the middle of the lowercase letters, in px at this size. */
const xMiddle = (font, size) =>
  ((font.tables.os2?.sxHeight ?? font.unitsPerEm * 0.45) / font.unitsPerEm / 2) * size;

/** The mark and the name side by side, sized to the mark's height. */
export function logoSvg(colors, display) {
  const size = 60;
  const gap = 16;
  const x = GRID + gap;
  const baseline = round(GRID / 2 + xMiddle(display, size));
  const width = Math.ceil(x + widthOf(display, "Depthcue", size));
  const body = `${markBody(colors)}${textPath(display, "Depthcue", size, x, baseline, colors.text)}`;
  return svg(width, GRID, "Depthcue", body);
}

const CARD = { width: 1280, height: 640, margin: 96 };
const TAGLINE = ["Explanations an agent can write,", "a person can repair, and both can present."];
const FACTS = "MIT license · typed JSON decks · offline export";

/** The 1280 by 640 card that a link preview shows. */
export function cardSvg(colors, fonts) {
  const { width, height, margin } = CARD;
  // The whole mark, never cropped: cut off at an edge its back planes read as the handle of a bag. Its right edge
  // (the back plane's, at 59.5 on the grid) sits on the margin and it is centred on the card's height.
  const scale = 5.6;
  const left = round(width - margin - 59.5 * scale);
  const top = round((height - GRID * scale) / 2);
  const mark = `<g transform="translate(${left} ${top}) scale(${scale})">${markBody(colors, "c")}</g>`;
  const lines = [
    textPath(fonts.display, "Depthcue", 176, margin, 286, colors.text),
    textPath(fonts.ui, TAGLINE[0], 34, margin, 372, colors.text),
    textPath(fonts.ui, TAGLINE[1], 34, margin, 416, colors.text),
    textPath(fonts.mono, FACTS, 24, margin, 540, colors.muted),
  ];
  const body = `<rect width="${width}" height="${height}" fill="${colors.bg}"/>${mark}${lines.join("")}`;
  return svg(
    width,
    height,
    "Depthcue: explanations an agent can write, a person can repair, and both can present",
    body,
  );
}

/**
 * Every generated brand file as a Map of repository path to text. `fonts` holds three parsed fonts: display (the
 * serif), ui (the grotesk) and mono. The `-on-dark` files are for dark surfaces; the others, for light ones.
 */
export function brandFiles(tokens, fonts) {
  const files = new Map();
  for (const [theme, suffix] of [
    ["paper", ""],
    ["ink", "-on-dark"],
  ]) {
    const colors = palette(tokens, theme);
    files.set(`brand/mark${suffix}.svg`, markSvg(colors));
    files.set(`brand/logo${suffix}.svg`, logoSvg(colors, fonts.display));
    files.set(`brand/social-card${suffix}.svg`, cardSvg(colors, fonts));
  }
  return files;
}
