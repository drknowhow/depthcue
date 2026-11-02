// The default brand and the brand commands, end to end: `brand init`, `brand use`, `brand check` and `new --brand` run
// through the real command line on real decks, and every built-in template is drawn in a real browser with sample content
// on both presets, with each font pair, with and without sources, and under two brands. The commands' own rules (what
// they refuse, what they write) are in brand-commands.test.ts; this file is what a reader would see.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookOf } from "@depthcue/core";
import type { Browser } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDeck } from "../src/deck-api.ts";
import { run } from "../src/index.ts";
import { launchBrowser, openRenderer } from "../src/render.ts";
import { builtPlayerDir, startServer } from "../src/serve.ts";
import { BUILT_IN_TEMPLATE_IDS, sampleDeckFiles, writeFiles } from "./brand-commands-fixtures.ts";

const fixtureOf = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/decks/${name}`, import.meta.url));

// biome-ignore lint/suspicious/noExplicitAny: a test helper that reads the JSON files a test names
type Json = Record<string, any>;

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
const closers: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  try {
    if (!existsSync(join(builtPlayerDir(), "player.js")))
      throw new Error("The player is not built. Run pnpm build.");
    browser = await launchBrowser();
  } catch (error) {
    // CI builds first and has Chrome, so it must not skip. A machine without either can run everything else.
    if (process.env.CI) throw error;
    skipReason = (error as Error).message;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-brand-commands-"));
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

/** A test that needs the browser, skipped on a machine that has none. */
const drawn = (name: string, body: () => Promise<void>, timeout = 120_000) =>
  it(
    name,
    async (test) => {
      if (!browser) {
        console.warn(`Skipped: ${skipReason}`);
        return test.skip();
      }
      await body();
    },
    timeout,
  );

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8"));
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A folder of this test's, empty or a copy of a fixture. */
function folder(name: string, from?: string): string {
  const dir = join(root, name);
  if (from) cpSync(fixtureOf(from), dir, { recursive: true });
  return dir;
}

async function initBrand(name = "Acme Widgets"): Promise<string> {
  const dir = folder("acme-brand");
  expect((await cli("brand", "init", dir, "--name", name)).code).toBe(0);
  return dir;
}

async function apply(deck: string, ops: unknown[]) {
  const file = join(root, `ops-${Math.random().toString(36).slice(2)}.json`);
  writeJson(file, ops);
  return cli("apply", deck, file, "--base-rev", (await cli("rev", deck)).out);
}

/** The codes of what the render finds in each scene of the deck, scene by scene. */
async function renderAll(dir: string): Promise<Record<string, string[]>> {
  const opened = openDeck(dir);
  if (!opened.ok) throw new Error(`the deck has errors: ${JSON.stringify(opened.diagnostics)}`);
  const renderer = await openRenderer(dir);
  closers.push(() => renderer.close());
  const found: Record<string, string[]> = {};
  for (const scene of opened.doc.deck.scenes) {
    const out = await renderer.render(scene, { screenshot: false });
    found[scene] = out.diagnostics.map((d) => `${d.code}: ${d.message}`);
  }
  await renderer.close();
  return found;
}

const problems = (found: Record<string, string[]>): string[] =>
  Object.entries(found).flatMap(([scene, list]) => list.map((message) => `${scene}: ${message}`));

describe("brand init, then check", () => {
  it("makes a brand that passes brand check, and uses it in an empty deck", async () => {
    const brand = await initBrand();
    const checked = await cli("brand", "check", brand);
    expect(checked).toMatchObject({ code: 0, out: "0 errors, 0 warnings" });
    const deck = folder("deck");
    expect((await cli("new", deck, "--brand", brand)).code).toBe(0);
    expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");
    expect((await cli("brand", "check", deck)).out).toBe("0 errors, 0 warnings");
  });

  drawn("and the deck made in it draws without a finding", async () => {
    const brand = await initBrand();
    const deck = folder("deck");
    expect((await cli("new", deck, "--brand", brand)).code).toBe(0);
    expect(problems(await renderAll(deck))).toEqual([]);
  });
});

describe("brand use on the fixture decks", () => {
  drawn("puts a brand in a 0.3 deck without adding a finding to what the deck already had", async () => {
    const deck = folder("v0-3", "v0-3");
    const before = await renderAll(deck);
    const brand = await initBrand();
    expect((await cli("brand", "use", brand, deck)).code).toBe(0);
    expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");
    expect((await cli("brand", "check", deck)).out).toContain("0 errors, 0 warnings");
    expect(await renderAll(deck)).toEqual(before);
  });

  drawn("puts a brand in the demo deck, which then draws clean", async () => {
    const deck = folder("demo", "demo");
    expect(problems(await renderAll(deck))).toEqual([]);
    const brand = await initBrand();
    expect((await cli("brand", "use", brand, deck)).code).toBe(0);
    expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");
    expect(problems(await renderAll(deck))).toEqual([]);
  });

  drawn(
    "puts the Harbor brand, with its fonts and logo, in the demo deck, whose own scenes then draw in its fonts",
    async () => {
      const deck = folder("demo", "demo");
      expect((await cli("brand", "use", join(fixtureOf("v0-4-brand"), "brand"), deck)).code).toBe(0);
      expect(existsSync(join(deck, "brand", "fonts", "HarborSans-Regular.woff2"))).toBe(true);
      expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");
      // Harbor's faces are wider than the built-in pair the demo was laid out in: a layout scene that was full to the
      // edge is reported by the render as taller than the stage, which is what the render is for. The brand's colors,
      // logo and footer do not add a finding of their own.
      const found = await renderAll(deck);
      expect(Object.keys(found)).toHaveLength(4);
      expect(problems(found).filter((line) => !/: overflow: /.test(line))).toEqual([]);
    },
  );

  it("refuses a copied file that was changed since, naming it, and replaces it with --force", async () => {
    const deck = folder("demo", "demo");
    const harbor = join(fixtureOf("v0-4-brand"), "brand");
    expect((await cli("brand", "use", harbor, deck)).code).toBe(0);
    const font = join(deck, "brand", "fonts", "OFL.txt");
    const original = readFileSync(font);
    writeFileSync(font, "changed by hand");
    const refused = await cli("brand", "use", harbor, deck);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("brand/fonts/OFL.txt  was changed after it was copied");
    expect(readFileSync(font, "utf8")).toBe("changed by hand");
    const forced = await cli("brand", "use", harbor, deck, "--force");
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("replaced brand/fonts/OFL.txt although it was changed after it was copied");
    expect(readFileSync(font).equals(original)).toBe(true);
  });

  it("refuses a brand that lacks a template a scene uses, names the scene and the move, and --force does not help", async () => {
    const deck = folder("harbor-deck", "v0-4-brand");
    const brand = await initBrand();
    for (const args of [[], ["--force"]]) {
      const refused = await cli("brand", "use", brand, deck, ...args);
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('scene "welcome" uses the template "cover"');
      expect(refused.out).toContain('Move it to "title" with depthcue apply');
      expect(refused.out).toContain('scene "growth" uses the template "chart-and-note"');
    }
    expect(readJson(join(deck, "deck.json")).brand).toBe("harbor");
  });

  it("shows a template change in the review and restores the file when it is reverted", async () => {
    const deck = folder("demo", "demo");
    expect((await cli("brand", "use", join(fixtureOf("v0-4-brand"), "brand"), deck)).code).toBe(0);
    // The brand itself is the agent's first change; accepting it makes the template edit the only one left.
    expect((await cli("diff", deck)).out).toContain("deck/template:cover  agent");
    expect((await cli("diff", deck, "accept", "--all")).code).toBe(0);
    const file = join(deck, "brand", "templates", "cover.json");
    const original = readFileSync(file);
    const cover = readJson(file);
    const { schemaVersion: _version, id: _id, ...template } = cover;
    const edited = await apply(deck, [
      { op: "template.set", id: "cover", template: { ...template, description: "Changed by an agent." } },
    ]);
    expect(edited.code).toBe(0);
    expect(readJson(file).description).toBe("Changed by an agent.");
    const listed = JSON.parse((await cli("diff", deck, "--json")).out);
    expect(listed.changes.map((change: { id: string }) => change.id)).toEqual(["deck/template:cover"]);
    expect(listed.changes[0]).toMatchObject({ scope: "deck", kind: "changed", field: "template:cover" });
    const reverted = await cli("diff", deck, "revert", "deck/template:cover");
    expect(reverted.code).toBe(0);
    expect(readFileSync(file).equals(original)).toBe(true);
    expect(JSON.parse((await cli("diff", deck, "--json")).out).changes).toEqual([]);
  });

  it("leaves the decks that have no brand as they were", async () => {
    for (const name of ["charts", "demo", "v0-1", "v0-2", "v0-3"]) {
      const deck = folder(name, name);
      const files = JSON.stringify(readJson(join(deck, "deck.json")));
      const checked = await cli("check", deck);
      expect(checked, name).toMatchObject({ code: 0, out: "0 errors, 0 warnings" });
      expect(await cli("brand", "check", deck), name).toMatchObject({
        code: 0,
        out: "The deck has no brand.\n0 errors, 0 warnings",
      });
      expect(JSON.stringify(readJson(join(deck, "deck.json"))), name).toBe(files);
      expect(existsSync(join(deck, "brand")), name).toBe(false);
    }
  });
});

describe("new --brand", () => {
  drawn("makes a deck in the brand, with the first scene on the brand's title template", async () => {
    const tidewell = join(fixtureOf("tidewell-press"), "brand");
    const deck = folder("tidewell-deck");
    const made = await cli("new", deck, "--brand", tidewell, "--name", "Autumn list review");
    expect(made.code).toBe(0);
    expect(readJson(join(deck, "scenes", "opening.json"))).toMatchObject({ template: "title" });
    expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");
    expect((await cli("brand", "check", deck)).code).toBe(0);
    expect(problems(await renderAll(deck))).toEqual([]);
  });

  drawn("uses the brand's own title template when it has one", async () => {
    const brand = await initBrand();
    writeJson(join(brand, "templates", "title.json"), {
      schemaVersion: "0.4",
      id: "title",
      name: "Acme title",
      description: "The opening slide: a title with a byline under it.",
      slots: [
        {
          id: "name",
          role: "title",
          frame: { x: 8, y: 28, w: 84, h: 30 },
          accepts: ["heading"],
          required: true,
          valign: "bottom",
          hint: "The title.",
        },
        {
          id: "byline",
          role: "body",
          frame: { x: 8, y: 62, w: 70, h: 10 },
          accepts: ["caption"],
          required: true,
          hint: "Who presents, and when.",
        },
      ],
    });
    const deck = folder("acme-deck");
    expect((await cli("new", deck, "--brand", brand)).code).toBe(0);
    const opening = readJson(join(deck, "scenes", "opening.json"));
    expect(opening.template).toBe("title");
    expect(opening.blocks.map((block: Json) => block.slot)).toEqual(["name", "byline"]);
    expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");
    expect(problems(await renderAll(deck))).toEqual([]);
  });
});

describe("the Tidewell Press fixture", () => {
  it("passes brand check as a folder and as a deck, and keeps its own quote template over the built-in one", async () => {
    const deck = folder("tidewell", "tidewell-press");
    expect(await cli("brand", "check", join(deck, "brand"))).toMatchObject({
      code: 0,
      out: "0 errors, 0 warnings",
    });
    expect(await cli("brand", "check", deck)).toMatchObject({ code: 0, out: "0 errors, 0 warnings" });
    expect((await cli("check", deck)).out).toBe("0 errors, 0 warnings");
    const opened = openDeck(deck);
    if (!opened.ok) throw new Error("the fixture has errors");
    const look = lookOf(opened.doc);
    expect(look.templates.quote?.background).toEqual({ color: "surface" });
    expect(look.templates.title?.name).toBe("Title");
  });

  drawn("draws every scene without a finding, on the paper preset and on ink", async () => {
    const deck = folder("tidewell", "tidewell-press");
    const found = await renderAll(deck);
    expect(Object.keys(found)).toHaveLength(11);
    expect(problems(found)).toEqual([]);
    const file = join(deck, "deck.json");
    writeJson(file, { ...readJson(file), theme: "ink" });
    expect(problems(await renderAll(deck))).toEqual([]);
  });
});

// ---- every built-in template, with sample content ----------------------------------------------------------------------

type Fonts = "editorial" | "modern" | "classic" | "technical";
const FONTS: readonly Fonts[] = ["editorial", "modern", "classic", "technical"];

/** The sample content of every built-in template, in a deck of its own. */
function sampleDeck(
  name: string,
  options: {
    theme: "paper" | "ink";
    fonts?: Fonts;
    sources?: boolean;
    brand?: string;
    extra?: Record<string, string | Uint8Array>;
  },
): string {
  const dir = folder(name);
  writeFiles(
    dir,
    sampleDeckFiles({
      theme: options.theme,
      ...(options.fonts ? { fonts: options.fonts } : {}),
      ...(options.sources === undefined ? {} : { sources: options.sources }),
      ...(options.brand ? { brand: options.brand } : {}),
      ...(options.extra ? { extra: options.extra } : {}),
    }),
  );
  return dir;
}

/** A brand folder of a fixture as the files a deck holds it in. */
function brandFiles(fixture: string): Record<string, string | Uint8Array> {
  const out: Record<string, string | Uint8Array> = {};
  const from = join(fixtureOf(fixture), "brand");
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else out[`brand/${prefix}${entry.name}`] = readFileSync(full);
    }
  };
  walk(from, "");
  return out;
}

describe("every built-in template, with sample content", () => {
  for (const theme of ["paper", "ink"] as const) {
    for (const fonts of FONTS) {
      drawn(`draws without a finding on ${theme} with the ${fonts} fonts and three sources`, async () => {
        const dir = sampleDeck("samples", { theme, fonts, sources: true });
        const found = await renderAll(dir);
        expect(Object.keys(found)).toEqual(BUILT_IN_TEMPLATE_IDS.map((id) => `s-${id}`));
        expect(problems(found)).toEqual([]);
      });
    }

    drawn(`draws without a finding on ${theme} with no sources`, async () => {
      expect(problems(await renderAll(sampleDeck("samples", { theme, sources: false })))).toEqual([]);
    });

    drawn(`draws without a finding on ${theme} under the Harbor brand`, async () => {
      const dir = sampleDeck("harbor-samples", {
        theme,
        sources: true,
        brand: "harbor",
        extra: brandFiles("v0-4-brand"),
      });
      expect((await cli("check", dir)).out).toBe("0 errors, 0 warnings");
      expect(problems(await renderAll(dir))).toEqual([]);
    });

    drawn(`draws without a finding on ${theme} under the Tidewell Press brand`, async () => {
      const dir = sampleDeck("tidewell-samples", {
        theme,
        sources: true,
        brand: "tidewell",
        extra: brandFiles("tidewell-press"),
      });
      expect((await cli("check", dir)).out).toBe("0 errors, 0 warnings");
      expect(problems(await renderAll(dir))).toEqual([]);
    });
  }

  // A machine with wider fonts than this one must still fit: the same content, with half as much text again in every
  // block that is not a heading.
  drawn("still fits with half again as much text in every block", async () => {
    const dir = sampleDeck("samples", { theme: "paper", fonts: "modern", sources: true });
    for (const id of BUILT_IN_TEMPLATE_IDS) {
      const file = join(dir, "scenes", `s-${id}.json`);
      const scene = readJson(file);
      for (const block of scene.blocks as Json[]) {
        if (block.type !== "text" || block.role === "heading") continue;
        const words = String(block.text).split(/\s+/);
        block.text = `${block.text} ${words.slice(0, Math.ceil(words.length / 2)).join(" ")}`;
      }
      writeJson(file, scene);
    }
    expect(problems(await renderAll(dir))).toEqual([]);
  });

  for (const theme of ["paper", "ink"] as const) {
    drawn(
      `puts every slot's box within a pixel of its frame on a 1280 by 720 slide on ${theme}`,
      async () => {
        const dir = sampleDeck("samples", { theme, sources: true });
        const opened = openDeck(dir);
        if (!opened.ok) throw new Error(`the deck has errors: ${JSON.stringify(opened.diagnostics)}`);
        const look = lookOf(opened.doc);
        const server = await startServer({ folder: dir, playerDir: builtPlayerDir(), port: 0 });
        closers.push(() => server.close());
        const context = await (browser as Browser).newContext({
          viewport: { width: 1280, height: 720 },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
          colorScheme: "light",
          bypassCSP: true,
        });
        closers.push(() => context.close());
        const page = await context.newPage();
        let checked = 0;
        let covered = 0;
        for (const id of opened.doc.deck.scenes) {
          const template = look.templates[opened.doc.scenes[id]?.template ?? ""];
          if (!template) throw new Error(`no template for ${id}`);
          await page.goto(`${server.url}#/${id}`);
          await page.addStyleTag({ content: ".dc-controls { display: none !important; }" });
          await page.waitForSelector(`.dc-scene[data-scene="${id}"]`);
          await page.evaluate(() => document.fonts.ready);
          const slide = await page.locator(".dc-scene").evaluate((element) => {
            const box = element.getBoundingClientRect();
            return { x: box.left, y: box.top, w: box.width, h: box.height };
          });
          expect(Math.abs(slide.w - 1280), `${id} width`).toBeLessThanOrEqual(1);
          expect(Math.abs(slide.h - 720), `${id} height`).toBeLessThanOrEqual(1);
          const boxes = await page.locator(".dc-slot").evaluateAll((slots) =>
            slots.map((slot) => {
              const box = slot.getBoundingClientRect();
              return {
                id: (slot as HTMLElement).dataset.slot ?? "",
                x: box.left,
                y: box.top,
                w: box.width,
                h: box.height,
              };
            }),
          );
          expect(boxes.length, `${id}: a slot with something in it is drawn`).toBeGreaterThan(0);
          for (const box of boxes) {
            const frame = template.slots.find((slot) => slot.id === box.id)?.frame;
            if (!frame) throw new Error(`${id}: the page drew a slot "${box.id}" the template does not have`);
            const want = {
              x: slide.x + (frame.x / 100) * 1280,
              y: slide.y + (frame.y / 100) * 720,
              w: (frame.w / 100) * 1280,
              h: (frame.h / 100) * 720,
            };
            for (const key of ["x", "y", "w", "h"] as const) {
              expect(Math.abs(box[key] - want[key]), `${id}/${box.id} ${key}`).toBeLessThanOrEqual(1);
            }
            checked++;
          }
          // A picture slot is the picture's whole box: the image covers the frame, with no edge of its own.
          const pictures = await page.locator('.dc-slot[data-role="picture"] img').evaluateAll((images) =>
            images.map((image) => {
              const slot = (image.closest(".dc-slot") as HTMLElement).getBoundingClientRect();
              const box = image.getBoundingClientRect();
              const style = getComputedStyle(image);
              return {
                dx: [box.left - slot.left, box.right - slot.right],
                dy: [box.top - slot.top, box.bottom - slot.bottom],
                fit: style.objectFit,
                border: style.borderTopWidth,
                radius: style.borderTopLeftRadius,
                background: style.backgroundColor,
              };
            }),
          );
          for (const picture of pictures) {
            expect(picture.fit, `${id} picture fit`).toBe("cover");
            expect(picture.border, `${id} picture border`).toBe("0px");
            expect(picture.radius, `${id} picture radius`).toBe("0px");
            expect(picture.background, `${id} picture background`).toBe("rgba(0, 0, 0, 0)");
            for (const edge of [...picture.dx, ...picture.dy])
              expect(Math.abs(edge), `${id} picture edge`).toBeLessThanOrEqual(1);
            covered++;
          }
        }
        // Ten templates, each with two slots or more in use (a title over a picture has two; an agenda, a few).
        expect(checked).toBeGreaterThanOrEqual(25);
        // `full-image` is the built-in with a picture slot, and its sample has a picture in it.
        expect(covered).toBeGreaterThanOrEqual(1);
      },
    );
  }
});
