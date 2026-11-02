/**
 * The Brand panel: a deck's brand, defined in the editor. It sits over the right of the stage, so the slide stays in view
 * and shows each change at once. A deck with no brand is offered one; a deck with one gets a section for each part of
 * it: logos, colors, fonts, chrome, styles and templates. Each control writes an operation `depthcue apply` takes, as one
 * step of Undo, and a change the brand's checks refuse is said where it was made and never written.
 */
import {
  type Brand,
  type Doc,
  FONT_PAIRS,
  lookOf,
  type Op,
  PALETTE_COLORS,
  PRESETS,
  templatesOf,
} from "@depthcue/core";
import { applyLook, h } from "@depthcue/player";
import {
  type BrandContext,
  type BrandHost,
  choices,
  hint,
  listed,
  part,
  TABS,
  type Tab,
  THEME_NAME,
  THEMES,
  type Theme,
  toggle,
  without,
} from "./brandbits.ts";
import { ACCEPT, filesPart, fontFilePart, sendFile } from "./brandfiles.ts";
import { stylesSection, templatesSection } from "./brandkit.ts";
import {
  actionButton,
  choiceField,
  colorField,
  type Edits,
  fileButton,
  problemOf,
  selectField,
  textField,
} from "./fields.ts";
import { COLOR_LABEL, FONT_LABEL } from "./panels.ts";

type Palette = NonNullable<NonNullable<Brand["colors"]>[Theme]>;
type Chrome = NonNullable<Brand["chrome"]>;
type Faces = Exclude<NonNullable<Brand["fonts"]>, string>;
type Face = Faces["display"];
type FaceRole = "display" | "body" | "mono";

let uid = 0;

// Start a brand

/** An id for a brand from its name: lowercase letters, digits and hyphens, starting with a letter. */
export function brandId(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const id = /^[a-z]/.test(cleaned) ? cleaned : `brand-${cleaned}`.replace(/-$/, "");
  return id.length >= 2 ? id : "brand";
}

function startSection(ctx: BrandContext): Node[] {
  const { state } = ctx;
  const name = h("input", { type: "text", "data-field": "brand:start:name", maxlength: 80 });
  const id = h("input", { type: "text", "data-field": "brand:start:id", maxlength: 64, spellcheck: false });
  name.value = state.name ?? "";
  id.value = state.id ?? brandId(name.value);
  name.addEventListener("input", () => {
    state.name = name.value;
    // The id follows the name until the person writes one of their own.
    if (state.id === undefined) id.value = brandId(name.value);
  });
  id.addEventListener("input", () => {
    state.id = id.value;
  });
  const start = actionButton(
    "Start a brand",
    () => {
      if (ctx.run([{ op: "brand.set", set: { id: id.value.trim(), name: name.value.trim() } }])) {
        state.name = undefined;
        state.id = undefined;
      }
    },
    { class: "ed-primary", "data-field": "brand:start" },
  );
  return [
    hint(
      "This deck has no brand. A brand holds the colors, fonts, logos and chrome every slide shares, and the styles and templates its scenes use. It is kept in the deck's brand folder.",
    ),
    h("div", { class: "ed-field" }, h("label", {}, h("span", { class: "ed-label" }, "Name"), name)),
    h(
      "div",
      { class: "ed-field" },
      h("label", {}, h("span", { class: "ed-label" }, "Id"), id),
      hint("Lowercase letters, digits and hyphens. It never changes."),
    ),
    start,
  ];
}

// Colors

const paletteOf = (brand: Brand, theme: Theme): Palette => brand.colors?.[theme] ?? {};

/** The colors of a preset as the brand draws them: the preset's, with the brand's on top. */
export function brandColors(brand: Brand, theme: Theme): Record<string, string> {
  const { chart: _chart, ...own } = paletteOf(brand, theme);
  return { ...PRESETS[theme], ...own };
}

/** The operation that writes a preset's palette, taking out what is left empty. */
function setPalette(brand: Brand, theme: Theme, next: Palette): Op {
  const colors: NonNullable<Brand["colors"]> = { ...brand.colors };
  if (Object.keys(next).length > 0) colors[theme] = next;
  else delete colors[theme];
  return { op: "brand.set", set: { colors: Object.keys(colors).length > 0 ? colors : null } };
}

/** Takes a color field's line of refusal out from under its swatch, to show it the width of the row. */
function lineOf(field: HTMLElement): HTMLElement | undefined {
  const line = field.querySelector<HTMLElement>(".ed-problem");
  line?.remove();
  return line ?? undefined;
}

function colorsSection(ctx: BrandContext): Node[] {
  const brand = () => ctx.brand();
  const doc = ctx.session.doc;
  const rows = PALETTE_COLORS.map((color) => {
    const fields = THEMES.map((theme) =>
      colorField(ctx.edits, {
        key: `brand:colors:${theme}:${color}`,
        label: `${COLOR_LABEL[color]}, ${THEME_NAME[theme]}`,
        read: () => brandColors(brand(), theme)[color] as string,
        commit: (value) => setPalette(brand(), theme, { ...paletteOf(brand(), theme), [color]: value }),
        changed: () => Object.hasOwn(paletteOf(brand(), theme), color),
        reset: () => setPalette(brand(), theme, without(paletteOf(brand(), theme), color)),
      }),
    );
    const lines = fields.map(lineOf);
    return h(
      "div",
      { class: "ed-brand-color", role: "group", "aria-label": COLOR_LABEL[color] },
      h("span", { class: "ed-brand-color-name", "aria-hidden": "true" }, COLOR_LABEL[color]),
      ...fields,
      h("div", { class: "ed-brand-lines" }, ...lines),
    );
  });
  const own = !brand().lock && doc.deck.palette !== undefined;
  return [
    part(
      "Colors",
      hint(
        "The brand's colors on paper and on ink slides. A color that would leave text hard to read is refused at its swatch, with the two colors and the contrast they reach, and nothing is written.",
      ),
      own &&
        hint("This deck sets colors of its own in Deck style, which show over the brand's on its slides."),
      h(
        "div",
        { class: "ed-brand-colors" },
        h(
          "div",
          { class: "ed-brand-color ed-brand-color-head", "aria-hidden": "true" },
          ...THEMES.map((theme) => h("span", { class: "ed-label" }, THEME_NAME[theme])),
        ),
        ...rows,
      ),
    ),
    part(
      "Chart colors",
      hint(
        "The colors of a chart's series, in order, for each preset. Each must reach 3:1 on that preset's background.",
      ),
      ...THEMES.map((theme) => chartColors(ctx, theme)),
    ),
    toggle(
      ctx,
      "brand:lock",
      "Keep every deck on the brand's colors and fonts",
      brand().lock === true,
      (on) => ({ op: "brand.set", set: { lock: on ? true : null } }),
    ),
  ];
}

/** The most chart colors a preset may have. */
const CHART_MAX = 6;

function chartColors(ctx: BrandContext, theme: Theme): HTMLElement {
  const brand = () => ctx.brand();
  const chart = () => paletteOf(brand(), theme).chart;
  const write = (next: string[] | undefined): Op => {
    const own = without(paletteOf(brand(), theme), "chart");
    return setPalette(brand(), theme, next && next.length > 0 ? { ...own, chart: next } : own);
  };
  const list = chart() ?? [];
  const lines: Array<HTMLElement | undefined> = [];
  const fields = list.map((color, i) => {
    const label = `Chart color ${i + 1}, ${THEME_NAME[theme]}`;
    const field = colorField(ctx.edits, {
      key: `brand:chart:${theme}:${i}`,
      label,
      read: () => chart()?.[i] ?? color,
      commit: (value) => write((chart() ?? []).map((was, at) => (at === i ? value : was))),
      changed: () => true,
      reset: () => write((chart() ?? []).filter((_, at) => at !== i)),
    });
    // The field's reset takes the color out of the list.
    const remove = field.querySelector<HTMLElement>(".ed-color-reset");
    if (remove) {
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${label}`);
    }
    lines.push(lineOf(field));
    return field;
  });
  const colors = brandColors(brand(), theme);
  const next =
    ["action", "evidence", "text", "muted"]
      .map((name) => colors[name] as string)
      .find((c) => !list.includes(c)) ?? (colors.action as string);
  return h(
    "div",
    {
      class: "ed-brand-chart",
      "data-theme": theme,
      role: "group",
      "aria-label": `Chart colors, ${THEME_NAME[theme]}`,
    },
    h("span", { class: "ed-label" }, THEME_NAME[theme]),
    list.length === 0
      ? hint("Charts take the slide's own colors.")
      : h("div", { class: "ed-brand-swatches" }, ...fields),
    h("div", { class: "ed-brand-lines" }, ...lines),
    actionButton(
      list.length === 0 ? "Give charts colors of their own" : "Add a chart color",
      () => ctx.run([write([...list, next])]),
      { "data-field": `brand:chart:${theme}:add`, disabled: list.length >= CHART_MAX },
    ),
  );
}

// Fonts

const FACE_ROLE: Record<FaceRole, string> = {
  display: "Headings (display)",
  body: "Text (body)",
  mono: "Code and labels (mono)",
};

/** The brand's own faces by family, each once, in the order the roles name them. */
function familiesOf(faces: Faces): Face[] {
  const seen = new Map<string, Face>();
  for (const role of ["display", "body", "mono"] as const) {
    const face = faces[role];
    if (face && !seen.has(face.family)) seen.set(face.family, face);
  }
  return [...seen.values()];
}

/** The faces with each role that `pick` says, and no mono when it says none. */
function facesWith(faces: Faces, pick: (role: FaceRole, face: Face | undefined) => Face | undefined): Faces {
  const display = pick("display", faces.display) as Face;
  const body = pick("body", faces.body) as Face;
  const mono = pick("mono", faces.mono);
  return { display, body, ...(mono ? { mono } : {}), fallback: faces.fallback };
}

/** The deck's faces put in the page, so a face can be shown in its own font even where the deck uses another. */
function loadFaces(doc: Doc): void {
  const { fonts: _fonts, ...deck } = doc.deck;
  applyLook(h("div"), lookOf({ ...doc, deck }), "");
}

/** A word or a name, in a face of the brand's. */
function inFace(family: string, text: string): HTMLElement {
  const node = h("span", { class: "ed-face-sample" }, text);
  node.style.fontFamily = JSON.stringify(family);
  return node;
}

function fontsSection(ctx: BrandContext): Node[] {
  const brand = () => ctx.brand();
  const doc = ctx.session.doc;
  const fonts = brand().fonts;
  const deckOwn =
    !brand().lock && doc.deck.fonts !== undefined
      ? hint("This deck chooses its own font pair in Deck style, which shows over the brand's on its slides.")
      : undefined;
  const set = (value: NonNullable<Brand["fonts"]> | null): Op => ({ op: "brand.set", set: { fonts: value } });
  const files = [fontFilePart(ctx), filesPart(ctx, "fonts")];
  if (fonts === undefined || typeof fonts === "string") {
    return [
      part(
        "Fonts",
        deckOwn,
        choiceField(ctx.edits, {
          key: "brand:fonts",
          label: "Font pair",
          choices: [
            { value: "", label: "Each deck chooses", detail: "The brand sets no fonts." },
            ...FONT_PAIRS.map((pair) => ({
              value: pair,
              label: FONT_LABEL[pair].label,
              detail: FONT_LABEL[pair].detail,
              attributes: { "data-fonts": pair },
            })),
          ],
          read: () => (typeof brand().fonts === "string" ? (brand().fonts as string) : ""),
          commit: (value) => set(value === "" ? null : (value as (typeof FONT_PAIRS)[number])),
        }),
      ),
      ...files,
    ];
  }
  loadFaces(doc);
  const faces = fonts;
  const families = familiesOf(faces);
  const options = families.map((face) => ({ value: face.family, label: face.family }));
  const named = (family: string) => families.find((face) => face.family === family);
  const roles = (["display", "body", "mono"] as const).map((role) =>
    h(
      "div",
      { class: "ed-brand-face-role", "data-role": role },
      selectField(ctx.edits, {
        key: `brand:fonts:${role}`,
        label: FACE_ROLE[role],
        options,
        ...(role === "mono" ? { empty: "The pair's own mono" } : {}),
        read: () => {
          const now = brand().fonts;
          return typeof now === "object" ? (now[role]?.family ?? "") : "";
        },
        commit: (family) =>
          set(
            facesWith(faces, (at, face) =>
              at === role ? (family === "" ? undefined : named(family)) : face,
            ),
          ),
      }),
      faces[role] && inFace(faces[role].family, "The quick brown fox"),
    ),
  );
  const list = families.map((face) =>
    h(
      "li",
      { class: "ed-brand-face", "data-family": face.family },
      inFace(face.family, face.family),
      h(
        "span",
        { class: "ed-hint-text" },
        face.files && face.files.length > 0
          ? face.files.map((file) => `${file.weight}${file.style === "italic" ? " italic" : ""}`).join(", ")
          : "Installed on the viewers' machines, not carried by the deck",
      ),
      face.files &&
        textField(ctx.edits, {
          key: `brand:fonts:license:${face.family}`,
          label: `License of ${face.family}`,
          hint: "An SPDX id such as OFL-1.1, or the license's name.",
          read: () => face.license ?? "",
          commit: (value) =>
            value.trim() === ""
              ? "A face the deck carries needs its license."
              : set(
                  facesWith(faces, (_, own) =>
                    own?.family === face.family ? { ...own, license: value } : own,
                  ),
                ),
        }),
    ),
  );
  return [
    part("Fonts", deckOwn, hint("The brand's own faces. Each is shown in its own font."), ...roles),
    part("Faces", h("ul", { class: "ed-brand-faces" }, ...list)),
    part(
      "While they load",
      selectField(ctx.edits, {
        key: "brand:fonts:fallback",
        label: "Built-in pair to fall back on",
        options: FONT_PAIRS.map((pair) => ({ value: pair, label: FONT_LABEL[pair].label })),
        read: () => faces.fallback,
        commit: (value) => set({ ...faces, fallback: value as Faces["fallback"] }),
      }),
      actionButton(
        `Use the ${FONT_LABEL[faces.fallback].label} pair instead of these faces`,
        () => ctx.run([set(faces.fallback)]),
        { "data-field": "brand:fonts:pair" },
      ),
    ),
    ...files,
  ];
}

// Chrome

type LogoCorner = NonNullable<Chrome["logo"]>["corner"];
type LogoSize = NonNullable<Chrome["logo"]>["size"];
type Place = NonNullable<Chrome["number"]>["place"];
type Accent = NonNullable<Chrome["accent"]>;

const CORNER: Record<LogoCorner, string> = {
  "top-start": "Top, start side",
  "top-end": "Top, end side",
  "bottom-start": "Bottom, start side",
  "bottom-end": "Bottom, end side",
};
const SIZE: Record<LogoSize, string> = { s: "Small", m: "Medium", l: "Large" };
const PLACE: Record<Place, string> = { start: "Start", center: "Center", end: "End" };
const ACCENT: Record<Accent, string> = {
  none: "None",
  top: "A bar along the top",
  start: "A bar down the start side",
};
function chromeSection(ctx: BrandContext): Node[] {
  const chrome = (): Chrome => ctx.brand().chrome ?? {};
  const setChrome = (patch: { [K in keyof Chrome]?: Chrome[K] | null }): Op => {
    const next: Record<string, unknown> = { ...chrome() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    return { op: "brand.set", set: { chrome: Object.keys(next).length > 0 ? (next as Chrome) : null } };
  };
  const logo = chrome().logo;
  return [
    hint("What sits on every slide. The slide shows each change as it is made."),
    part(
      "Logo",
      selectField(ctx.edits, {
        key: "brand:chrome:logo",
        label: "Corner",
        empty: "Not on the slides",
        options: choices(CORNER),
        read: () => chrome().logo?.corner ?? "",
        commit: (value) =>
          setChrome({
            logo: value === "" ? null : { corner: value as LogoCorner, size: chrome().logo?.size ?? "m" },
          }),
      }),
      logo &&
        selectField(ctx.edits, {
          key: "brand:chrome:logo-size",
          label: "Size",
          options: choices(SIZE),
          read: () => chrome().logo?.size ?? "m",
          commit: (value) => setChrome({ logo: { corner: logo.corner, size: value as LogoSize } }),
        }),
      actionButton("The logo files: Logos", () => ctx.show("logos"), {
        "data-field": "brand:chrome:to-logos",
      }),
    ),
    part(
      "Footer",
      textField(ctx.edits, {
        key: "brand:chrome:footer",
        label: "Text",
        placeholder: "No footer",
        read: () => chrome().footer?.text ?? "",
        commit: (value) =>
          setChrome({
            footer: value === "" ? null : { text: value, place: chrome().footer?.place ?? "start" },
          }),
      }),
      chrome().footer &&
        selectField(ctx.edits, {
          key: "brand:chrome:footer-place",
          label: "Place",
          options: choices(PLACE),
          read: () => chrome().footer?.place ?? "start",
          commit: (value) =>
            setChrome({ footer: { text: chrome().footer?.text ?? "", place: value as Place } }),
        }),
    ),
    part(
      "Slide number",
      selectField(ctx.edits, {
        key: "brand:chrome:number",
        label: "Place",
        empty: "No slide number",
        options: choices(PLACE),
        read: () => chrome().number?.place ?? "",
        commit: (value) => setChrome({ number: value === "" ? null : { place: value as Place } }),
      }),
    ),
    part(
      "Accent",
      selectField(ctx.edits, {
        key: "brand:chrome:accent",
        label: "Accent",
        options: choices(ACCENT),
        read: () => chrome().accent ?? "none",
        commit: (value) => setChrome({ accent: value === "none" ? null : (value as Accent) }),
      }),
    ),
  ];
}

// Logos

export interface Said {
  text: string;
  /** True for something that looks wrong on a slide and that the person should fix. */
  warn?: boolean;
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** The template backgrounds the player reverses text on, and puts a plate behind the logo on. */
const STRONG = new Set(["text", "action", "evidence"]);

/**
 * Where the brand's logos show, as the player draws them today: paper slides take the light logo and ink slides the dark
 * one, each falling back to the other when it is missing, with no plate behind it; a template with a strong background
 * puts the logo on a plate of the slide's own background, and one with no chrome shows none.
 */
export function logoStatement(doc: Doc): Said[] {
  const brand = doc.brand;
  if (!brand) return [];
  const light = brand.logos?.light;
  const dark = brand.logos?.dark;
  if (!light && !dark)
    return [{ text: "The brand has no logo yet. Add one for light slides, dark slides or both." }];
  const out: Said[] = [];
  const fallback = (theme: "light" | "dark", other: string): Said => ({
    text: `${theme === "light" ? "Paper" : "Ink"} slides show ${fileName(other)} too, as the brand has no logo for ${theme} slides. The player draws it with no plate behind it, so on a ${theme} slide it can all but vanish. Add a logo for ${theme} slides.`,
    warn: true,
  });
  out.push(
    light
      ? { text: `Paper slides show the light logo, ${fileName(light)}.` }
      : fallback("light", dark as string),
  );
  out.push(
    dark ? { text: `Ink slides show the dark logo, ${fileName(dark)}.` } : fallback("dark", light as string),
  );
  const shown = doc.deck.theme === "ink" ? (dark ?? light) : (light ?? dark);
  out.push({
    text: `This deck is on ${THEME_NAME[doc.deck.theme]}, so its slides show ${fileName(shown as string)}.`,
  });
  const templates = Object.values(templatesOf(doc));
  const plated = templates
    .filter((template) => template.chrome !== "none" && STRONG.has(template.background?.color ?? ""))
    .map((template) => template.name);
  if (plated.length > 0)
    out.push({
      text: `${listed(plated)} ${plated.length === 1 ? "has" : "have"} a strong background, so the logo sits on a plate of the slide's own background there: paper on paper slides, ink on ink slides.`,
    });
  const bare = templates.filter((template) => template.chrome === "none").map((template) => template.name);
  if (bare.length > 0) out.push({ text: `${listed(bare)} ${bare.length === 1 ? "shows" : "show"} no logo.` });
  if (!brand.chrome?.logo)
    out.push({ text: "No slide shows a logo until it has a corner under Chrome.", warn: true });
  return out;
}

function logosSection(ctx: BrandContext): Node[] {
  const brand = () => ctx.brand();
  const logos = brand().logos;
  const setLogos = (next: Partial<NonNullable<Brand["logos"]>>): Op => {
    const files = next.light || next.dark;
    return { op: "brand.set", set: { logos: files ? (next as NonNullable<Brand["logos"]>) : null } };
  };
  const statement = logoStatement(ctx.session.doc);
  const slots = (["light", "dark"] as const).map((kind) => {
    const path = logos?.[kind];
    const theme: Theme = kind === "light" ? "paper" : "ink";
    const ground = brandColors(brand(), theme).bg as string;
    return h(
      "div",
      { class: "ed-brand-logo", "data-logo": kind, role: "group", "aria-label": `Logo for ${kind} slides` },
      h("span", { class: "ed-label" }, `For ${kind} slides`),
      path
        ? h(
            "span",
            { class: "ed-brand-logo-shown", "--ground": ground },
            // Served where the canvas finds it. The path is relative to the brand folder, as brand.json has it.
            h("img", { src: `/brand/${path}`, alt: "", decoding: "async" }),
          )
        : hint("None yet."),
      path && h("code", {}, fileName(path)),
      h(
        "div",
        { class: "ed-acts" },
        // The server checks the file and names it; the brand then names it for this kind, as one step of Undo.
        fileButton(
          path ? "Another file…" : "Choose a file…",
          ACCEPT.logo,
          `brand:logos:${kind}:upload`,
          (file) =>
            void sendFile(ctx, "logo", file, (added) => {
              const now = brand().logos;
              ctx.run([setLogos({ ...now, alt: now?.alt ?? brand().name, [kind]: added.path })]);
            }),
        ),
        path &&
          actionButton("Remove", () => ctx.run([setLogos(without(logos ?? { alt: "" }, kind))]), {
            "data-field": `brand:logos:${kind}:remove`,
            "aria-label": `Take the ${kind} logo out of the brand`,
          }),
      ),
    );
  });
  return [
    part(
      "Where each logo shows",
      h(
        "ul",
        { class: "ed-brand-statement", "aria-live": "polite" },
        ...statement.map((line) => h("li", { "data-warn": line.warn === true }, line.text)),
      ),
    ),
    part("Logos", ...slots),
    logos &&
      textField(ctx.edits, {
        key: "brand:logos:alt",
        label: "What the logo says",
        hint: "Read out in place of the logo to someone who cannot see it.",
        read: () => brand().logos?.alt ?? "",
        commit: (value) =>
          value.trim() === ""
            ? "A logo needs words for someone who cannot see it."
            : setLogos({ ...logos, alt: value }),
      }),
    actionButton("Corner and size: Chrome", () => ctx.show("chrome"), {
      "data-field": "brand:logos:to-chrome",
    }),
    filesPart(ctx, "logos"),
  ].filter((node): node is HTMLElement => node instanceof HTMLElement);
}

const SECTIONS: Record<Tab, (ctx: BrandContext) => Node[]> = {
  logos: logosSection,
  colors: colorsSection,
  fonts: fontsSection,
  chrome: chromeSection,
  styles: stylesSection,
  templates: templatesSection,
};

// The panel

/** A part of the panel drawn from the deck again after each change, with the keyboard put back where it was. */
function redrawn(draw: () => Node[]) {
  const body = h("div", { class: "ed-brand-section" });
  const redraw = () => {
    const held = document.activeElement;
    const key = held instanceof HTMLElement && body.contains(held) ? held.dataset.field : undefined;
    body.replaceChildren(...draw());
    if (key !== undefined) body.querySelector<HTMLElement>(`[data-field="${CSS.escape(key)}"]`)?.focus();
  };
  return { body, redraw };
}

interface BrandPanel {
  readonly element: HTMLElement;
  show(tab?: Tab): void;
  close(): void;
}

const panels = new WeakMap<HTMLElement, BrandPanel>();

/** Opens the Brand panel, at a section when one is given, or brings the open one to it. */
export function openBrand(host: BrandHost, tab?: Tab): void {
  const open = panels.get(host.floor);
  if (open?.element.isConnected) {
    open.show(tab);
    return;
  }
  const panel = createPanel(host);
  panels.set(host.floor, panel);
  panel.show(tab);
}

/** Closes the Brand panel, when it is open, so the list of changes can have the right of the stage. */
export function closeBrand(floor: HTMLElement): void {
  panels.get(floor)?.close();
}

/** Keys that are the editor's own however the keyboard got here: Undo and Redo. */
const isHistoryKey = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) && !event.altKey && ["z", "y"].includes(event.key.toLowerCase());

function createPanel(host: BrandHost): BrandPanel {
  const { session } = host;
  // Where the keyboard goes back to when the panel closes: what opened it.
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  let typing = false;
  const edits: Edits = {
    type(ops, options) {
      typing = true;
      try {
        return session.apply(ops, options);
      } finally {
        typing = false;
      }
    },
    act: (ops, options) => session.apply(ops, options),
  };
  const said = h("p", { class: "ed-problem ed-brand-said", role: "alert", hidden: true });
  const say = (text: string | undefined, offer?: HTMLElement) => {
    said.hidden = text === undefined;
    said.replaceChildren(text ?? "", ...(offer ? [" ", offer] : []));
  };
  let tab: Tab = "colors";
  const ctx: BrandContext = {
    host,
    session,
    edits,
    run(ops) {
      const result = session.apply(ops);
      say(result.ok ? undefined : problemOf(result));
      return result.ok;
    },
    say,
    show: (to) => panel.show(to),
    redraw: () => section.redraw(),
    brand: () => session.doc.brand as Brand,
    state: {},
  };

  const titleId = `ed-brand-title-${++uid}`;
  const title = h("h2", { id: titleId }, "Brand");
  const name = h("span", { class: "ed-brand-name" });
  const close = h("button", {
    type: "button",
    "data-action": "close-brand",
    "aria-label": "Close the brand",
  });
  close.append(h("span", { class: "ed-icon ed-icon-close", "aria-hidden": "true" }));
  const tabs = (Object.keys(TABS) as Tab[]).map((id) =>
    h(
      "button",
      {
        type: "button",
        role: "tab",
        id: `ed-brand-tab-${id}`,
        "data-tab": id,
        "aria-controls": "ed-brand-body",
      },
      TABS[id],
    ),
  );
  const tablist = h(
    "div",
    { class: "ed-brand-tabs", role: "tablist", "aria-label": "Parts of the brand" },
    ...tabs,
  );
  const section = redrawn(() => {
    const brand = session.doc.brand;
    tablist.hidden = !brand;
    name.textContent = brand?.name ?? "";
    body.toggleAttribute("data-start", !brand);
    if (brand) body.setAttribute("aria-labelledby", `ed-brand-tab-${tab}`);
    else body.setAttribute("aria-label", "Start a brand");
    return brand ? SECTIONS[tab](ctx) : startSection(ctx);
  });
  const body = h("div", { class: "ed-brand-body", id: "ed-brand-body", role: "tabpanel" }, section.body);
  const element = h(
    "aside",
    { class: "ed-brand", "aria-labelledby": titleId, tabindex: "-1" },
    h("header", { class: "ed-brand-head" }, title, name, close),
    tablist,
    said,
    body,
  );

  const mark = () => {
    for (const node of tabs) {
      const on = node.dataset.tab === tab;
      node.setAttribute("aria-selected", String(on));
      node.tabIndex = on ? 0 : -1;
    }
  };
  tablist.addEventListener("click", (event) => {
    const to = (event.target as Element).closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
    if (to) panel.show(to);
  });
  // The arrow keys move between the sections, and the one with the keyboard opens.
  tablist.addEventListener("keydown", (event) => {
    const at = tabs.indexOf(event.target as HTMLButtonElement);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : step && (at + step + tabs.length) % tabs.length;
    const next = to === undefined || at < 0 ? undefined : tabs[to];
    if (!next) return;
    event.preventDefault();
    panel.show(next.dataset.tab as Tab);
    next.focus();
  });
  // Keys pressed in the panel are the panel's, so a T typed here adds no text to the slide. Undo and Redo still work.
  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      panel.close();
    }
    if (event.key === "Tab" && isDrawer()) keepTab(event);
    if (!isHistoryKey(event)) event.stopPropagation();
  });
  // In a small window the panel is a drawer over the slide (editor.css says when): Tab goes round inside it, and a press
  // outside closes it.
  const isDrawer = () => getComputedStyle(element).getPropertyValue("--ed-over").trim() === "1";
  const keepTab = (event: KeyboardEvent) => {
    const stops = [
      ...element.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"),
    ].filter((node) => node.tabIndex >= 0 && !node.matches(":disabled") && node.getClientRects().length > 0);
    const first = stops[0];
    const last = stops.at(-1);
    const at = document.activeElement;
    if (!first || !last) return;
    if (event.shiftKey ? at === first || at === element : at === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
  close.addEventListener("click", () => panel.close());

  /** Stops the press that closed the drawer from doing anything else: taking the keyboard, or a click. */
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  // A press outside the drawer only closes it, as Esc does: the slide under it is not clicked. A dialog the panel
  // opened, and the template editor, are not outside it.
  const outside = (event: PointerEvent) => {
    const at = event.target as Element;
    if (!isDrawer() || element.contains(at) || at.closest?.("dialog, .ed-tpl")) return;
    swallow(event);
    for (const type of ["mousedown", "click"]) document.addEventListener(type, swallow, true);
    document.addEventListener(
      "pointerup",
      () =>
        setTimeout(() => {
          for (const type of ["mousedown", "click"]) document.removeEventListener(type, swallow, true);
        }),
      { capture: true, once: true },
    );
    panel.close();
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "saved") return;
    if (!typing) section.redraw();
  });

  const panel: BrandPanel = {
    element,
    show(to) {
      if (to && to !== tab) {
        tab = to;
        say(undefined);
      }
      mark();
      section.redraw();
      if (!element.isConnected) {
        host.floor.append(element);
        host.floor.setAttribute("data-side", "brand");
        document.addEventListener("pointerdown", outside, true);
        element.focus({ preventScroll: true });
      }
    },
    close() {
      document.removeEventListener("pointerdown", outside, true);
      unsubscribe();
      element.remove();
      host.floor.removeAttribute("data-side");
      panels.delete(host.floor);
      if (back?.isConnected) back.focus({ preventScroll: true });
    },
  };
  mark();
  return panel;
}
