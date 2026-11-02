/**
 * The shapes on a slide master or a layout: placeholders, pictures and everything else, each with the box it occupies
 * on the slide. Shapes inside groups are placed by the group's transform, so a logo that sits in a group of marks is
 * found where it is drawn.
 */
import { child, descend, integer, type XmlNode } from "./xml.ts";

/** A box on the slide, in EMU (914,400 to the inch). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placeholder {
  /** The placeholder's type as the file writes it. A placeholder with no type is an `obj`, an object. */
  type: string;
  idx?: string;
}

export interface Shape {
  kind: "placeholder" | "picture" | "other";
  /** The element the shape was read from. */
  node: XmlNode;
  name: string;
  /** The alternative text, when the shape has some. */
  descr: string;
  placeholder?: Placeholder;
  box?: Box;
  /** True when the shape is rotated or flipped, so its box is not what is drawn. */
  turned: boolean;
}

/** How a group maps its children's coordinates onto the slide. */
interface Transform {
  scaleX: number;
  scaleY: number;
  moveX: number;
  moveY: number;
  /** True inside a group that is rotated or flipped (or inside one), so no child's box is what is drawn. */
  turned: boolean;
}

const IDENTITY: Transform = { scaleX: 1, scaleY: 1, moveX: 0, moveY: 0, turned: false };

/** The box an `a:xfrm` (or `p:xfrm`) gives, and whether it is rotated. */
function readXfrm(xfrm: XmlNode | undefined): { box?: Box; turned: boolean } {
  const off = child(xfrm, "off");
  const ext = child(xfrm, "ext");
  const [x, y, w, h] = [integer(off, "x"), integer(off, "y"), integer(ext, "cx"), integer(ext, "cy")];
  const turned = (integer(xfrm, "rot") ?? 0) !== 0 || xfrm?.attrs.flipV === "1" || xfrm?.attrs.flipH === "1";
  if (x === undefined || y === undefined || w === undefined || h === undefined) return { turned };
  return { box: { x, y, w, h }, turned };
}

/**
 * The transform a group applies to its children: where its own box is, against the box its children were drawn in. A
 * group that is rotated or flipped turns its children with it, and that is passed down rather than worked out: the boxes
 * of what is inside are marked as not what is drawn.
 */
function groupTransform(group: XmlNode, outer: Transform): Transform {
  const xfrm = descend(group, "grpSpPr", "xfrm");
  const { box: own, turned } = readXfrm(xfrm);
  const chOff = child(xfrm, "chOff");
  const chExt = child(xfrm, "chExt");
  const [cx, cy, cw, ch] = [
    integer(chOff, "x"),
    integer(chOff, "y"),
    integer(chExt, "cx"),
    integer(chExt, "cy"),
  ];
  const parent = turned ? { ...outer, turned } : outer;
  if (!own || cx === undefined || cy === undefined || !cw || !ch) return parent;
  const scaleX = own.w / cw;
  const scaleY = own.h / ch;
  return {
    scaleX: parent.scaleX * scaleX,
    scaleY: parent.scaleY * scaleY,
    moveX: parent.moveX + parent.scaleX * (own.x - cx * scaleX),
    moveY: parent.moveY + parent.scaleY * (own.y - cy * scaleY),
    turned: parent.turned,
  };
}

const place = (box: Box, at: Transform): Box => ({
  x: Math.round(box.x * at.scaleX + at.moveX),
  y: Math.round(box.y * at.scaleY + at.moveY),
  w: Math.round(box.w * at.scaleX),
  h: Math.round(box.h * at.scaleY),
});

/** The non-visual properties element of a shape, whatever its kind: `nvSpPr`, `nvPicPr`, `nvGraphicFramePr`. */
const nonVisual = (node: XmlNode): XmlNode | undefined =>
  node.children.find((candidate) => /^nv[A-Za-z]*Pr$/.test(candidate.name));

function readShape(node: XmlNode, at: Transform): Shape {
  const properties = nonVisual(node);
  const cNvPr = child(properties, "cNvPr");
  const ph = descend(properties, "nvPr", "ph");
  const xfrm =
    node.name === "graphicFrame"
      ? child(node, "xfrm")
      : node.name === "grpSp"
        ? descend(node, "grpSpPr", "xfrm")
        : descend(node, "spPr", "xfrm");
  const { box, turned: own } = readXfrm(xfrm);
  const turned = own || at.turned;
  const idx = ph?.attrs.idx;
  return {
    kind: ph ? "placeholder" : node.name === "pic" ? "picture" : "other",
    node,
    name: cNvPr?.attrs.name ?? "",
    descr: cNvPr?.attrs.descr?.trim() ?? "",
    ...(ph ? { placeholder: { type: ph.attrs.type ?? "obj", ...(idx === undefined ? {} : { idx }) } } : {}),
    ...(box ? { box: place(box, at) } : {}),
    turned,
  };
}

const SHAPE_NAMES = ["sp", "pic", "cxnSp", "graphicFrame"];

/** Every shape of a shape tree, groups opened, in drawing order (the first is at the back). */
export function shapesOf(tree: XmlNode | undefined, at: Transform = IDENTITY): Shape[] {
  const shapes: Shape[] = [];
  for (const node of tree?.children ?? []) {
    if (node.name === "grpSp") shapes.push(...shapesOf(node, groupTransform(node, at)));
    else if (SHAPE_NAMES.includes(node.name)) shapes.push(readShape(node, at));
  }
  return shapes;
}

/** The text of a placeholder's first non-empty paragraph, runs only (a slide number field is not text). */
export function promptOf(shape: Shape): string | undefined {
  const body = child(shape.node, "txBody");
  for (const paragraph of body?.children ?? []) {
    if (paragraph.name !== "p") continue;
    const text = paragraph.children
      .filter((run) => run.name === "r")
      .map((run) => child(run, "t")?.text ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  }
  return undefined;
}

/** True when a paragraph of the shape holds a field of this type, such as `slidenum`. */
export function hasField(shape: Shape, type: string): boolean {
  const body = child(shape.node, "txBody");
  return (body?.children ?? []).some((paragraph) =>
    paragraph.children.some((run) => run.name === "fld" && run.attrs.type === type),
  );
}

/** The vertical anchor of the shape's text body: `t`, `ctr`, `b` and the rest, when the shape sets one. */
export const anchorOf = (shape: Shape): string | undefined =>
  descend(shape.node, "txBody", "bodyPr")?.attrs.anchor;

/** The direction the shape's text runs: `horz`, or `vert`, `vert270`, `eaVert` and the rest, when the shape sets one. */
export const directionOf = (shape: Shape): string | undefined =>
  descend(shape.node, "txBody", "bodyPr")?.attrs.vert;
