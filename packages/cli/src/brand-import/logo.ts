/**
 * The brand's logo from the pictures on a slide master. A logo is a small picture in a corner, so of the pictures the
 * master holds (or the title layout, when the master holds none) the smallest one in a corner is taken, in the format it
 * has. Every other picture is listed with the reason it was left out.
 */
import type { Brand } from "@depthcue/core";
import type { OfficePackage, Relationship } from "./package.ts";
import type { Box, Shape } from "./shapes.ts";
import { svgProblem } from "./svg.ts";
import { child, find } from "./xml.ts";

type ChromeLogo = NonNullable<NonNullable<Brand["chrome"]>["logo"]>;
type Corner = ChromeLogo["corner"];
type Size = ChromeLogo["size"];

/** A picture that could be the logo, with the part it was found in, whose relationships say where its image is. */
export interface LogoCandidate {
  shape: Shape;
  /** The part the picture is on, such as the master. */
  rels: readonly Relationship[];
  where: string;
}

export interface Logo {
  /** The file inside the brand folder, such as `logos/logo.png`. */
  file: string;
  bytes: Uint8Array;
  alt: string;
  corner: Corner;
  size: Size;
  /** Where the picture was, and anything done to its format. */
  from: string;
}

export interface SkippedPicture {
  name: string;
  where: string;
  why: string;
}

export interface LogoChoice {
  logo?: Logo;
  skipped: SkippedPicture[];
}

/** A logo is not larger than this share of the slide; a bigger picture in a corner is a decoration. */
const MAX_SHARE = 0.2;
/** A picture is "in a corner" when its center is in the outer 35% of the slide both across and down. */
const CORNER_EDGE = 0.35;
/**
 * A picture that reaches the slide's edge (within this share of the slide) is artwork bleeding off the slide, such as the
 * ribbons of PowerPoint's Ion theme; a logo is set in from the edge.
 */
const BLEED = 0.005;

/** True when the box touches or passes an edge of the slide. */
export const touchesEdge = (box: Box, slide: { w: number; h: number }): boolean =>
  box.x <= BLEED * slide.w ||
  box.y <= BLEED * slide.h ||
  box.x + box.w >= (1 - BLEED) * slide.w ||
  box.y + box.h >= (1 - BLEED) * slide.h;
/**
 * Logo heights as a share of the slide's height that `s`, `m` and `l` stand for, as the player draws them: 2, 3 and
 * 4.4 em (`.dc-logo` in `player.css`), where a scene's em is 2.5% of a 16:9 stage's height. The picture's share is
 * matched to the nearest. A test reads `player.css` and fails, naming this table, when the two part.
 */
export const SIZE_HEIGHTS: Readonly<Record<Size, number>> = { s: 0.05, m: 0.075, l: 0.11 };

export function nearestSize(heightShare: number): Size {
  const sizes = Object.keys(SIZE_HEIGHTS) as Size[];
  return sizes.reduce((best, size) =>
    Math.abs(SIZE_HEIGHTS[size] - heightShare) < Math.abs(SIZE_HEIGHTS[best] - heightShare) ? size : best,
  );
}

export function cornerOf(box: Box, slide: { w: number; h: number }): Corner | undefined {
  const across = (box.x + box.w / 2) / slide.w;
  const down = (box.y + box.h / 2) / slide.h;
  const [left, right] = [across < CORNER_EDGE, across > 1 - CORNER_EDGE];
  const [top, bottom] = [down < CORNER_EDGE, down > 1 - CORNER_EDGE];
  if (!(left || right) || !(top || bottom)) return undefined;
  return `${top ? "top" : "bottom"}-${left ? "start" : "end"}`;
}

const starts = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((value, index) => bytes[at + index] === value);

export type ImageFormat = "png" | "jpeg" | "svg" | "gif" | "emf" | "wmf" | "unknown";

/** The picture's format, from its first bytes: a file's name can say anything. */
export function formatOf(bytes: Uint8Array): ImageFormat {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (starts(bytes, [0x01, 0x00, 0x00, 0x00]) && starts(bytes, [0x20, 0x45, 0x4d, 0x46], 40)) return "emf";
  if (
    starts(bytes, [0xd7, 0xcd, 0xc6, 0x9a]) ||
    starts(bytes, [0x01, 0x00, 0x09, 0x00]) ||
    starts(bytes, [0x02, 0x00, 0x09, 0x00])
  ) {
    return "wmf";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  if (/<svg[\s>]/i.test(head)) return "svg";
  return "unknown";
}

/** The pixel size of a JPEG, from its first start-of-frame marker. */
export function jpegSize(bytes: Uint8Array): { w: number; h: number } | undefined {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] as number;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return {
        h: ((bytes[at + 5] as number) << 8) | (bytes[at + 6] as number),
        w: ((bytes[at + 7] as number) << 8) | (bytes[at + 8] as number),
      };
    }
    at += 2 + length;
  }
  return undefined;
}

/** A JPEG inside an SVG, byte for byte, because a brand's logo is an SVG or a PNG and a JPEG is neither. */
export function svgAroundJpeg(bytes: Uint8Array, fallback: { w: number; h: number }): Uint8Array {
  const size = jpegSize(bytes) ?? fallback;
  const w = Math.max(1, Math.round(size.w));
  const h = Math.max(1, Math.round(size.h));
  const data = Buffer.from(bytes).toString("base64");
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" xlink:href="data:image/jpeg;base64,${data}"/></svg>\n`,
  );
}

const nameOf = (shape: Shape): string => shape.name || "a picture";

/** The alt text for the logo: the picture's own, else its name when it says "logo", else the brand's name. */
function altOf(shape: Shape, brandName: string): string {
  const own = shape.descr || (/logo/i.test(shape.name) ? shape.name : "");
  return (own || `${brandName} logo`).slice(0, 250);
}

/** The image part a picture shows: its SVG when it has one, else the picture itself. */
export function imagePartOf(
  shape: Shape,
  rels: readonly Relationship[],
): { part?: string; svg: boolean; cropped: boolean } {
  const blipFill = child(shape.node, "blipFill");
  const blip = child(blipFill, "blip");
  const svgId = find(blip, "svgBlip")?.attrs["r:embed"];
  const id = blip?.attrs["r:embed"];
  const crop = child(blipFill, "srcRect");
  const cropped = ["l", "t", "r", "b"].some((side) => Number(crop?.attrs[side] ?? 0) !== 0);
  const svgPart = svgId ? rels.find((rel) => rel.id === svgId)?.target : undefined;
  if (svgPart) return { part: svgPart, svg: true, cropped };
  const part = id ? rels.find((rel) => rel.id === id)?.target : undefined;
  return { ...(part ? { part } : {}), svg: false, cropped };
}

/**
 * Picks the logo from the candidates. The smallest picture in a corner is the logo, if its format can be kept; if it
 * cannot, there is no logo, and the report says why, rather than a larger picture standing in for it.
 */
export async function chooseLogo(
  pkg: OfficePackage,
  candidates: readonly LogoCandidate[],
  slide: { w: number; h: number },
  brandName: string,
): Promise<LogoChoice> {
  const skipped: SkippedPicture[] = [];
  const corner: Array<{ candidate: LogoCandidate; box: Box; corner: Corner }> = [];
  for (const candidate of candidates) {
    const { shape } = candidate;
    const left = (why: string) => skipped.push({ name: nameOf(shape), where: candidate.where, why });
    if (!shape.box) left("it has no position");
    else if (shape.turned) left("it is rotated or flipped");
    else if (shape.box.w * shape.box.h > MAX_SHARE * slide.w * slide.h) {
      left(
        `it covers ${Math.round((shape.box.w * shape.box.h * 100) / (slide.w * slide.h))}% of the slide, which is a decoration, not a logo`,
      );
    } else if (touchesEdge(shape.box, slide)) {
      left("it reaches the edge of the slide, as artwork does; a logo is set in from the edge");
    } else {
      const where = cornerOf(shape.box, slide);
      if (where) corner.push({ candidate, box: shape.box, corner: where });
      else left("it is not in a corner of the slide");
    }
  }
  corner.sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
  const [pick, ...others] = corner;
  for (const other of others) {
    skipped.push({
      name: nameOf(other.candidate.shape),
      where: other.candidate.where,
      why: "a smaller picture in a corner was taken as the logo",
    });
  }
  if (!pick) return { skipped };

  const { shape, rels, where } = pick.candidate;
  const refuse = (why: string): LogoChoice => ({
    skipped: [
      ...skipped,
      { name: nameOf(shape), where, why: `it is the smallest picture in a corner, so the logo, but ${why}` },
    ],
  });
  const image = imagePartOf(shape, rels);
  const bytes = image.part ? await pkg.bytes(image.part) : undefined;
  if (!bytes) return refuse("its image is not in the file");
  const format = formatOf(bytes);
  const base = {
    alt: altOf(shape, brandName),
    corner: pick.corner,
    size: nearestSize(pick.box.h / slide.h),
  };
  const from = `${nameOf(shape)} on ${where}${image.cropped ? ", its crop is not applied" : ""}`;
  if (format === "png") return { logo: { ...base, file: "logos/logo.png", bytes, from }, skipped };
  if (format === "svg") {
    const problem = svgProblem(new TextDecoder().decode(bytes));
    if (problem) return refuse(`its SVG has ${problem}, which a logo may not`);
    return { logo: { ...base, file: "logos/logo.svg", bytes, from }, skipped };
  }
  if (format === "jpeg") {
    // A brand names its logo as an SVG or a PNG, and no decoder is on hand to make a PNG: the JPEG goes in an SVG as is.
    const wrapped = svgAroundJpeg(bytes, { w: pick.box.w / 9525, h: pick.box.h / 9525 });
    return {
      logo: {
        ...base,
        file: "logos/logo.svg",
        bytes: wrapped,
        from: `${from}; a JPEG, so it is kept unchanged inside an SVG, as a brand's logo is an SVG or a PNG`,
      },
      skipped,
    };
  }
  if (format === "emf" || format === "wmf") {
    return refuse(
      `it is a ${format.toUpperCase()} picture, which this cannot convert; save the logo from PowerPoint as a PNG or SVG (right-click it, Save as Picture) and add it to the brand`,
    );
  }
  if (format === "gif") return refuse("it is a GIF, and a brand's logo is an SVG or a PNG");
  return refuse("its image is in a format this does not know");
}
