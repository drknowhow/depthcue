import {
  BACKGROUND_COLORS,
  type Block,
  FRAME_MIN,
  type Frame,
  type Op,
  type Scene,
  type Session,
} from "@depthcue/core";
import { h } from "@depthcue/player";
import type { Canvas } from "./canvas.ts";
import { removeBlock } from "./cleanup.ts";
import {
  actionButton,
  checkField,
  fileButton,
  numberField,
  problemOf,
  selectField,
  textField,
} from "./fields.ts";
import { assetOptions, form, type PanelHost } from "./panels.ts";
import { fitted } from "./pin.ts";
import { IMAGE_ACCEPT, IMAGE_FILE, type PictureAction, placeholderAlt } from "./templates.ts";
import type { ToolbarHooks } from "./toolbar.ts";

/**
 * The picture tools, a part of the editor fetched the first time one is used: crop mode with its handles and focus
 * point, Fit and Fill, Reset, fitting a box to its picture, moving a picture to the slide's background, and the
 * Background section of the Scene popover. All of it goes through `block.set`, `block.frame` and `scene.set`.
 */
type Image = Extract<Block, { type: "image" }>;
type Background = NonNullable<Scene["background"]>;
type Point = { x: number; y: number };

export type Handle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const NAMES: Record<Handle, string> = {
  n: "Top edge",
  ne: "Top-right corner",
  e: "Right edge",
  se: "Bottom-right corner",
  s: "Bottom edge",
  sw: "Bottom-left corner",
  w: "Left edge",
  nw: "Top-left corner",
};

/** The whole file, which is what a picture shows with no crop. */
export const FULL: Frame = { x: 0, y: 0, w: 100, h: 100 };

/** A background starts under this much of its color, as a template's picture does. */
const SCRIM = 40;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const cents = (value: number) => Math.round(value * 100) / 100;

/**
 * A crop with the edges of `handle` moved by `dx` and `dy`, in percent of the file. It stays inside the file and no
 * edge comes within `FRAME_MIN` of the one across from it, so the core's `image-crop-outside` never has cause to fire.
 */
export function resizeCrop(crop: Frame, handle: Handle, dx: number, dy: number): Frame {
  let left = crop.x;
  let right = crop.x + crop.w;
  let top = crop.y;
  let bottom = crop.y + crop.h;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - FRAME_MIN);
  if (handle.includes("e")) right = clamp(right + dx, left + FRAME_MIN, 100);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - FRAME_MIN);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + FRAME_MIN, 100);
  // Rounded as edges, so the right edge of the crop is exactly where it was said to be and never past the file.
  [left, right, top, bottom] = [cents(left), cents(right), cents(top), cents(bottom)];
  return { x: left, y: top, w: cents(right - left), h: cents(bottom - top) };
}

/** The same crop moved by `dx` and `dy` percent of the file, without leaving it. */
export function panCrop(crop: Frame, dx: number, dy: number): Frame {
  const [w, h] = [cents(crop.w), cents(crop.h)];
  return {
    x: cents(clamp(crop.x + dx, 0, 100 - w)),
    y: cents(clamp(crop.y + dy, 0, 100 - h)),
    w,
    h,
  };
}

/**
 * The frame whose proportions are the picture's as cropped: the width stays and the height changes, and when that runs
 * off the slide, the height is cut to the room there is and the width follows. A frame is in percent of the slide.
 */
export function fitBox(frame: Frame, natural: { w: number; h: number }, crop: Frame): Frame {
  const shape = (natural.w * crop.w) / (natural.h * crop.h);
  const tall = (width: number) => (width * 16) / (9 * shape);
  const h = tall(frame.w);
  if (frame.y + h <= 100) return fitted({ ...frame, h });
  const room = 100 - frame.y;
  return fitted({ ...frame, w: (room * 9 * shape) / 16, h: room });
}

/** Where the picture is drawn on the slide, in pixels, and which part of the file that is. */
function lookAt(node: HTMLElement, block: Image) {
  const img = node.querySelector("img");
  if (!img?.naturalWidth) return undefined;
  const cover = block.fit ? block.fit === "cover" : Boolean(node.closest("[data-role=picture]"));
  const box = node.querySelector(".dc-crop");
  const inner = box?.firstElementChild;
  if (box && inner) {
    const a = box.getBoundingClientRect();
    const b = inner.getBoundingClientRect();
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const r = {
      left,
      top,
      width: Math.min(a.right, b.right) - left,
      height: Math.min(a.bottom, b.bottom) - top,
    };
    return { img, cover, r, crop: block.crop ?? FULL };
  }
  const b = img.getBoundingClientRect();
  const { naturalWidth: nw, naturalHeight: nh } = img;
  if (getComputedStyle(img).objectFit === "cover") {
    // A picture in a slot is cut to its box around the middle.
    const wide = nw / nh > b.width / b.height;
    const w = wide ? ((b.width / b.height) * nh * 100) / nw : 100;
    const ch = wide ? 100 : ((b.height / b.width) * nw * 100) / nh;
    return { img, cover, r: b, crop: { x: (100 - w) / 2, y: (100 - ch) / 2, w, h: ch } };
  }
  const scale = Math.min(b.width / nw, b.height / nh);
  const width = nw * scale;
  const height = nh * scale;
  const r = { left: b.left + (b.width - width) / 2, top: b.top + (b.height - height) / 2, width, height };
  return { img, cover, r, crop: FULL };
}

export interface PictureHost {
  session: Session;
  /** The slide: its element, which crop mode is drawn over, and where each block is drawn. */
  canvas: Pick<Canvas, "element" | "nodeOf">;
  /** How the toolbar changes the deck, says what was refused, and gives the keyboard back to a block. */
  hooks: Pick<ToolbarHooks, "edits" | "problem" | "focusBlock">;
  /** The scene on show. */
  scene: string;
}

interface Crop {
  host: PictureHost;
  id: string;
  layer: HTMLElement;
  win: HTMLElement;
  file: HTMLElement;
  mark: HTMLElement | undefined;
  /** The file's box on the stage, in fractions of the stage. */
  f: { l: number; t: number; w: number; h: number };
  crop: Frame;
  was: Frame;
  focus: Point;
  wasFocus: Point;
  off(): void;
}

let active: Crop | undefined;

/** Applies the changes as one undo step, and says why when they are refused. */
function act(host: PictureHost, ops: readonly Op[]) {
  const result = host.hooks.edits.act(ops);
  host.hooks.problem(result.ok ? undefined : problemOf(result));
}

const say = (stage: HTMLElement, text: string) => {
  let line = stage.querySelector(".ed-crop-say");
  if (!line) {
    line = h("p", { class: "ed-sr-only ed-crop-say", role: "status", "aria-live": "polite" });
    stage.append(line);
  }
  line.textContent = text;
};

const pct = (value: number) => `${value * 100}%`;

function draw(c: Crop) {
  const { f, crop } = c;
  Object.assign(c.file.style, { left: pct(f.l), top: pct(f.t), width: pct(f.w), height: pct(f.h) });
  Object.assign(c.win.style, {
    left: pct(f.l + (f.w * crop.x) / 100),
    top: pct(f.t + (f.h * crop.y) / 100),
    width: pct((f.w * crop.w) / 100),
    height: pct((f.h * crop.h) / 100),
  });
  if (c.mark) Object.assign(c.mark.style, { left: `${c.focus.x}%`, top: `${c.focus.y}%` });
}

/** Ends crop mode. Committed, the crop and the focus go to the block in one `block.set`, so one undo step. */
function finish(commit: boolean, keyboard = false) {
  const c = active;
  if (!c) return;
  active = undefined;
  c.off();
  c.layer.remove();
  const { crop, focus } = c;
  const block = c.host.session.doc.scenes[c.host.scene]?.blocks.find((b) => b.id === c.id);
  const set: Record<string, unknown> = {};
  const whole = crop.x === 0 && crop.y === 0 && crop.w === 100 && crop.h === 100;
  if (crop.x !== c.was.x || crop.y !== c.was.y || crop.w !== c.was.w || crop.h !== c.was.h)
    set.crop = whole ? null : crop;
  if (c.mark && (focus.x !== c.wasFocus.x || focus.y !== c.wasFocus.y)) set.focus = focus;
  if (commit && block?.type === "image" && Object.keys(set).length > 0) {
    act(c.host, [{ op: "block.set", scene: c.host.scene, id: c.id, set }]);
  }
  say(c.host.canvas.element, commit ? "Crop applied." : "Crop canceled.");
  if (keyboard) c.host.hooks.focusBlock(c.id);
}

/** Stops crop mode without applying it, such as when another block is chosen. */
export const end = () => finish(false);

function start(host: PictureHost, block: Image) {
  const node = host.canvas.nodeOf(block.id);
  const look = node && lookAt(node, block);
  if (!look) {
    host.hooks.problem("The picture is not drawn yet, so there is nothing to crop. Try again in a moment.");
    return;
  }
  const stage = host.canvas.element;
  const s = stage.getBoundingClientRect();
  const { r, crop } = look;
  const wide = (r.width * 100) / crop.w;
  const high = (r.height * 100) / crop.h;
  const f = {
    l: (r.left - s.left - (wide * crop.x) / 100) / s.width,
    t: (r.top - s.top - (high * crop.y) / 100) / s.height,
    w: wide / s.width,
    h: high / s.height,
  };
  const file = h("img", { class: "ed-crop-file", src: look.img.currentSrc || look.img.src, alt: "" });
  const handles = (Object.keys(NAMES) as Handle[]).map((name) =>
    h("button", {
      type: "button",
      class: "ed-crop-h",
      "data-h": name,
      "aria-label": `${NAMES[name]} of the crop`,
    }),
  );
  const focus = { x: block.focus?.x ?? 50, y: block.focus?.y ?? 50 };
  const mark = look.cover
    ? h("button", { type: "button", class: "ed-crop-focus", "data-h": "focus", "aria-label": "Focus point" })
    : undefined;
  const win = h(
    "div",
    {
      class: "ed-crop-win",
      tabindex: "0",
      "data-h": "pan",
      "aria-label": "The picture inside the crop. Arrow keys move it.",
    },
    ...handles,
    mark,
  );
  const layer = h("div", { class: "ed-crop", role: "group", "aria-label": "Crop the picture" }, file, win);
  const c: Crop = {
    host,
    id: block.id,
    layer,
    win,
    file,
    mark,
    f,
    crop,
    was: crop,
    focus,
    wasFocus: focus,
    off: () => {},
  };

  /** Moves what `part` is: a handle resizes the crop, the window moves the picture under it, the mark moves the focus. */
  function change(part: string, dx: number, dy: number, from: Pick<Crop, "crop" | "f" | "focus">) {
    // dx and dy are fractions of the file, or of the crop window for the focus point.
    if (part === "focus") {
      c.focus = {
        x: cents(clamp(from.focus.x + dx * 100, 0, 100)),
        y: cents(clamp(from.focus.y + dy * 100, 0, 100)),
      };
    } else if (part === "pan") {
      c.crop = panCrop(from.crop, -dx * 100, -dy * 100);
      // The window stays where it is on the slide, and the file moves under it.
      c.f = {
        ...from.f,
        l: from.f.l + (from.f.w * (from.crop.x - c.crop.x)) / 100,
        t: from.f.t + (from.f.h * (from.crop.y - c.crop.y)) / 100,
      };
    } else c.crop = resizeCrop(from.crop, part as Handle, dx * 100, dy * 100);
    draw(c);
    const k = c.crop;
    say(stage, `Crop ${k.w} by ${k.h} percent, from ${k.x} across and ${k.y} down.`);
  }

  const press = (event: PointerEvent) => {
    const part = (event.target as Element).closest<HTMLElement>("[data-h]")?.dataset.h;
    if (!part || event.button !== 0) return;
    event.preventDefault();
    (event.target as HTMLElement).focus({ preventScroll: true });
    const from = { crop: c.crop, f: c.f, focus: c.focus };
    const box = stage.getBoundingClientRect();
    // A fraction of the file, or of the crop window for the focus point.
    const size =
      part === "focus"
        ? win.getBoundingClientRect()
        : { width: box.width * c.f.w, height: box.height * c.f.h };
    const move = (e: PointerEvent) =>
      change(part, (e.clientX - event.clientX) / size.width, (e.clientY - event.clientY) / size.height, from);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  layer.addEventListener("pointerdown", press);

  const away = (event: PointerEvent) => {
    const target = event.target as Element;
    // The toolbar belongs to the block, and a press on the window or a handle is the gesture itself.
    if (!win.contains(target) && !target.closest(".ed-toolbar")) finish(true);
  };
  const key = (event: KeyboardEvent) => {
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      stop();
      return finish(false, true);
    }
    const target = event.target as Element;
    if (!layer.contains(target)) return;
    if (event.key === "Enter") {
      stop();
      return finish(true, true);
    }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!arrow) return;
    stop();
    const part = target.closest<HTMLElement>("[data-h]")?.dataset.h ?? "pan";
    const step = event.shiftKey ? 10 : 1;
    // A step is a percent of the file, or of the window for the focus point.
    change(part, (arrow[0] as number) * step * 0.01, (arrow[1] as number) * step * 0.01, c);
  };
  const unsubscribe = host.session.subscribe(() => finish(false));
  window.addEventListener("pointerdown", away, true);
  window.addEventListener("keydown", key, true);
  c.off = () => {
    unsubscribe();
    window.removeEventListener("pointerdown", away, true);
    window.removeEventListener("keydown", key, true);
  };

  active = c;
  stage.append(layer);
  draw(c);
  win.focus({ preventScroll: true });
  say(
    stage,
    "Crop mode. Tab moves between the handles, arrow keys move one, Shift for larger steps. Enter applies, Escape cancels.",
  );
}

/** Does a picture command to the image `id` of the scene on show, or removes the slide's background. */
export function run(host: PictureHost, action: PictureAction, id: string): void {
  const scene = host.session.doc.scenes[host.scene];
  if (!scene) return;
  if (action === "nobg") {
    act(host, [{ op: "scene.set", id: scene.id, set: { background: null } }]);
    return;
  }
  const block = scene.blocks.find((candidate) => candidate.id === id);
  if (block?.type !== "image") return;
  const node = host.canvas.nodeOf(id);
  const set = (changes: Record<string, unknown>) =>
    act(host, [{ op: "block.set", scene: scene.id, id, set: changes }]);
  if (action === "crop") {
    if (active?.id === id) finish(true);
    else {
      end();
      start(host, block);
    }
  } else if (action === "fit" || action === "fill") {
    // What a picture does when it names no fit is not written down again.
    const base = node?.closest("[data-role=picture]") ? "fill" : "fit";
    set({ fit: action === base ? null : action === "fit" ? "contain" : "cover" });
  } else if (action === "reset") {
    set(
      Object.fromEntries(
        (["fit", "crop", "focus"] as const).filter((key) => block[key]).map((key) => [key, null]),
      ),
    );
  } else if (action === "fitbox") {
    const img = node?.querySelector("img");
    if (!block.frame || !img?.naturalWidth) {
      host.hooks.problem("Pin the picture and wait for it to be drawn, then fit its box.");
      return;
    }
    act(host, [
      {
        op: "block.frame",
        scene: scene.id,
        id,
        frame: fitBox(block.frame, { w: img.naturalWidth, h: img.naturalHeight }, block.crop ?? FULL),
      },
    ]);
  } else if (action === "bg") {
    const background: Background = {
      asset: block.asset,
      scrim: SCRIM,
      ...(block.decorative && { decorative: true as const }),
      ...(block.alt && { alt: block.alt }),
      ...(block.focus && { focus: block.focus }),
    };
    act(host, [{ op: "scene.set", id: scene.id, set: { background } }, ...removeBlock(scene, id)]);
  }
}

const COLOR_LABEL: Record<(typeof BACKGROUND_COLORS)[number], string> = {
  bg: "Background",
  surface: "Surface",
  text: "Text",
  action: "Action",
  evidence: "Evidence",
};

/** The Scene popover's Background section: the file, the scrim over it, its color and focus, and its alt text. */
export function backgroundSection(host: PanelHost, current: () => string) {
  const scene = () => host.scene(current());
  /** The scene's background as it is now, which a field's change starts from: what it was drawn with may be older. */
  const live = () => scene()?.background;
  const write = (background: Background | null): Op => ({
    op: "scene.set",
    id: current(),
    set: { background },
  });
  /** A change to the background as it is now, which has one by the time any of these fields can be used. */
  const change = (edit: (bg: Background) => Background | string): Op | string => {
    const bg = live();
    if (!bg) return "There is no background to change.";
    const next = edit(bg);
    return typeof next === "string" ? next : write(next);
  };
  const choose = (asset: string): Op => {
    const bg = live();
    return write(bg ? { ...bg, asset } : { asset, scrim: SCRIM, decorative: true });
  };
  const panel = form(
    () => scene() !== undefined,
    () => {
      const bg = live();
      const point = (axis: "x" | "y") =>
        numberField(host.edits, {
          key: `bg:focus-${axis}`,
          label: `Focus ${axis === "x" ? "across" : "down"}, percent`,
          read: () => live()?.focus?.[axis] ?? 50,
          commit: (value) =>
            change((now) => ({ ...now, focus: { x: 50, y: 50, ...now.focus, [axis]: value } })) as Op,
        });
      return [
        selectField(host.edits, {
          key: "bg:asset",
          label: "Image file",
          empty: "No background",
          options: assetOptions(host, IMAGE_FILE),
          read: () => live()?.asset ?? "",
          commit: (value) => (value === "" ? write(null) : choose(value)),
        }),
        actionButton("Choose from library", () => host.library?.((asset) => void host.run([choose(asset)])), {
          "data-field": "bg:library",
        }),
        fileButton("Upload a new image", IMAGE_ACCEPT, "bg:upload", (file) =>
          host.upload(file).then(
            (asset) => host.run([choose(asset)]),
            (error: Error) => host.problem(error.message),
          ),
        ),
        ...(bg
          ? [
              numberField(host.edits, {
                key: "bg:scrim",
                label: "Scrim, percent",
                read: () => live()?.scrim ?? SCRIM,
                commit: (value) => change((now) => ({ ...now, scrim: value })) as Op,
              }),
              selectField(host.edits, {
                key: "bg:color",
                label: "Scrim color",
                options: BACKGROUND_COLORS.map((value) => ({ value, label: COLOR_LABEL[value] })),
                read: () => live()?.color ?? "bg",
                commit: (value) =>
                  change(({ color: _color, ...rest }) =>
                    value === "bg" ? rest : { ...rest, color: value as NonNullable<Background["color"]> },
                  ) as Op,
              }),
              point("x"),
              point("y"),
              checkField(host.edits, {
                key: "bg",
                label: "Decorative",
                items: [{ id: "decorative", label: "No alt text needed" }],
                read: () => (live()?.decorative ? ["decorative"] : []),
                commit(ids) {
                  if (ids.length === 0) panel.focusNext("bg:alt");
                  return change(({ decorative: _decorative, ...rest }) =>
                    // Without the mark the schema wants alt text, so it starts as the file's name, to be written over.
                    ids.length > 0
                      ? { ...rest, decorative: true }
                      : { ...rest, alt: rest.alt ?? placeholderAlt(rest.asset) },
                  ) as Op;
                },
              }),
              ...(bg.decorative
                ? []
                : [
                    textField(host.edits, {
                      key: "bg:alt",
                      label: "Alt text",
                      hint: "What the picture shows, for people who cannot see it.",
                      read: () => live()?.alt ?? "",
                      commit: (value) =>
                        value === ""
                          ? "Write what the picture shows."
                          : change((now) => ({ ...now, alt: value })),
                    }),
                  ]),
              actionButton("Remove background", () => void host.run([write(null)]), {
                class: "ed-danger",
                "data-field": "bg:remove",
              }),
            ]
          : []),
      ];
    },
  );
  return { body: panel.body, fill: panel.fill };
}
