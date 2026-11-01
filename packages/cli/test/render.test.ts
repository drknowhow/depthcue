import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { revisionOf } from "@depthcue/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyToFolder, openDeck } from "../src/deck-api.ts";
import { layoutDiagnostics, measureLayout } from "../src/layout.ts";
import { launchBrowser, openRenderer, RenderError, type Renderer } from "../src/render.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

let folder: string;
let renderer: Renderer | undefined;
let skipReason: string | undefined;

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "depthcue-render-"));
  cpSync(demo, folder, { recursive: true });
  try {
    renderer = await openRenderer(folder);
  } catch (error) {
    // CI has Chrome and must not skip. A machine without a browser can still run everything else.
    if (process.env.CI) throw error;
    skipReason = (error as Error).message;
  }
}, 60_000);

afterAll(async () => {
  await renderer?.close();
  rmSync(folder, { recursive: true, force: true });
});

const withRenderer = (run: (r: Renderer) => Promise<void>) => async (context: { skip: () => void }) => {
  if (!renderer) {
    console.warn(`Skipped: ${skipReason}`);
    return context.skip();
  }
  await run(renderer);
};

const rev = () => {
  const opened = openDeck(folder);
  if (!opened.ok) throw new Error("the deck should open");
  return revisionOf(opened.doc);
};

const longScene = (words: number) => ({
  id: "long",
  title: "Too much",
  layout: "text-media",
  blocks: [
    { id: "long-heading", type: "text", role: "heading", text: "Everything at once" },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({
      id: `long-body-${n}`,
      type: "text",
      role: "body",
      text: Array.from({ length: words }, (_, i) => `word${i}`).join(" "),
    })),
  ],
});

describe("rendering the fixture deck", () => {
  it(
    "shows every scene with no layout problems, as a 1280x720 PNG",
    withRenderer(async (r) => {
      for (const id of ["opening", "demand", "method"]) {
        const result = await r.render(id);
        expect(result.diagnostics, id).toEqual([]);
        const png = result.png as Buffer;
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(png.readUInt32BE(16)).toBe(1280);
        expect(png.readUInt32BE(20)).toBe(720);
        expect(result.measure.words).toBeGreaterThan(5);
      }
    }),
    60_000,
  );

  it(
    "shows the fullest state by default and fewer words at an earlier step",
    withRenderer(async (r) => {
      const full = await r.render("demand", { screenshot: false });
      const first = await r.render("demand", { step: 0, screenshot: false });
      expect(full.step).toBe(2);
      expect(first.step).toBe(0);
      expect(first.measure.words).toBeLessThan(full.measure.words);
      expect(first.measure.text.some((sample) => sample.id === "chart-demand")).toBe(false);
      expect(full.measure.text.some((sample) => sample.id === "chart-demand")).toBe(true);
    }),
    60_000,
  );

  it(
    "skips the screenshot when asked",
    withRenderer(async (r) => {
      expect((await r.render("opening", { screenshot: false })).png).toBeUndefined();
    }),
    60_000,
  );
});

describe("finding real problems", () => {
  it(
    "reports overflow, names the cut-off block, and clears once the text is shortened",
    withRenderer(async (r) => {
      const added = applyToFolder(folder, [{ op: "scene.add", scene: longScene(80) }], rev());
      expect(added, JSON.stringify(added)).toMatchObject({ ok: true });

      const crowded = await r.render("long", { screenshot: false });
      const overflow = crowded.diagnostics.find((d) => d.code === "overflow");
      expect(overflow).toBeDefined();
      expect(overflow?.file).toBe("scenes/long.json");
      expect(overflow?.message).toMatch(/\d+px taller than the 1280x720 stage/);
      expect(overflow?.message).toContain("long-body-");
      expect(overflow?.path).toMatch(/^\/blocks\/\d$/);
      expect(overflow?.fix).toMatch(/Shorten the text first.*roomier template.*split the scene/);

      for (const n of [1, 2, 3, 4, 5, 6]) {
        const edit = applyToFolder(
          folder,
          [{ op: "block.set", scene: "long", id: `long-body-${n}`, set: { text: "A short line." } }],
          rev(),
        );
        expect(edit.ok).toBe(true);
      }
      const fixed = await r.render("long", { screenshot: false });
      expect(fixed.diagnostics).toEqual([]);
      applyToFolder(folder, [{ op: "scene.remove", id: "long" }], rev());
    }),
    60_000,
  );

  it(
    "flags text that is too small at a small stage",
    withRenderer(async (r) => {
      const tiny = await r.render("demand", { width: 480, height: 270, screenshot: false });
      expect(tiny.diagnostics.some((d) => d.code === "text-too-small")).toBe(true);
    }),
    60_000,
  );

  it(
    "keeps the ink theme readable",
    withRenderer(async (r) => {
      expect(applyToFolder(folder, [{ op: "deck.set", set: { theme: "ink" } }], rev()).ok).toBe(true);
      try {
        for (const id of ["opening", "demand", "method"]) {
          const result = await r.render(id, { screenshot: false });
          expect(
            result.diagnostics.filter((d) => d.code === "low-contrast"),
            id,
          ).toEqual([]);
        }
      } finally {
        applyToFolder(folder, [{ op: "deck.set", set: { theme: "paper" } }], rev());
      }
    }),
    60_000,
  );
});

describe("the deck's own palette and font pair", () => {
  const same = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) =>
    a.r === b.r && a.g === b.g && a.b === b.b;
  const RESTORE = () => cpSync(join(demo, "deck.json"), join(folder, "deck.json"));

  it(
    "draws the text and the background in the palette's colors, and in the preset's again once it is taken off",
    withRenderer(async (r) => {
      const plain = await r.render("demand", { screenshot: false });
      const text = { r: 58, g: 16, b: 16 };
      const bg = { r: 255, g: 255, b: 255 };
      expect(plain.measure.text.some((sample) => same(sample.fg, text))).toBe(false);
      const set = applyToFolder(
        folder,
        [{ op: "deck.set", set: { palette: { text: "#3a1010", bg: "#ffffff" } } }],
        rev(),
      );
      expect(set, JSON.stringify(set)).toMatchObject({ ok: true });
      try {
        const styled = await r.render("demand", { screenshot: false });
        expect(styled.diagnostics.filter((d) => d.code === "low-contrast")).toEqual([]);
        const heading = styled.measure.text.find((sample) => same(sample.fg, text));
        expect(heading, "no text is in the palette's text color").toBeDefined();
        expect(same((heading as { bg: typeof bg }).bg, bg)).toBe(true);
      } finally {
        expect(applyToFolder(folder, [{ op: "deck.set", set: { palette: null } }], rev()).ok).toBe(true);
      }
      try {
        const back = await r.render("demand", { screenshot: false });
        expect(back.measure.text.some((sample) => same(sample.fg, text))).toBe(false);
        expect(back.measure.text.some((sample) => same(sample.bg, bg))).toBe(false);
      } finally {
        RESTORE();
      }
    }),
    60_000,
  );

  it(
    "sets a heading in its pair's weight and lays the same text out in the width of each pair's fonts",
    withRenderer(async (r) => {
      // The text is long, so the lines it breaks into depend on how wide each pair's body font runs.
      const pool = ["the", "measure", "of", "every", "pair", "varies", "with", "its", "letters"];
      const words = Array.from({ length: 85 }, (_, i) => pool[i % pool.length]).join(" ");
      const added = applyToFolder(
        folder,
        [
          {
            op: "scene.add",
            scene: {
              id: "wide",
              title: "Wide",
              layout: "text-media",
              blocks: [
                { id: "wide-heading", type: "text", role: "heading", text: "How wide the words run" },
                { id: "wide-body", type: "text", role: "body", text: words },
              ],
            },
          },
        ],
        rev(),
      );
      expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
      try {
        const weights: Record<string, number | undefined> = {};
        const heights: Record<string, number> = {};
        for (const fonts of ["editorial", "modern", "classic", "technical"] as const) {
          expect(applyToFolder(folder, [{ op: "deck.set", set: { fonts } }], rev()).ok).toBe(true);
          const shown = await r.render("wide", { screenshot: false });
          weights[fonts] = shown.measure.text.find((sample) => sample.text.startsWith("How wide"))?.weight;
          heights[fonts] = shown.measure.boxes.find((box) => box.id === "wide-body")?.height ?? 0;
        }
        // Instrument Serif and Depthcue Classic Serif have one weight, 400; Inter and IBM Plex Sans are set in bold.
        expect(weights).toEqual({ editorial: 400, modern: 700, classic: 400, technical: 700 });
        expect(Object.values(heights).every((height) => height > 0)).toBe(true);
        expect(
          new Set(Object.values(heights)).size,
          `four font pairs set the same text to one height: ${JSON.stringify(heights)}`,
        ).toBeGreaterThan(1);
      } finally {
        applyToFolder(folder, [{ op: "scene.remove", id: "wide" }], rev());
        RESTORE();
      }
    }),
    60_000,
  );

  it(
    "refuses to render a deck whose palette leaves text unreadable, and says which colors",
    withRenderer(async (r) => {
      // `apply` would refuse this palette, so it is written by hand, as a person editing the file might.
      const manifest = JSON.parse(readFileSync(join(demo, "deck.json"), "utf8"));
      writeFileSync(
        join(folder, "deck.json"),
        JSON.stringify({ ...manifest, schemaVersion: "0.3", palette: { text: "#f5f2ea" } }),
      );
      try {
        await expect(r.render("opening")).rejects.toThrow(RenderError);
        await expect(r.render("opening")).rejects.toThrow(/palette/);
      } finally {
        RESTORE();
      }
    }),
    60_000,
  );
});

describe("pinned blocks", () => {
  /** A scene whose note is pinned over the template's heading and whose long text does not fit its frame. */
  const pinnedScene = {
    schemaVersion: "0.2",
    id: "pins",
    title: "Pins",
    layout: "text-media",
    blocks: [
      { id: "pins-heading", type: "text", role: "heading", text: "A heading in the template" },
      {
        id: "pins-note",
        type: "text",
        role: "body",
        text: "A note pinned across the middle.",
        frame: { x: 5, y: 35, w: 90, h: 30 },
      },
      {
        id: "pins-long",
        type: "text",
        role: "body",
        // Fonts differ between machines, so the text takes a third of the frame it is moved to, not nearly all of it.
        text: Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "),
        frame: { x: 60, y: 75, w: 30, h: 6 },
      },
    ],
  };

  it(
    "reports an overlap and an overflow with the frame to change, and clears once the frames are fixed",
    withRenderer(async (r) => {
      const added = applyToFolder(folder, [{ op: "scene.add", scene: pinnedScene }], rev());
      expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
      try {
        const crowded = await r.render("pins", { screenshot: false });
        const overlap = crowded.diagnostics.find((d) => d.code === "frame-overlap");
        expect(overlap).toMatchObject({ severity: "warning", file: "scenes/pins.json", path: "/blocks/1" });
        expect(overlap?.message).toContain("pins-heading");
        expect(overlap?.fix).toContain('frame of "pins-note"');
        const spill = crowded.diagnostics.find((d) => d.code === "frame-overflow");
        expect(spill).toMatchObject({ severity: "error", path: "/blocks/2" });
        expect(spill?.message).toMatch(/"pins-long" is \d+px taller than its frame/);
        expect(crowded.diagnostics.some((d) => d.code === "overlap")).toBe(false);

        const edit = applyToFolder(
          folder,
          [
            { op: "block.unframe", scene: "pins", id: "pins-note" },
            { op: "block.frame", scene: "pins", id: "pins-long", frame: { x: 5, y: 66, w: 90, h: 29 } },
          ],
          rev(),
        );
        expect(edit, JSON.stringify(edit)).toMatchObject({ ok: true });
        const fixed = await r.render("pins", { screenshot: false });
        expect(fixed.diagnostics).toEqual([]);
      } finally {
        applyToFolder(folder, [{ op: "scene.remove", id: "pins" }], rev());
      }
    }),
    60_000,
  );
});

describe("bad requests", () => {
  it(
    "names the scenes when the scene does not exist",
    withRenderer(async (r) => {
      await expect(r.render("nope")).rejects.toThrow(/no scene "nope".*opening, demand, method/);
    }),
    60_000,
  );

  it(
    "refuses a deck that has errors",
    withRenderer(async (r) => {
      writeFileSync(join(folder, "deck.json"), "{ not json");
      try {
        await expect(r.render("opening")).rejects.toThrow(RenderError);
      } finally {
        cpSync(join(demo, "deck.json"), join(folder, "deck.json"));
      }
    }),
    60_000,
  );
});

describe("the measuring function", () => {
  it(
    "sees which blocks are pinned in an overlap, and a pinned block that is larger than its frame",
    withRenderer(async () => {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
        await page.setContent(`
          <style>
            body { margin: 0; }
            .dc-view { position: absolute; inset: 0; overflow: auto; }
            .dc-scene { position: relative; min-height: 100%; }
            .box { position: absolute; width: 200px; height: 100px; background: #ddd; }
          </style>
          <div class="dc-view"><section class="dc-scene">
            <div class="dc-block box" data-id="plain" style="left:10px;top:10px">plain</div>
            <div class="dc-block dc-pinned box" data-id="over" style="left:100px;top:50px">over</div>
            <div class="dc-block dc-pinned box" data-id="spills" style="left:400px;top:10px;height:30px">
              <div style="height:90px;width:260px">tall and wide inside</div>
            </div>
            <div class="dc-block dc-pinned box" data-id="fits" style="left:400px;top:200px"><div>fits</div></div>
            <div class="dc-block dc-pinned box" data-id="later" style="left:600px;top:200px;height:30px;visibility:hidden">
              <div style="height:90px">not shown yet</div>
            </div>
          </section></div>`);
        const measure = await page.evaluate(measureLayout);
        expect(measure.overlaps).toEqual([
          expect.objectContaining({ a: "plain", b: "over", pinned: ["over"] }),
        ]);
        expect(measure.spills).toEqual([{ id: "spills", x: 60, y: 60 }]);
      } finally {
        await browser.close();
      }
    }),
    60_000,
  );

  it(
    "leaves out the ghost a pinned block keeps in the template: no box, no overlap, no second picture",
    withRenderer(async () => {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
        await page.setContent(`
          <style>
            body { margin: 0; }
            .dc-view { position: absolute; inset: 0; overflow: auto; }
            .dc-scene { position: relative; min-height: 100%; }
            .box { position: absolute; width: 200px; height: 100px; background: #ddd; }
            .dc-ghost { visibility: hidden; }
          </style>
          <div class="dc-view"><section class="dc-scene">
            <div class="dc-block box" data-id="plain" style="left:10px;top:10px">plain</div>
            <div class="dc-ghost box" aria-hidden="true" style="left:100px;top:50px">the room of a pinned text</div>
            <figure class="dc-ghost" aria-hidden="true" style="position:absolute;left:400px;top:200px">
              <img src="data:image/png;base64,AAAA" alt="the room of a pinned picture">
            </figure>
          </section></div>`);
        const measure = await page.evaluate(measureLayout);
        expect(measure.boxes.map((box) => box.id)).toEqual(["plain"]);
        expect(measure.overlaps).toEqual([]);
        expect(measure.images).toEqual([]);
      } finally {
        await browser.close();
      }
    }),
    60_000,
  );

  it(
    "sees overlap, clipping, a cut-off block and a missing image in a hand-built page",
    withRenderer(async () => {
      const browser = await launchBrowser();
      try {
        const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
        await page.setContent(`
          <style>
            body { margin: 0; }
            .dc-view { position: absolute; inset: 0; overflow: auto; }
            .dc-scene { position: relative; min-height: 100%; }
            .box { position: absolute; width: 200px; height: 100px; background: #ddd; }
          </style>
          <div class="dc-view"><section class="dc-scene">
            <div class="dc-block box" data-id="one" style="left:10px;top:10px">one</div>
            <div class="dc-block box" data-id="two" style="left:100px;top:50px">two</div>
            <div class="dc-block box" data-id="clip" style="left:400px;top:10px;overflow:hidden;height:30px">
              <div style="height:90px">tall inside</div>
            </div>
            <div class="dc-block box" data-id="low" style="left:10px;top:600px">low</div>
            <img class="dc-block" data-id="gone" src="data:image/png;base64,AAAA" alt="x" style="position:absolute;left:600px;top:300px">
          </section></div>`);
        const measure = await page.evaluate(measureLayout);
        expect(measure.overlaps).toEqual([expect.objectContaining({ a: "one", b: "two" })]);
        expect(measure.clipped).toEqual([expect.objectContaining({ id: "clip", axis: "y", by: 60 })]);
        expect(measure.boxes.find((box) => box.id === "low")?.beyond).toBe("bottom");
        expect(measure.view.scrollHeight).toBeGreaterThan(measure.view.height);
        expect(measure.images).toEqual([expect.objectContaining({ id: "gone", ok: false })]);

        const scene = {
          id: "hand",
          title: "Hand",
          layout: "title",
          blocks: ["one", "two", "clip", "low", "gone"].map((id) => ({
            id,
            type: "text",
            role: "body",
            text: id,
          })),
        };
        const codes = layoutDiagnostics(scene as never, measure).map((d) => d.code);
        expect(codes).toEqual(expect.arrayContaining(["overflow", "clipped", "overlap", "image-failed"]));
      } finally {
        await browser.close();
      }
    }),
    60_000,
  );
});
