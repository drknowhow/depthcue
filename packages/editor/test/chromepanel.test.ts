// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createSession, type Doc, loadDoc, type Op } from "@depthcue/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { BrandContext } from "../src/brandbits.ts";
import { chromeSection } from "../src/brandpanel.ts";
import type { Edits } from "../src/fields.ts";

/* The header and footer in the Brand panel: three zones for each, the fields to put in them, and what slide 1 shows. */

const root = resolve(import.meta.dirname, "../../../fixtures/decks/v0-4-brand");

function harbor(): Doc {
  const text: Record<string, string> = {};
  const brandFiles: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      const path = relative(root, full).split(sep).join("/");
      if (statSync(full).isDirectory()) walk(full);
      else if (path.endsWith(".json")) text[path] = readFileSync(full, "utf8");
      else brandFiles.push(path);
    }
  };
  walk(root);
  const { doc } = loadDoc({ text, assets: [], brandFiles });
  if (!doc) throw new Error("the Harbor fixture should load");
  return doc;
}

let session: ReturnType<typeof createSession>;
let section: HTMLElement;

const draw = () => {
  const edits: Edits = { type: (ops) => session.apply(ops), act: (ops) => session.apply(ops) };
  const ctx = {
    session,
    edits,
    brand: () => session.doc.brand,
    run: (ops: Op[]) => session.apply(ops).ok,
    show: () => undefined,
    redraw: () => undefined,
    say: () => undefined,
    state: {},
  } as unknown as BrandContext;
  section = document.createElement("div");
  section.append(...chromeSection(ctx));
  document.body.replaceChildren(section);
};
const field = (key: string) =>
  section.querySelector<HTMLInputElement>(`[data-field='${key}']`) as HTMLInputElement;
const type = (key: string, value: string) => {
  const input = field(key);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const bands = () => session.doc.brand?.chrome?.bands;

beforeEach(() => {
  session = createSession(harbor());
  draw();
});

describe("the header and footer zones", () => {
  it("show the old footer line and slide number as zones", () => {
    expect(field("brand:chrome:footer-start").value).toBe("Harbor Analytics, for internal use");
    expect(field("brand:chrome:footer-end").value).toBe("{number}");
    expect(field("brand:chrome:header-start").value).toBe("");
  });

  it("turn the old footer and number into zones by the first change, and keep what they said", () => {
    type("brand:chrome:header-center", "{deck}");
    const chrome = session.doc.brand?.chrome;
    expect(chrome?.footer).toBeUndefined();
    expect(chrome?.number).toBeUndefined();
    expect(chrome?.bands).toEqual({
      header: { center: "{deck}" },
      footer: { start: "Harbor Analytics, for internal use", end: "{number}" },
    });
    expect(chrome?.logo).toBeDefined();
  });

  it("empty a zone with an empty field, and drop the band and then the bands when nothing is left", () => {
    type("brand:chrome:header-start", "{deck}");
    type("brand:chrome:header-start", "");
    expect(bands()?.header).toBeUndefined();
    type("brand:chrome:footer-start", "");
    type("brand:chrome:footer-end", "");
    expect(bands()).toBeUndefined();
  });

  it("put a field at the cursor of the zone last used, as if it were typed", () => {
    const input = field("brand:chrome:footer-center");
    input.value = "Page  of";
    input.focus();
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    input.setSelectionRange(5, 5);
    (section.querySelector("[data-field='brand:chrome:footer-field-number']") as HTMLButtonElement).click();
    expect(input.value).toBe("Page {number} of");
    expect(bands()?.footer?.center).toBe("Page {number} of");
  });

  it("say what the first slide shows in each band", () => {
    type("brand:chrome:header-start", "{deck}");
    draw();
    const said = section.querySelector("[data-brand='chrome-preview']")?.textContent ?? "";
    expect(said).toContain("in the header:");
    expect(said).toContain(`Slide 2 shows, in the header: ${session.doc.deck.title}.`);
    expect(said).toContain("In the footer: Harbor Analytics, for internal use  ·  2.");
  });

  it("refuse a field that is not one, and leave the brand as it was", () => {
    const before = session.doc.brand?.chrome;
    type("brand:chrome:header-start", "{chapter}");
    expect(session.doc.brand?.chrome).toEqual(before);
  });
});
