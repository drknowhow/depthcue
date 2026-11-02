// @vitest-environment happy-dom

import { type DeckLook, PALETTE_COLORS } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPlayer, type Player } from "../src/player.ts";
import { mountPresenterView } from "../src/presenter.ts";
import { applyLook, faceCss, lookKey } from "../src/style.ts";
import { demoSource } from "./helpers.ts";
import { lookWith, COLORS as THEME_COLORS } from "./looks.ts";

const COLORS = {
  bg: "#101820",
  surface: "#182430",
  line: "#304050",
  text: "#f0f4f8",
  muted: "#b0bcc8",
  action: "#ff7755",
  evidence: "#88aaff",
};

describe("applyLook", () => {
  it("sets the theme, the font pair and every palette color the deck names, each as its own --dc property", () => {
    const element = document.createElement("div");
    applyLook(element, { theme: "ink", palette: COLORS, fonts: "classic" });
    expect(element.dataset.theme).toBe("ink");
    expect(element.dataset.fonts).toBe("classic");
    for (const color of PALETTE_COLORS) {
      expect(element.style.getPropertyValue(`--dc-${color}`), color).toBe(COLORS[color]);
    }
  });

  it("names all seven palette colors, so none is left to the preset by a list that forgot it", () => {
    expect(PALETTE_COLORS).toEqual(["bg", "surface", "line", "text", "muted", "action", "evidence"]);
    expect(Object.keys(COLORS)).toEqual([...PALETTE_COLORS]);
  });

  it("leaves a color the palette does not name to the preset, and a deck with no fonts to the default", () => {
    const element = document.createElement("div");
    applyLook(element, { theme: "paper", palette: { text: "#000000" } });
    expect(element.style.getPropertyValue("--dc-text")).toBe("#000000");
    expect(element.style.getPropertyValue("--dc-bg")).toBe("");
    expect(element.hasAttribute("data-fonts")).toBe(false);
  });

  it("takes off what an earlier look set that the new one does not", () => {
    const element = document.createElement("div");
    applyLook(element, { theme: "paper", palette: { bg: "#ffffff", action: "#aa2200" }, fonts: "modern" });
    applyLook(element, { theme: "ink", palette: { action: "#ff8866" } });
    expect(element.dataset.theme).toBe("ink");
    expect(element.style.getPropertyValue("--dc-bg")).toBe("");
    expect(element.style.getPropertyValue("--dc-action")).toBe("#ff8866");
    expect(element.hasAttribute("data-fonts")).toBe(false);
    applyLook(element, { theme: "ink" });
    expect(element.getAttribute("style") ?? "").toBe("");
  });
});

describe("applyLook with a deck's look", () => {
  const face = (family: string, files: Array<[string, number]>) => ({
    family,
    files: files.map(([path, weight]) => ({ path, weight, style: "normal" as const })),
  });
  const branded = lookWith({
    chart: ["#112233", "#445566"],
    faces: {
      display: face("Harbor Display", [["brand/fonts/Display-Bold.woff2", 700]]),
      body: face("Harbor Sans", [
        ["brand/fonts/Sans-Regular.woff2", 400],
        ["brand/fonts/Sans-Bold.woff2", 700],
      ]),
    },
  });

  it("sets all nine colors of the theme, each as its own --dc property", () => {
    const element = document.createElement("div");
    applyLook(element, lookWith({ fonts: "technical" }));
    expect(element.dataset.theme).toBe("ink");
    expect(element.dataset.fonts).toBe("technical");
    expect(Object.keys(THEME_COLORS)).toHaveLength(9);
    for (const [name, value] of Object.entries(THEME_COLORS)) {
      expect(element.style.getPropertyValue(`--dc-${name}`), name).toBe(value);
    }
  });

  it("sets the brand's chart colors in order, and takes off the ones a shorter list leaves", () => {
    const element = document.createElement("div");
    applyLook(element, branded);
    expect(element.style.getPropertyValue("--dc-chart-1")).toBe("#112233");
    expect(element.style.getPropertyValue("--dc-chart-2")).toBe("#445566");
    expect(element.style.getPropertyValue("--dc-chart-3")).toBe("");
    applyLook(element, lookWith({ chart: ["#abcdef"] }));
    expect(element.style.getPropertyValue("--dc-chart-1")).toBe("#abcdef");
    expect(element.style.getPropertyValue("--dc-chart-2")).toBe("");
  });

  it("names the brand's faces first in the pair's stacks, and takes the names off when the brand goes", () => {
    const element = document.createElement("div");
    applyLook(element, branded);
    expect(element.style.getPropertyValue("--dc-face-display")).toBe('"Harbor Display",');
    expect(element.style.getPropertyValue("--dc-face-body")).toBe('"Harbor Sans",');
    expect(element.style.getPropertyValue("--dc-face-mono")).toBe("");
    applyLook(element, lookWith());
    expect(element.style.getPropertyValue("--dc-face-display")).toBe("");
    expect(element.style.getPropertyValue("--dc-display-weight")).toBe("");
  });

  it("gives the display face the weight it has a file nearest bold for, and none when it has no file", () => {
    const heavy = (weights: number[]) =>
      lookWith({
        faces: {
          display: face(
            "D",
            weights.map((weight) => [`brand/fonts/D-${weight}.woff2`, weight]),
          ),
          body: face("B", []),
        },
      });
    const weightOf = (look: DeckLook) => {
      const element = document.createElement("div");
      applyLook(element, look);
      return element.style.getPropertyValue("--dc-display-weight");
    };
    expect(weightOf(heavy([400, 700]))).toBe("700");
    expect(weightOf(heavy([400, 600]))).toBe("600");
    expect(weightOf(heavy([300, 900]))).toBe("900");
    expect(weightOf(heavy([500, 900]))).toBe("500");
    expect(weightOf(heavy([]))).toBe("");
  });

  it("leaves out a family that cannot be put in a stylesheet whole, so a brand cannot write one", () => {
    const element = document.createElement("div");
    const evil = lookWith({
      faces: {
        display: face('X"}body{display:none}@font-face{font-family:"Y', [["brand/fonts/x.woff2", 400]]),
        body: face("Fine", [["brand/fonts/f.woff2", 400]]),
      },
    });
    applyLook(element, evil);
    expect(element.style.getPropertyValue("--dc-face-display")).toBe("");
    expect(faceCss(evil, ".")).not.toContain("display:none");
    expect(faceCss(evil, ".")).toContain('"Fine"');
  });
});

describe("faceCss", () => {
  const faces = {
    display: {
      family: "Harbor Display",
      files: [{ path: "brand/fonts/D.woff2", weight: 700, style: "normal" as const }],
    },
    body: {
      family: "Harbor Sans",
      files: [
        { path: "brand/fonts/S.woff2", weight: 400, style: "normal" as const },
        { path: "brand/fonts/S-Italic.otf", weight: 400, style: "italic" as const },
      ],
    },
    mono: { family: "Harbor Mono", files: [] },
  };

  it("is one font-face rule per file, with the deck's folder in front of the path, and swaps while it loads", () => {
    const css = faceCss(lookWith({ faces }), "/decks/q3");
    expect(css.split("\n")).toEqual([
      '@font-face{font-family:"Harbor Display";src:url("/decks/q3/brand/fonts/D.woff2");font-weight:700;font-style:normal;font-display:swap}',
      '@font-face{font-family:"Harbor Sans";src:url("/decks/q3/brand/fonts/S.woff2");font-weight:400;font-style:normal;font-display:swap}',
      '@font-face{font-family:"Harbor Sans";src:url("/decks/q3/brand/fonts/S-Italic.otf");font-weight:400;font-style:italic;font-display:swap}',
    ]);
  });

  it("is empty for a look with no faces, a deck's plain look, and none", () => {
    expect(faceCss(lookWith(), ".")).toBe("");
    expect(faceCss({ theme: "paper" }, ".")).toBe("");
    expect(faceCss(undefined, ".")).toBe("");
  });

  it("declares a file once however many jobs the face does, and skips a path that is not a brand font", () => {
    const same = {
      family: "One",
      files: [{ path: "brand/fonts/One.woff2", weight: 400, style: "normal" as const }],
    };
    const css = faceCss(
      lookWith({
        faces: {
          display: same,
          body: same,
          mono: {
            family: "Bad",
            files: [{ path: "brand/fonts/../../x.woff2", weight: 400, style: "normal" as const }],
          },
        },
      }),
      ".",
    );
    expect(css.split("\n")).toHaveLength(1);
    expect(css).not.toContain("Bad");
  });
});

describe("a look's faces in a document", () => {
  /**
   * A stand-in for the browser's constructed stylesheet that keeps its rules as text, in a document of its own, so what
   * a look put in it can be read back whatever the test DOM does with `@font-face`.
   */
  class Sheet {
    static refused = "";
    static inserts = 0;
    rules: string[] = [];
    get cssRules() {
      return this.rules;
    }
    replaceSync() {
      this.rules = [];
    }
    // As the browser's: the rule goes in at the index, which is the front when none is given, and a rule that is not one
    // (an empty text) or that it does not take is refused.
    insertRule(rule: string, at = 0) {
      Sheet.inserts++;
      if (rule.trim() === "") throw new SyntaxError("not a rule");
      if (Sheet.refused && rule.includes(Sheet.refused)) throw new SyntaxError("refused");
      this.rules.splice(at, 0, rule);
      return at;
    }
  }
  const fresh = () => {
    vi.stubGlobal("CSSStyleSheet", Sheet);
    Sheet.refused = "";
    Sheet.inserts = 0;
    const doc = document.implementation.createHTMLDocument("faces");
    Object.defineProperty(doc, "adoptedStyleSheets", { value: [], writable: true, configurable: true });
    const held = () => (doc as unknown as { adoptedStyleSheets: Sheet[] }).adoptedStyleSheets;
    return { element: doc.createElement("div"), held };
  };
  afterEach(() => vi.unstubAllGlobals());

  const faced = (path: string, family = "Doc Face") =>
    lookWith({
      faces: {
        display: { family, files: [{ path, weight: 700, style: "normal" as const }] },
        body: { family, files: [] },
      },
    });

  it("go into one stylesheet the document holds, which a changed look replaces rather than adds to", () => {
    const { element, held } = fresh();
    applyLook(element, faced("brand/fonts/A.woff2"));
    expect(held()).toHaveLength(1);
    expect(held()[0]?.rules.join("\n")).toContain("A.woff2");
    // The same look again writes nothing: a thumbnail strip draws the look once per slide.
    const count = Sheet.inserts;
    applyLook(element, faced("brand/fonts/A.woff2"));
    expect(Sheet.inserts).toBe(count);
    // A changed look replaces the one sheet's rules.
    applyLook(element, faced("brand/fonts/B.woff2"));
    expect(held()).toHaveLength(1);
    expect(held()[0]?.rules.join("\n")).toContain("B.woff2");
    expect(held()[0]?.rules.join("\n")).not.toContain("A.woff2");
    // The brand goes: the faces go with it.
    applyLook(element, lookWith());
    expect(held()).toHaveLength(1);
    expect(held()[0]?.rules).toEqual([]);
  });

  it("go in one rule at a time, so a rule the browser refuses costs its own face and no other", () => {
    const { element, held } = fresh();
    Sheet.refused = '"Refused"';
    const look = lookWith({
      faces: {
        display: {
          family: "Refused",
          files: [{ path: "brand/fonts/R.woff2", weight: 700, style: "normal" as const }],
        },
        body: {
          family: "Kept",
          files: [{ path: "brand/fonts/K.woff2", weight: 400, style: "normal" as const }],
        },
      },
    });
    expect(() => applyLook(element, look)).not.toThrow();
    const rules = held()[0]?.rules ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('"Kept"');
  });

  it("leave out a family name with a control character in it, whichever one", () => {
    for (const bad of ["Tab\tFace", "New\nline", "Nul\u0000Face", "Del\u007fFace", "Esc\u001bFace"]) {
      const { element, held } = fresh();
      const look = lookWith({
        faces: {
          display: {
            family: bad,
            files: [{ path: "brand/fonts/X.woff2", weight: 700, style: "normal" as const }],
          },
          body: {
            family: "Fine",
            files: [{ path: "brand/fonts/F.woff2", weight: 400, style: "normal" as const }],
          },
        },
      });
      applyLook(element, look);
      expect(element.style.getPropertyValue("--dc-face-display"), JSON.stringify(bad)).toBe("");
      expect(faceCss(look, "."), JSON.stringify(bad)).not.toContain(bad);
      // The other face is still loaded.
      expect(held()[0]?.rules.join("\n"), JSON.stringify(bad)).toContain('"Fine"');
    }
  });
});

describe("lookKey of a deck's look", () => {
  it("changes for any part of the look, the brand's faces and the chrome included, and not for the same look again", () => {
    const base = lookKey(lookWith());
    expect(lookKey(lookWith())).toBe(base);
    expect(lookKey(lookWith({ theme: "paper" }))).not.toBe(base);
    expect(lookKey(lookWith({ chart: ["#112233"] }))).not.toBe(base);
    expect(lookKey(lookWith({ chrome: { accent: "top" } }))).not.toBe(base);
    expect(lookKey(lookWith({ colors: { ...THEME_COLORS, action: "#000000" } }))).not.toBe(base);
  });
});

describe("lookKey", () => {
  it("is the same for the same look however the palette is written, and differs for each part of it", () => {
    const base = lookKey({ theme: "paper", palette: { bg: "#ffffff", action: "#aa2200" }, fonts: "modern" });
    expect(lookKey({ theme: "paper", palette: { action: "#aa2200", bg: "#ffffff" }, fonts: "modern" })).toBe(
      base,
    );
    expect(
      lookKey({ theme: "ink", palette: { bg: "#ffffff", action: "#aa2200" }, fonts: "modern" }),
    ).not.toBe(base);
    expect(
      lookKey({ theme: "paper", palette: { bg: "#fffffe", action: "#aa2200" }, fonts: "modern" }),
    ).not.toBe(base);
    expect(
      lookKey({ theme: "paper", palette: { bg: "#ffffff", action: "#aa2200" }, fonts: "classic" }),
    ).not.toBe(base);
    expect(lookKey({ theme: "paper", palette: { bg: "#ffffff", action: "#aa2200" } })).not.toBe(base);
    expect(lookKey({ theme: "paper", fonts: "modern" })).not.toBe(base);
  });
});

describe("the player", () => {
  let host: HTMLElement;
  let player: Player | undefined;
  beforeEach(() => {
    history.replaceState(null, "", "/");
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => {
    player?.destroy();
    player = undefined;
    host.remove();
  });
  const root = () => host.querySelector<HTMLElement>(".dc-player") as HTMLElement;

  it("draws the deck's palette and font pair on the page: each of the seven colors reaches the root", () => {
    const source = demoSource();
    source.deck = { ...source.deck, theme: "ink", palette: COLORS, fonts: "technical" };
    player = mountPlayer(host, source, { reducedMotion: true });
    expect(root().dataset.theme).toBe("ink");
    expect(root().dataset.fonts).toBe("technical");
    for (const color of PALETTE_COLORS) {
      expect(root().style.getPropertyValue(`--dc-${color}`), color).toBe(COLORS[color]);
    }
  });

  it("changes the look when the deck is swapped in, as the editor and live reload do", () => {
    const source = demoSource();
    player = mountPlayer(host, source, { reducedMotion: true });
    expect(root().style.getPropertyValue("--dc-evidence")).toBe("");
    player.update({ ...source, deck: { ...source.deck, palette: { evidence: "#0044cc" }, fonts: "modern" } });
    expect(root().style.getPropertyValue("--dc-evidence")).toBe("#0044cc");
    expect(root().dataset.fonts).toBe("modern");
    player.update(source);
    expect(root().style.getPropertyValue("--dc-evidence")).toBe("");
    expect(root().hasAttribute("data-fonts")).toBe(false);
  });
});

describe("the presenter view", () => {
  it("is drawn in the deck's palette and font pair too", () => {
    const source = demoSource();
    const host = document.createElement("div");
    document.body.append(host);
    const channel = new EventTarget() as unknown as NonNullable<
      Parameters<typeof mountPresenterView>[0]["channel"]
    >;
    Object.assign(channel as object, { postMessage() {}, close() {} });
    const view = mountPresenterView({
      host,
      source: { ...source, deck: { ...source.deck, palette: { bg: "#ffffff" }, fonts: "classic" } },
      channel,
    });
    const root = host.querySelector<HTMLElement>(".dc-presenter") as HTMLElement;
    expect(root.dataset.fonts).toBe("classic");
    expect(root.style.getPropertyValue("--dc-bg")).toBe("#ffffff");
    view.destroy();
    host.remove();
  });
});
