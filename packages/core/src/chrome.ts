/**
 * What a slide's header and footer say. One resolver gives the text of every zone for one slide, and the player, the
 * PowerPoint export, the thumbnails, `deck_get` and `check` all call it, so they cannot disagree about what the
 * audience reads.
 */
import { CHROME_FIELDS, CHROME_PLACES, SECTION_TEMPLATE } from "./schema.ts";
import type { Brand, Diagnostic } from "./types.ts";

type Place = (typeof CHROME_PLACES)[number];
type Field = (typeof CHROME_FIELDS)[number];
export type ChromeMode = "full" | "minimal" | "none";

/** The text of the zones of a band, by place. A zone that is not there says nothing. */
export type Zones = Partial<Record<Place, string>>;
export interface Bands {
  header: Zones;
  footer: Zones;
}

type BrandChrome = NonNullable<Brand["chrome"]>;

/** The gap between a footer line and the slide number when both sit at the same place, as the player has always drawn it. */
const GAP = "  ";

/**
 * The header and the footer of a brand's chrome as zones. A brand written before bands existed has a footer line and a
 * slide number at a place each; they read as the same zones, so an old brand draws what it drew. A zone that `bands`
 * names wins over the old parts at the same place.
 */
export function bandsOf(chrome: BrandChrome | undefined): Bands {
  const header: Zones = { ...chrome?.bands?.header };
  const footer: Zones = {};
  const old = (place: Place, text: string) => {
    footer[place] = footer[place] === undefined ? text : `${footer[place]}${GAP}${text}`;
  };
  if (chrome?.footer) old(chrome.footer.place, chrome.footer.text);
  if (chrome?.number) old(chrome.number.place, "{number}");
  for (const place of CHROME_PLACES) {
    const own = chrome?.bands?.footer?.[place];
    if (own !== undefined) footer[place] = own;
  }
  return { header, footer };
}

/** What a deck says that the header and footer read. The player builds this from the page's own data. */
export interface ChromeDeck {
  title: string;
  date?: string | undefined;
  numbering?: { start?: number | undefined; skip?: readonly string[] | undefined } | undefined;
  /** The slides in order. `chrome` is the slide's own setting. */
  slides: ReadonlyArray<{
    id: string;
    title: string;
    template?: string | undefined;
    chrome?: ChromeMode | undefined;
  }>;
  /** How much chrome each template shows, by template id. */
  templateChrome?: Readonly<Record<string, ChromeMode | undefined>> | undefined;
}

export interface SlideChrome {
  /** How much of the chrome the slide shows: the slide's own setting, else its template's, else all of it. */
  mode: ChromeMode;
  /** The number the slide shows. None when its template is one that shows no number. */
  number?: number;
  /** The section the slide is in: the title of the last slide on the section template at or before it. */
  section?: string;
  /** The text of each zone with its fields filled. Empty unless the slide shows all of the chrome. */
  header: Zones;
  footer: Zones;
}

/** The names between braces in a zone's text. */
export const fieldsIn = (text: string): string[] =>
  [...text.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1] as string);

const isField = (name: string): name is Field => (CHROME_FIELDS as readonly string[]).includes(name);

/** The text with each known field replaced. A name that is not a field stays as written, and `check` reports it. */
export function fill(text: string, values: Partial<Record<Field, string>>): string {
  return text
    .replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => (isField(name) ? (values[name] ?? "") : whole))
    .trim();
}

/** The section a slide is in: the title of the nearest slide at or before it that is on the section template. */
export function sectionOf(deck: ChromeDeck, index: number): string | undefined {
  for (let i = Math.min(index, deck.slides.length - 1); i >= 0; i--) {
    const slide = deck.slides[i];
    if (slide?.template === SECTION_TEMPLATE) return slide.title;
  }
  return undefined;
}

/** Whether a slide shows a number: unless its template is one the deck's numbering skips. */
const numbered = (deck: ChromeDeck, index: number): boolean => {
  const template = deck.slides[index]?.template;
  return template === undefined || !deck.numbering?.skip?.includes(template);
};

/** What the slide at `index` (from 0) shows in its header and footer. */
export function resolveChrome(bands: Bands, deck: ChromeDeck, index: number): SlideChrome {
  const slide = deck.slides[index];
  const template = slide?.template === undefined ? undefined : deck.templateChrome?.[slide.template];
  const mode = slide?.chrome ?? template ?? "full";
  const section = sectionOf(deck, index);
  const number = numbered(deck, index) ? (deck.numbering?.start ?? 1) + index : undefined;
  const out: SlideChrome = {
    mode,
    ...(number === undefined ? {} : { number }),
    ...(section === undefined ? {} : { section }),
    header: {},
    footer: {},
  };
  if (mode !== "full" || !slide) return out;
  const values: Partial<Record<Field, string>> = {
    ...(number === undefined ? {} : { number: String(number) }),
    count: String(deck.slides.length),
    ...(section === undefined ? {} : { section }),
    title: slide.title,
    deck: deck.title,
    ...(deck.date === undefined ? {} : { date: deck.date }),
  };
  for (const band of ["header", "footer"] as const) {
    for (const place of CHROME_PLACES) {
      const text = bands[band][place];
      if (text === undefined) continue;
      const shown = fill(text, values);
      if (shown !== "") out[band][place] = shown;
    }
  }
  return out;
}

const problem = (
  severity: Diagnostic["severity"],
  file: string,
  path: string,
  code: string,
  message: string,
  fix: string,
): Diagnostic => ({ severity, code, file, path, message, fix });

/** Every zone's text in a band, with the path of the zone in the brand file. */
function zonesOf(chrome: BrandChrome | undefined): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const band of ["header", "footer"] as const) {
    for (const place of CHROME_PLACES) {
      const text = chrome?.bands?.[band]?.[place];
      if (text !== undefined) out.push({ path: `/chrome/bands/${band}/${place}`, text });
    }
  }
  return out;
}

/** A field in braces that is not one: the zone would show it as written. */
export function checkChromeFields(chrome: BrandChrome | undefined, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const { path, text } of zonesOf(chrome)) {
    for (const name of fieldsIn(text)) {
      if (isField(name)) continue;
      out.push(
        problem(
          "error",
          file,
          path,
          "chrome-unknown-field",
          `{${name}} is not a field, so the slide would show it as written.`,
          `Use one of ${CHROME_FIELDS.map((field) => `{${field}}`).join(", ")}, or remove the braces.`,
        ),
      );
    }
  }
  return out;
}

/**
 * The facts across the deck that the header and footer depend on: a date asked for and not given, a section asked for
 * where no slide starts one, and a number asked for where every slide skips it.
 */
export function checkChromeDeck(
  chrome: BrandChrome | undefined,
  deck: Pick<ChromeDeck, "date" | "numbering" | "slides">,
  file: string,
): Diagnostic[] {
  const used = new Set<string>();
  for (const { text } of zonesOf(chrome)) for (const name of fieldsIn(text)) used.add(name);
  if (chrome?.number) used.add("number");
  const out: Diagnostic[] = [];
  if (used.has("date") && deck.date === undefined) {
    out.push(
      problem(
        "warning",
        file,
        "/date",
        "chrome-no-date",
        "The header or footer shows {date}, but the deck has no date.",
        'Set "date" in deck.json, or remove {date} from the brand.',
      ),
    );
  }
  if (used.has("section") && !deck.slides.some((slide) => slide.template === SECTION_TEMPLATE)) {
    out.push(
      problem(
        "warning",
        file,
        "/scenes",
        "chrome-no-section",
        `The header or footer shows {section}, but no slide is on the "${SECTION_TEMPLATE}" template, so it shows nothing.`,
        `Put a slide on the "${SECTION_TEMPLATE}" template at the start of each part, or remove {section}.`,
      ),
    );
  }
  const skip = deck.numbering?.skip;
  if (used.has("number") && skip && deck.slides.length > 0) {
    const shown = deck.slides.some((slide) => slide.template === undefined || !skip.includes(slide.template));
    if (!shown) {
      out.push(
        problem(
          "warning",
          file,
          "/numbering/skip",
          "chrome-no-number",
          "Every slide is on a template that skips the number, so no slide shows one.",
          'Remove a template from "numbering.skip".',
        ),
      );
    }
  }
  return out;
}
