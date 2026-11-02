import { describe, expect, it } from "vitest";
import {
  acceptChanges,
  applyOps,
  type BlockStyle,
  BRAND_FILE,
  BUILT_IN_STYLES,
  BUILT_IN_TEMPLATES,
  blockStylesOf,
  brandPartOf,
  checkDeckVersion,
  checkDoc,
  checkScene,
  checkSceneBrand,
  checkSceneVersion,
  checkTemplate,
  checkTemplateFile,
  checkTones,
  type DeckFiles,
  type Diagnostic,
  type Doc,
  docToFiles,
  isTemplateFile,
  kitOf,
  loadDoc,
  lookOf,
  memoryDraftStore,
  type Op,
  PRESETS,
  readReview,
  recoverDraft,
  retemplate,
  reviewChanges,
  reviewToText,
  revisionOf,
  type Scene,
  serializeDraft,
  startReview,
  styleOf,
  type Template,
  templateIdOf,
  templatesOf,
} from "../src/index.ts";
import { brandDir, brandDoc, demoDoc, loadDir } from "./helpers.ts";

/** The files the branded fixture's brand folder holds besides its JSON: two font files, their license and the logo. */
const FIXTURE_BRAND_FILES = [
  "brand/fonts/HarborSans-Bold.woff2",
  "brand/fonts/HarborSans-Regular.woff2",
  "brand/fonts/OFL.txt",
  "brand/logos/harbor.svg",
];

const codes = (diagnostics: readonly Diagnostic[]): string[] => diagnostics.map((d) => d.code);
const errors = (diagnostics: readonly Diagnostic[]): string[] =>
  codes(diagnostics.filter((d) => d.severity === "error"));

/** The branded fixture's files, with some JSON files replaced (an object) or removed (null). */
function brandFiles(changes: Record<string, unknown> = {}, extra: Partial<DeckFiles> = {}): DeckFiles {
  const files = loadDir(brandDir);
  const text: Record<string, string> = { ...files.text };
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) delete text[path];
    else text[path] = JSON.stringify(value);
  }
  return { ...files, text, ...extra };
}
// biome-ignore lint/suspicious/noExplicitAny: a hand edit of parsed JSON, which has no type to give it
const json = (path: string): Record<string, any> => JSON.parse(loadDir(brandDir).text[path] as string);
const checked = (changes: Record<string, unknown>, extra: Partial<DeckFiles> = {}): Diagnostic[] =>
  loadDoc(brandFiles(changes, extra)).diagnostics;

const apply = (doc: Doc, ops: Op[]) => applyOps(doc, ops, revisionOf(doc));
function applied(doc: Doc, ops: Op[]): Doc {
  const result = apply(doc, ops);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.doc;
}
const scene04 = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  schemaVersion: "0.4",
  id: "s1",
  title: "S",
  blocks: [{ id: "h1", type: "text", role: "heading", text: "Hello" }],
  ...overrides,
});

describe("the branded fixture", () => {
  it("loads with no errors, its brand, both templates and its logo", () => {
    const { doc, diagnostics } = loadDoc(loadDir(brandDir));
    expect(errors(diagnostics)).toEqual([]);
    expect(doc?.brand?.id).toBe("harbor");
    expect(Object.keys(doc?.templates ?? {}).sort()).toEqual(["chart-and-note", "cover"]);
    expect([...(doc?.brandFiles ?? [])]).toEqual(FIXTURE_BRAND_FILES);
  });

  it("writes back exactly the files it was read from", () => {
    const files = loadDir(brandDir);
    const written = docToFiles(brandDoc());
    expect(Object.keys(written).sort()).toEqual(Object.keys(files.text).sort());
    for (const [path, text] of Object.entries(written))
      expect(JSON.parse(text)).toEqual(JSON.parse(files.text[path] as string));
  });
});

describe("schema 0.4 in a scene", () => {
  it("takes a layout or a template, and refuses both or neither by name", () => {
    expect(errors(checkScene(scene04({ template: "section" }), "f"))).toEqual([]);
    expect(errors(checkScene(scene04({ layout: "title" }), "f"))).toEqual([]);
    expect(checkScene(scene04({ layout: "title", template: "section" }), "f")).toMatchObject([
      { code: "layout-and-template", path: "/template" },
    ]);
    expect(checkScene(scene04({}), "f")).toMatchObject([{ code: "missing-property", path: "/layout" }]);
  });

  it("names a 0.4 field in an older file for the field", () => {
    const old = {
      ...scene04({ schemaVersion: "0.3", template: "section" }),
      blocks: [{ id: "h1", type: "text", role: "heading", text: "Hi", slot: "title", style: "callout" }],
    } as unknown as Scene;
    expect(codes(checkSceneVersion(old, "f")).sort()).toEqual([
      "slot-needs-version",
      "style-needs-version",
      "template-needs-version",
    ]);
    const deck = { ...brandDoc().deck, schemaVersion: "0.3" } as const;
    expect(checkDeckVersion(deck)).toMatchObject([{ code: "brand-needs-version", path: "/brand" }]);
  });

  it("refuses a slot or a style that is not an id", () => {
    const scene = scene04({
      template: "section",
      blocks: [{ id: "h1", type: "text", role: "heading", text: "Hi", slot: "Title!", style: 3 }],
    });
    expect(checkScene(scene, "f")).toMatchObject([
      { code: "bad-format", path: "/blocks/0/slot" },
      { code: "wrong-type", path: "/blocks/0/style" },
    ]);
  });
});

describe("a scene against its deck's templates and styles", () => {
  const kit = kitOf(brandPartOf(brandDoc()));
  const growth = brandDoc().scenes.growth as Scene;
  const withBlocks = (scene: Scene, blocks: unknown[], more: Partial<Scene> = {}): Scene =>
    ({ ...scene, ...more, blocks }) as Scene;
  const heading = (slot?: string, more: object = {}) => ({
    id: `h${slot ?? ""}`,
    type: "text",
    role: "heading",
    text: "A finding",
    ...(slot ? { slot } : {}),
    ...more,
  });

  it("passes the fixture's scenes", () => {
    for (const scene of Object.values(brandDoc().scenes))
      expect(checkSceneBrand(scene, kit, "f")).toEqual([]);
  });

  it("names an unknown template, slot or style, with the closest one", () => {
    expect(checkSceneBrand({ ...growth, template: "chart-and-not" }, kit, "f")).toMatchObject([
      { code: "unknown-template", path: "/template", fix: expect.stringContaining('"chart-and-note"') },
    ]);
    const blocks = [heading("titel"), { ...heading("chart"), id: "x", style: "kiker", role: "caption" }];
    expect(codes(checkSceneBrand(withBlocks(growth, blocks), kit, "f"))).toEqual([
      "unknown-style",
      "unknown-slot",
      "slot-refuses-block",
      "slot-empty",
      "slot-empty",
    ]);
  });

  it("refuses a style on a kind it is not for, and a block in a slot that does not take it", () => {
    const found = checkSceneBrand(
      withBlocks(growth, [heading("title", { style: "quiet-panel" }), heading("chart"), heading("note")]),
      kit,
      "f",
    );
    expect(found.filter((d) => d.severity === "error")).toMatchObject([
      { code: "style-wrong-kind", path: "/blocks/0/style" },
      { code: "slot-refuses-block", path: "/blocks/1/slot" },
      { code: "slot-refuses-block", path: "/blocks/2/slot" },
    ]);
  });

  it("refuses a block over a slot's max once, and a block with no slot", () => {
    const note = (id: string) => ({ id, type: "text", role: "body", text: "A note.", slot: "note" });
    const blocks = [
      heading("title"),
      { ...heading(), id: "loose" },
      note("n1"),
      note("n2"),
      note("n3"),
      note("n4"),
    ];
    expect(errors(checkSceneBrand(withBlocks(growth, blocks), kit, "f"))).toEqual([
      "missing-slot",
      "slot-over-max",
    ]);
  });

  it("warns, not refuses, when a required slot is empty", () => {
    const found = checkSceneBrand(withBlocks(growth, [heading("title")]), kit, "f");
    expect(found).toMatchObject([
      { severity: "warning", code: "slot-empty", fix: expect.stringContaining("The chart or table") },
    ]);
  });

  it("keeps a template scene's claim in its template's claim slot, and refuses one with nowhere to go", () => {
    const summary = { id: "claim", text: "Ships rose a third.", evidenceIds: ["growth-chart"] };
    expect(checkSceneBrand({ ...growth, summary } as Scene, kit, "f")).toMatchObject([
      {
        severity: "error",
        code: "claim-without-slot",
        path: "/summary",
        message: 'The template "chart-and-note" has no claim slot, so the scene\'s claim has no place to go.',
        fix: 'Move the scene to a template with a claim slot (statement, big-number), or remove "summary".',
      },
    ]);
    const chart = { ...growth.blocks[1], slot: "evidence" };
    expect(
      checkSceneBrand(withBlocks(growth, [chart], { template: "statement", summary }), kit, "f"),
    ).toEqual([]);
    // Without a claim the required claim slot is empty, and no block may stand in for it.
    expect(
      checkSceneBrand(withBlocks(growth, [heading("claim"), chart], { template: "statement" }), kit, "f"),
    ).toMatchObject([
      {
        code: "slot-refuses-block",
        path: "/blocks/0/slot",
        message: 'The slot "claim" holds the scene\'s claim, and takes no block.',
      },
      {
        severity: "warning",
        code: "slot-empty",
        message: 'The slot "claim" of the template "statement" is empty.',
      },
    ]);
    const hidden = kitOf({
      ...brandPartOf(brandDoc()),
      brand: { ...brandDoc().brand, hideBuiltIn: ["templates"] } as never,
    });
    expect(checkSceneBrand({ ...growth, summary } as Scene, hidden, "f")).toMatchObject([
      {
        code: "claim-without-slot",
        fix: 'Remove "summary": none of the deck\'s templates has a claim slot.',
      },
    ]);
  });

  it("refuses a slot in a layout scene", () => {
    const context = brandDoc().scenes.context as Scene;
    const slotted = withBlocks(context, [heading("title")]);
    expect(checkSceneBrand(slotted, kit, "f")).toMatchObject([
      { code: "slot-without-template", path: "/blocks/0/slot" },
    ]);
  });

  it("counts a pinned block in its slot, and lets a pinned block with no slot float over the template", () => {
    const frame = { x: 70, y: 70, w: 20, h: 20 };
    // Pinned, the title still fills its required slot and takes the one place it has.
    const [title, ...rest] = growth.blocks;
    expect(checkSceneBrand(withBlocks(growth, [{ ...title, frame }, ...rest]), kit, "f")).toEqual([]);
    const second = heading("title", { id: "second", frame });
    expect(checkSceneBrand(withBlocks(growth, [...growth.blocks, second]), kit, "f")).toMatchObject([
      { code: "slot-over-max", path: "/blocks/3/slot" },
    ]);
    // With no slot it is an overlay: allowed, and it fills no slot.
    const overlay = { ...heading(), id: "overlay", frame };
    expect(checkSceneBrand(withBlocks(growth, [...growth.blocks, overlay]), kit, "f")).toEqual([]);
    expect(checkSceneBrand(withBlocks(growth, [overlay, ...rest]), kit, "f")).toMatchObject([
      { severity: "warning", code: "slot-empty", message: expect.stringContaining('"title"') },
    ]);
    const doc = applied(brandDoc(), [{ op: "block.add", scene: "growth", block: overlay as never }]);
    expect(errors(checkDoc(doc))).toEqual([]);
    // Unpinned, a block with no slot is still refused.
    expect(apply(doc, [{ op: "block.unframe", scene: "growth", id: "overlay" }])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "missing-slot", path: "/blocks/3" }],
    });
  });

  it("checks a styled block's text on the colors it resolves to, its own size and tone over its style's", () => {
    const doc = brandDoc();
    // An accent that reaches the 3:1 large text needs, and not the 4.5:1 of smaller text.
    const style = styleOf({ ...doc.deck, palette: { action: "#D2552E" } }, doc.brand);
    const one = (scene: Scene, block: object): Scene => ({ ...scene, blocks: [block] }) as Scene;
    const context = doc.scenes.context as Scene;
    const stat = { id: "n", type: "text", role: "body", text: "42%", style: "stat" };
    // The style draws it xl, so 3:1 is enough, until the block makes itself small or takes a tone of its own.
    expect(checkTones(one(context, stat), style, "f", kit)).toEqual([]);
    expect(checkTones(one(context, { ...stat, size: "s" }), style, "f", kit)).toMatchObject([
      {
        code: "block-low-contrast",
        path: "/blocks/0/style",
        message: expect.stringMatching(
          /^The text is drawn in "action" \(#D2552E\) on "bg" \(#F5F2EA\), .* under the 4\.5:1 that text of this size needs\.$/,
        ),
      },
    ]);
    expect(checkTones(one(context, { ...stat, size: "s", tone: "text" }), style, "f", kit)).toEqual([]);
    // A slot's style is the block's when it names none: the note slot's panel puts the text on the surface.
    const growth = doc.scenes.growth as Scene;
    const note = { ...growth.blocks[2], text: "Up [12%]{action}." };
    expect(checkTones(one(growth, note), style, "f", kit)).toMatchObject([
      {
        code: "block-low-contrast",
        path: "/blocks/0/text",
        message: expect.stringContaining('on "surface"'),
      },
    ]);
    // On a template's colored background: the cover's is the accent, which the slide's text color does not read on.
    const welcome = doc.scenes.welcome as Scene;
    const byline = { ...welcome.blocks[2], tone: "text" };
    expect(checkTones(one(welcome, byline), styleOf(doc.deck, doc.brand), "f", kit)).toMatchObject([
      {
        code: "block-low-contrast",
        path: "/blocks/0/tone",
        message: expect.stringContaining('"text" (#14161B) on "action" (#0B6E6E)'),
      },
    ]);
    expect(
      apply(doc, [{ op: "block.set", scene: "welcome", id: "welcome-byline", set: { tone: "text" } }]),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "block-low-contrast", file: "scenes/welcome.json", path: "/blocks/2/tone" }],
    });
  });
});

describe("ids that are names on Object.prototype", () => {
  // "constructor" passes the id pattern and a plain object answers it with a function; the other two fail the pattern.
  const NAMES = ["constructor", "__proto__", "toString"];
  const fromJson = (key: string): Record<string, unknown> => JSON.parse(`{${JSON.stringify(key)}: 1}`);
  const scene = brandDoc().scenes.context as Scene;
  const heading = scene.blocks[1] as { id: string };

  it("are an unknown template or style in a scene file, never a crash", () => {
    for (const name of NAMES) {
      const asTemplate = { ...json("scenes/welcome.json"), template: name };
      const expected = name === "constructor" ? "unknown-template" : "bad-format";
      expect(errors(checked({ "scenes/welcome.json": asTemplate }))).toEqual([expected]);
      const context = json("scenes/context.json");
      context.blocks[1].style = name;
      expect(checked({ "scenes/context.json": context })).toMatchObject([
        { code: name === "constructor" ? "unknown-style" : "bad-format", path: "/blocks/1/style" },
      ]);
      const cover = json("brand/templates/cover.json");
      cover.slots[0].style = name;
      expect(checked({ "brand/templates/cover.json": cover })).toMatchObject([
        { code: name === "constructor" ? "unknown-style" : "bad-format", path: "/slots/0/style" },
      ]);
    }
  });

  it("are an unknown template, style or slot style in an operation, never a crash", () => {
    for (const name of NAMES) {
      const known = name === "constructor";
      expect(
        apply(brandDoc(), [{ op: "scene.set", id: "context", set: { template: name, layout: null } }]),
      ).toMatchObject({
        ok: false,
        diagnostics: [{ code: known ? "unknown-template" : "bad-format" }],
      });
      expect(
        apply(brandDoc(), [{ op: "block.set", scene: "context", id: heading.id, set: { style: name } }]),
      ).toMatchObject({
        ok: false,
        diagnostics: [{ code: known ? "unknown-style" : "bad-format" }],
      });
      const { id: _, ...template } = json("brand/templates/cover.json");
      template.slots[0].style = name;
      expect(
        apply(brandDoc(), [{ op: "template.set", id: "cover", template: template as never }]),
      ).toMatchObject({
        ok: false,
        diagnostics: [{ code: known ? "unknown-style" : "bad-format" }],
      });
    }
    expect(() => retemplate(brandDoc(), "context", { template: "constructor" })).toThrow(
      /no template "constructor"/,
    );
    expect(() => retemplate(brandDoc(), "constructor", { layout: "title" })).toThrow(
      /no scene "constructor"/,
    );
  });

  it("are a forbidden property of brand.set, deck.set and scene.set, with a fix in words", () => {
    for (const name of NAMES) {
      for (const op of [
        { op: "brand.set", set: fromJson(name) },
        { op: "deck.set", set: fromJson(name) },
        { op: "scene.set", id: "context", set: fromJson(name) },
      ]) {
        const result = apply(brandDoc(), [op as Op]);
        expect(result).toMatchObject({ ok: false, code: "bad-op" });
        if (result.ok) continue;
        const [found] = result.diagnostics;
        expect(found).toMatchObject({ code: "forbidden-property", path: `/0/set/${name}` });
        expect(typeof found?.fix).toBe("string");
      }
      const block = apply(brandDoc(), [
        { op: "block.set", scene: "context", id: heading.id, set: fromJson(name) },
      ]);
      expect(block).toMatchObject({ ok: false, diagnostics: [{ code: "unknown-property" }] });
    }
  });

  it("are left out of a look, never a crash", () => {
    const doc = brandDoc();
    const odd = {
      ...scene,
      template: "constructor",
      blocks: scene.blocks.map((block) => ({ ...block, style: "constructor" })),
    } as Scene;
    const look = lookOf({ ...doc, scenes: { ...doc.scenes, context: odd } });
    expect(Object.keys(look.templates).sort()).toEqual(["chart-and-note", "cover"]);
    expect(Object.keys(look.styles)).not.toContain("constructor");
  });
});

describe("a brand's own files", () => {
  const brand = json(BRAND_FILE);
  const cover = json("brand/templates/cover.json");

  it("leaves brand files deck.json does not name unread, with a warning, and refuses a named brand with no brand.json", () => {
    const deck = json("deck.json");
    const { brand: _, ...unbranded } = deck;
    const welcome = json("scenes/welcome.json");
    welcome.template = "section";
    for (const slotted of welcome.blocks) slotted.slot = slotted.role === "heading" ? "title" : "lede";
    welcome.blocks = welcome.blocks.filter((block: { role: string }) => block.role !== "caption");
    const growth = json("scenes/growth.json");
    delete growth.template;
    growth.layout = "text-media";
    for (const block of growth.blocks) delete block.slot;
    const context = json("scenes/context.json");
    for (const block of context.blocks) if (block.role !== "quote") delete block.style;
    const ignored = loadDoc(
      brandFiles({
        "deck.json": unbranded,
        "scenes/welcome.json": welcome,
        "scenes/growth.json": growth,
        "scenes/context.json": context,
        // Even a broken template is left unread while deck.json names no brand.
        "brand/templates/cover.json": { broken: true },
      }),
    );
    expect(ignored.diagnostics).toMatchObject([
      {
        severity: "warning",
        code: "unused-brand",
        file: BRAND_FILE,
        fix: expect.stringContaining('"brand": "harbor"'),
      },
    ]);
    expect(ignored.doc?.brand).toBeUndefined();
    expect(ignored.doc?.templates).toBeUndefined();
    // Its scenes are checked against Depthcue's own templates and styles alone.
    // (Depthcue's own kicker style is there for it, so only the brand's quiet panel is unknown.)
    expect(errors(checked({ "deck.json": unbranded }))).toEqual([
      "unknown-template",
      "unknown-style",
      "unknown-template",
    ]);
    // A Doc with a brand its deck.json does not name would use it, so there it is an error.
    const doc = brandDoc();
    const { brand: _named, ...nameless } = doc.deck;
    expect(checkDoc({ ...doc, deck: nameless })).toMatchObject([{ severity: "error", code: "unused-brand" }]);
    const bare = checked({
      [BRAND_FILE]: null,
      "brand/templates/cover.json": null,
      "brand/templates/chart-and-note.json": null,
    });
    expect(bare).toMatchObject([{ code: "missing-brand", file: "deck.json", path: "/brand" }]);
  });

  it("refuses a brand whose id is not the deck's, and a template whose id is not its file's", () => {
    expect(errors(checked({ [BRAND_FILE]: { ...brand, id: "harbour" } }))).toEqual(["brand-id-mismatch"]);
    expect(checked({ "brand/templates/cover.json": { ...cover, id: "front" } })).toMatchObject([
      { code: "template-id-mismatch", file: "brand/templates/cover.json", path: "/id" },
    ]);
  });

  it("refuses a template file not named for a template id, and lets no file name reach a prototype", () => {
    for (const name of ["__proto__", "constructor_", "Cover", "x", "has space"]) {
      const file = `brand/templates/${name}.json`;
      expect(isTemplateFile(file)).toBe(true);
      expect(templateIdOf(file)).toBeUndefined();
      const loaded = loadDoc(brandFiles({ [file]: { evil: 1 } }));
      expect(loaded.doc).toBeNull();
      expect(loaded.diagnostics).toMatchObject([
        {
          severity: "error",
          code: "bad-template-name",
          file,
          path: "",
          message: `"${name}" is not a template id, so this file holds no template.`,
          fix: expect.stringContaining("Rename it to the template's id"),
        },
      ]);
    }
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    // A template whose id is "constructor" is a template like any other, and a scene may use it.
    const odd = { ...cover, id: "constructor" };
    const welcome = { ...json("scenes/welcome.json"), template: "constructor" };
    const loaded = loadDoc(
      brandFiles({ "brand/templates/constructor.json": odd, "scenes/welcome.json": welcome }),
    );
    expect(errors(loaded.diagnostics)).toEqual([]);
    expect(Object.hasOwn(loaded.doc?.templates ?? {}, "constructor")).toBe(true);
    expect(isTemplateFile("brand/templates/nested/cover.json")).toBe(false);
    expect(isTemplateFile("brand/brand.json")).toBe(false);
  });

  it("explains a broken brand.json in its own file, and checks the scenes against nothing", () => {
    const colors = { paper: { ...brand.colors.paper, chart: [] } };
    const found = checked({ [BRAND_FILE]: { ...brand, colors, lock: "yes", chart: ["#0B6E6E"] } });
    expect(found).toMatchObject([
      { code: "unknown-property", file: BRAND_FILE, path: "/chart", fix: expect.stringContaining("colors") },
      { code: "too-few", file: BRAND_FILE, path: "/colors/paper/chart" },
      { code: "wrong-type", file: BRAND_FILE, path: "/lock" },
    ]);
  });

  it("refuses a logo, font or image file that is not in the brand folder", () => {
    const fonts = {
      display: {
        family: "Harbor Sans",
        license: "OFL-1.1",
        files: [{ file: "fonts/HS-Bold.woff2", weight: 700, style: "normal" }],
      },
      body: {
        family: "Harbor Text",
        license: "OFL-1.1",
        files: [
          { file: "fonts/HT-Regular.woff2", weight: 400, style: "normal" },
          { file: "fonts/HT-Bold.woff2", weight: 700, style: "normal" },
        ],
      },
      fallback: "modern",
    };
    const photo = { ...cover, background: { color: "text", image: "images/cover.jpg", scrim: 50 } };
    const found = checked(
      { [BRAND_FILE]: { ...brand, fonts }, "brand/templates/cover.json": photo },
      { brandFiles: ["brand/fonts/HT-Regular.woff2", "brand/fonts/HT-Bold.woff2"] },
    );
    expect(found.filter((d) => d.code === "missing-brand-file")).toMatchObject([
      { file: BRAND_FILE, path: "/logos/light" },
      { file: BRAND_FILE, path: "/fonts/display/files/0/file" },
      { file: "brand/templates/cover.json", path: "/background/image" },
    ]);
    expect(found).toContainEqual(
      expect.objectContaining({ code: "background-unmeasured", severity: "warning" }),
    );
  });

  it("refuses logos with no file and a chrome logo without logos", () => {
    expect(errors(checked({ [BRAND_FILE]: { ...brand, logos: { alt: "Harbor" } } }))).toEqual([
      "missing-logo",
    ]);
    const { logos: _, ...noLogos } = brand;
    expect(checked({ [BRAND_FILE]: noLogos })).toMatchObject([
      { code: "missing-logo", path: "/chrome/logo" },
    ]);
  });

  it("warns of a face the deck does not carry, a body face with no bold, and chrome parts in one place", () => {
    const fonts = {
      display: { family: "Harbor Sans", license: "Proprietary" },
      body: {
        family: "Harbor Text",
        license: "OFL-1.1",
        files: [{ file: "fonts/HT-Regular.woff2", weight: 400, style: "normal" }],
      },
      fallback: "classic",
    };
    const chrome = { ...brand.chrome, number: { place: "start" } };
    const found = checked(
      { [BRAND_FILE]: { ...brand, fonts, chrome } },
      { brandFiles: ["brand/logos/harbor.svg", "brand/fonts/HT-Regular.woff2"] },
    );
    expect(found.map((d) => [d.severity, d.code, d.path])).toEqual([
      ["warning", "face-without-files", "/fonts/display"],
      ["warning", "body-without-bold", "/fonts/body/files"],
      ["warning", "chrome-crowded", "/chrome"],
    ]);
  });

  it("asks for a license only for a face whose files the deck carries", () => {
    const files = [{ file: "fonts/HT-Bold.woff2", weight: 700, style: "normal" }];
    const fonts = {
      display: { family: "Harbor Sans" },
      body: { family: "Harbor Text", files },
      fallback: "classic",
    };
    const on = { brandFiles: ["brand/logos/harbor.svg", "brand/fonts/HT-Bold.woff2"] };
    expect(checked({ [BRAND_FILE]: { ...brand, fonts } }, on)).toMatchObject([
      {
        code: "missing-property",
        path: "/fonts/body",
        message: '"files" needs "license" beside it.',
        fix: 'Add "license", or remove "files".',
      },
    ]);
    const licensed = { ...fonts, body: { ...fonts.body, license: "OFL-1.1" } };
    expect(checked({ [BRAND_FILE]: { ...brand, fonts: licensed } }, on)).toMatchObject([
      { severity: "warning", code: "face-without-files", path: "/fonts/display" },
    ]);
  });

  it("refuses a deck palette or font pair while the brand is locked", () => {
    const deck = { ...json("deck.json"), palette: { action: "#0B6E6E" }, fonts: "classic" };
    expect(checked({ "deck.json": deck, [BRAND_FILE]: { ...brand, lock: true } })).toMatchObject([
      { code: "brand-locked", file: "deck.json", path: "/palette" },
      { code: "brand-locked", file: "deck.json", path: "/fonts" },
    ]);
    expect(errors(checked({ "deck.json": deck }))).toEqual([]);
  });

  it("checks the brand's palettes, chart colors and styles for contrast", () => {
    const colors = { paper: { action: "#9FD8D8", chart: ["#0B6E6E", "#F2F2F2"] }, ink: { text: "#333333" } };
    const found = checked({ [BRAND_FILE]: { ...brand, colors } });
    const at = found.filter((d) => d.severity === "error").map((d) => [d.code, d.path]);
    expect(at).toContainEqual(["palette-low-contrast", "/colors/paper/action"]);
    expect(at).toContainEqual(["palette-low-contrast", "/colors/ink/text"]);
    expect(at).toContainEqual(["chart-low-contrast", "/colors/paper/chart/1"]);
    expect(found.find((d) => d.path === "/colors/ink/text")?.message).toMatch(/^On ink slides, /);
    const styles = {
      ...brand.styles,
      faint: { name: "Faint", for: ["body"], tone: "action", fill: "evidence" },
    };
    // The fixture's brand gives a palette for both presets, so the style is checked on both.
    expect(checked({ [BRAND_FILE]: { ...brand, styles } })).toMatchObject([
      {
        code: "style-low-contrast",
        path: "/styles/faint/tone",
        message: expect.stringMatching(/^On paper slides, /),
      },
      {
        code: "style-low-contrast",
        path: "/styles/faint/tone",
        message: expect.stringMatching(/^On ink slides, /),
      },
    ]);
  });

  it("checks chart colors, styles and templates on every preset the brand gives a palette for", () => {
    // The deck is on paper. The brand's ink accent reaches the 3:1 large text needs, not the 4.5:1 of the small
    // kicker or of the cover's text on it, and its ink chart color is as dark as the ink slide.
    const ink = { action: "#C0502A", chart: ["#1A1C20"] };
    const found = checked({ [BRAND_FILE]: { ...brand, colors: { ...brand.colors, ink } } });
    expect(found.map((d) => [d.code, d.file, d.path])).toEqual([
      ["chart-low-contrast", BRAND_FILE, "/colors/ink/chart/0"],
      ["style-low-contrast", BRAND_FILE, "/styles/kicker/tone"],
      ["template-low-contrast", "brand/templates/cover.json", "/background/color"],
    ]);
    expect(found.map((d) => d.message)).toEqual([
      expect.stringContaining("on ink slides"),
      expect.stringMatching(/^On ink slides, /),
      expect.stringContaining("on ink slides"),
    ]);
  });

  it("checks a template's slots, the styles they name and the text on its background", () => {
    const slot = cover.slots[1];
    const bad = {
      ...cover,
      background: { color: "surface" },
      slots: [
        cover.slots[0],
        slot,
        { ...slot, frame: { x: 50, y: 40, w: 60, h: 10 } },
        { ...cover.slots[2], id: "byline", style: "kicker" },
        { ...cover.slots[2], id: "credit", style: "nope", frame: { x: 70, y: 84, w: 20, h: 8 } },
      ],
    };
    const found = checked({ "brand/templates/cover.json": bad });
    expect(found.map((d) => [d.severity, d.code, d.path])).toEqual([
      ["error", "duplicate-id", "/slots/2/id"],
      ["error", "frame-off-slide", "/slots/2/frame"],
      ["warning", "slots-overlap", "/slots/2/frame"],
      ["error", "style-wrong-kind", "/slots/3/style"],
      ["error", "unknown-style", "/slots/4/style"],
    ]);
    const dim = { [BRAND_FILE]: { ...brand, colors: { paper: { action: "#3FA7A7" } } } };
    expect(errors(checked(dim))).toContain("template-low-contrast");
  });

  it("checks the tone of each slot's style on a template's background, a claim slot's and a chart slot's too", () => {
    // cover is on "action". A claim drawn in "action" on it is unreadable, and no block is there for the scene's
    // checks to catch it; a chart slot's blocks are not text, so the scene checks miss it too.
    const styles = {
      ...brand.styles,
      loud: { name: "Loud", for: ["heading", "chart"], tone: "action" },
      light: { name: "Light", for: ["heading"], tone: "bg" },
      panel: { name: "Panel", for: ["chart"], tone: "action", fill: "surface" },
    };
    const frame = (y: number) => ({ x: 8, y, w: 84, h: 8 });
    const banner = (claim: string, chart: string) => ({
      ...cover,
      slots: [
        { id: "claim", role: "claim", frame: frame(8), hint: "The claim.", style: claim },
        {
          id: "chart",
          role: "chart",
          frame: frame(40),
          accepts: ["chart"],
          hint: "The chart.",
          style: chart,
        },
      ],
    });
    const inCover = (template: unknown) =>
      checked({ [BRAND_FILE]: { ...brand, styles }, "brand/templates/cover.json": template }).filter(
        (d) => d.file === "brand/templates/cover.json" && d.severity === "error",
      );
    // Action on action fails on both presets the brand has a palette for.
    const found = inCover(banner("loud", "loud"));
    expect(found.map((d) => [d.code, d.path])).toEqual([
      ["template-low-contrast", "/slots/0/style"],
      ["template-low-contrast", "/slots/0/style"],
      ["template-low-contrast", "/slots/1/style"],
      ["template-low-contrast", "/slots/1/style"],
    ]);
    expect(found[0]?.message).toMatch(/^The slot "claim" draws its claim in "action" .* on paper slides/);
    expect(found[1]?.message).toContain("on ink slides");
    // A tone that reads on the background passes, and a style with a fill is checked on its fill alone.
    expect(inCover(banner("light", "panel"))).toEqual([]);
  });

  it("holds a slot's role and what it accepts to each other, with one claim slot at most", () => {
    const [kicker, title, byline] = cover.slots;
    const frame = (y: number) => ({ x: 8, y, w: 20, h: 5 });
    const slots = [
      { ...title, accepts: ["heading", "body"] },
      { ...byline, role: "picture" },
      { ...kicker, id: "claim", role: "claim" },
      { id: "again", role: "claim", frame: frame(84), hint: "A second claim.", style: "quiet-panel" },
      { ...kicker, id: "any", role: "content", accepts: ["clip", "heading"], frame: frame(90) },
    ];
    const found = checked({ "brand/templates/cover.json": { ...cover, slots } });
    expect(found.filter((d) => d.file === "brand/templates/cover.json")).toMatchObject([
      {
        code: "slot-role-mismatch",
        path: "/slots/0/accepts",
        message: "A title slot takes heading, not body.",
      },
      {
        code: "slot-role-mismatch",
        path: "/slots/1/accepts",
        message: "A picture slot takes image, not body and caption.",
        fix: 'Take body and caption out of "accepts", or make the role "content", which takes any block.',
      },
      {
        code: "slot-role-mismatch",
        path: "/slots/2/accepts",
        message: "A claim slot holds the scene's claim and takes no blocks.",
        fix: 'Remove "accepts", or give the slot another role.',
      },
      { code: "two-claim-slots", path: "/slots/3/role" },
      {
        code: "style-wrong-kind",
        path: "/slots/3/style",
        message: 'The slot draws its claim as heading, which the style "quiet-panel" is not for.',
      },
    ]);
    // Every slot says what it is for, and every slot but a claim slot what it takes.
    const { role: _, ...roleless } = title;
    const { accepts: __, ...open } = title;
    const shape = checked({
      "brand/templates/cover.json": { ...cover, slots: [roleless, open, { ...kicker, valign: "center" }] },
    });
    expect(shape).toMatchObject([
      { code: "missing-property", path: "/slots/0", message: 'Missing "role".' },
      { code: "missing-property", path: "/slots/1", message: 'Missing "accepts".' },
      { code: "bad-value", path: "/slots/2/valign", fix: "Use one of: top, middle, bottom." },
    ]);
  });

  it("ships templates that pass their own checks, one of them with a claim slot", () => {
    const looks = (["paper", "ink"] as const).map((theme) => ({ theme, colors: PRESETS[theme] }));
    for (const template of Object.values(BUILT_IN_TEMPLATES)) {
      expect(checkTemplateFile(template, template.id, "f")).toEqual([]);
      expect(checkTemplate(template, BUILT_IN_STYLES, looks, new Set(), "f")).toEqual([]);
    }
    expect(BUILT_IN_TEMPLATES.statement?.slots[0]).toMatchObject({
      id: "claim",
      role: "claim",
      required: true,
    });
    expect(BUILT_IN_TEMPLATES.statement?.slots[0]?.accepts).toBeUndefined();
  });
});

describe("resolution", () => {
  const part = brandPartOf(brandDoc());
  const mine: Template = { ...BUILT_IN_TEMPLATES.section, name: "Our section" } as Template;

  it("offers Depthcue's templates and styles beside the brand's, the brand's winning on a shared id", () => {
    expect(Object.keys(templatesOf(part)).sort()).toEqual(
      [...Object.keys(BUILT_IN_TEMPLATES), "chart-and-note", "cover"].sort(),
    );
    expect(Object.keys(BUILT_IN_TEMPLATES).sort()).toEqual([
      "agenda",
      "big-number",
      "closing",
      "comparison",
      "full-image",
      "quote",
      "section",
      "statement",
      "title",
      "two-column",
    ]);
    expect(templatesOf({ ...part, templates: { section: mine } }).section?.name).toBe("Our section");
    // The brand's kicker replaces Depthcue's, as a brand's style of the same id does.
    expect(Object.keys(blockStylesOf(part)).sort()).toEqual(
      [...new Set([...Object.keys(BUILT_IN_STYLES), "kicker", "quiet-panel"])].sort(),
    );
    expect(Object.keys(BUILT_IN_STYLES).sort()).toEqual([
      "callout",
      "card",
      "highlight",
      "kicker",
      "label",
      "pull-quote",
      "stat",
    ]);
    expect(blockStylesOf(part).kicker).toEqual(part.brand?.styles?.kicker);
    const callout = { name: "Our callout", for: ["quote"] } as const;
    const brand = { ...part.brand, styles: { callout } } as never;
    expect(blockStylesOf({ brand }).callout).toEqual(callout);
  });

  it("hides Depthcue's own when the brand says so, and offers them to a deck without a brand", () => {
    const brand = { ...part.brand, hideBuiltIn: ["templates", "styles"] } as never;
    expect(Object.keys(templatesOf({ ...part, brand })).sort()).toEqual(["chart-and-note", "cover"]);
    expect(Object.keys(blockStylesOf({ ...part, brand })).sort()).toEqual(["kicker", "quiet-panel"]);
    expect(templatesOf({})).toEqual(BUILT_IN_TEMPLATES);
    expect(blockStylesOf({})).toEqual(BUILT_IN_STYLES);
  });

  it("resolves colors as preset, then the brand's palette for the theme, then the deck's, unless locked", () => {
    const brand = {
      colors: { paper: { action: "#0B6E6E", text: "#111111" }, ink: { action: "#7FD4D4" } },
    } as const;
    const deck = { theme: "paper", palette: { action: "#123456" } } as const;
    const colors = styleOf(deck, brand).colors;
    expect(colors.bg).toBe(PRESETS.paper.bg);
    expect(colors.text).toBe("#111111");
    expect(colors.action).toBe("#123456");
    expect(styleOf(deck, { ...brand, lock: true }).colors.action).toBe("#0B6E6E");
    expect(styleOf({ theme: "ink" }, brand).colors.action).toBe("#7FD4D4");
  });

  it("resolves fonts as the deck's pair, then the brand's pair or fallback, then the default", () => {
    expect(styleOf({ theme: "paper", fonts: "classic" }, { fonts: "technical" }).fonts).toBe("classic");
    expect(styleOf({ theme: "paper", fonts: "classic" }, { fonts: "technical", lock: true }).fonts).toBe(
      "technical",
    );
    const faces = {
      display: { family: "A", license: "x" },
      body: { family: "B", license: "x" },
      fallback: "editorial",
    };
    expect(styleOf({ theme: "paper" }, { fonts: faces } as never).fonts).toBe("editorial");
    expect(styleOf({ theme: "paper" }).fonts).toBe(styleOf({ theme: "paper" }, {}).fonts);
  });
});

describe("lookOf", () => {
  it("gives the player the resolved colors, chart, chrome with the theme's logo, and only what the scenes use", () => {
    const look = lookOf(brandDoc());
    expect(look.theme).toBe("paper");
    expect(look.colors.action).toBe("#0B6E6E");
    expect(look.chart).toEqual(["#0B6E6E", "#2D4BB8", "#B4531F"]);
    expect(Object.keys(look.colors)).not.toContain("chart");
    // Each preset has its own chart colors, which reach 3:1 on its own background.
    const dark = lookOf({ ...brandDoc(), deck: { ...brandDoc().deck, theme: "ink" } });
    expect(dark.chart).toEqual(["#4FC4C4", "#8FA5FF", "#F0A06A"]);
    expect(dark.colors.action).toBe(PRESETS.ink.action);
    expect(look.fonts).toBe("modern");
    // The fixture carries two faces of its own, under family names of its own, over the fallback pair.
    expect(look.faces?.display).toEqual({
      family: "Harbor Display",
      files: [{ path: "brand/fonts/HarborSans-Bold.woff2", weight: 700, style: "normal" }],
    });
    expect(look.faces?.body.family).toBe("Harbor Sans");
    expect(look.faces?.mono).toBeUndefined();
    expect(look.chrome).toEqual({
      logo: { path: "brand/logos/harbor.svg", alt: "Harbor Analytics", corner: "top-end", size: "s" },
      footer: { text: "Harbor Analytics, for internal use", place: "start" },
      number: { place: "end" },
      accent: "top",
    });
    expect(Object.keys(look.templates).sort()).toEqual(["chart-and-note", "cover"]);
    expect(Object.keys(look.styles).sort()).toEqual(["callout", "kicker", "quiet-panel"]);
  });

  it("gives a brand's own faces with deck-relative files, and nothing of a brand to a deck without one", () => {
    const doc = brandDoc();
    const display = {
      family: "Harbor Sans",
      license: "OFL-1.1",
      files: [{ file: "fonts/HS-Bold.woff2", weight: 700, style: "normal" }],
    };
    const brand = { ...doc.brand, fonts: { display, body: display, fallback: "classic" } } as never;
    const look = lookOf({ ...doc, brand });
    expect(look.fonts).toBe("classic");
    expect(look.faces?.display).toEqual({
      family: "Harbor Sans",
      files: [{ path: "brand/fonts/HS-Bold.woff2", weight: 700, style: "normal" }],
    });
    const plain = lookOf(demoDoc());
    expect(plain.chrome).toBeUndefined();
    expect(plain.chart).toEqual([]);
    expect(plain.templates).toEqual({});
  });
});

describe("the revision", () => {
  it("is the same as before brands for every deck without one", () => {
    // Computed by main before schema 0.4 (c530c7b). A change here means every saved base_rev goes stale.
    expect(revisionOf(demoDoc())).toBe("ec4e0cd5c59ef06a");
    const demo = loadDoc(loadDir(brandDir.replace("v0-4-brand", "demo"))).doc as Doc;
    expect(revisionOf(demo)).toBe("eb9d45889adffe19");
  });

  it("covers brand.json and every template, but not how the files are formatted", () => {
    const doc = brandDoc();
    const renamed = applied(doc, [{ op: "brand.set", set: { name: "Harbor" } }]);
    expect(revisionOf(renamed)).not.toBe(revisionOf(doc));
    const cover = { ...(doc.templates?.cover as Template), description: "Another." };
    const retitled = applied(doc, [{ op: "template.set", id: "cover", template: cover }]);
    expect(revisionOf(retitled)).not.toBe(revisionOf(doc));
    const reordered = { ...doc, brand: Object.fromEntries(Object.entries(doc.brand ?? {}).reverse()) } as Doc;
    expect(revisionOf(reordered)).toBe(revisionOf(doc));
  });

  it("refuses an edit based on the revision before a brand change", () => {
    const doc = brandDoc();
    const renamed = applied(doc, [{ op: "brand.set", set: { name: "Harbor" } }]);
    const late = applyOps(renamed, [{ op: "scene.set", id: "growth", set: { title: "G" } }], revisionOf(doc));
    expect(late).toMatchObject({ ok: false, code: "stale-revision" });
  });
});

describe("brand.set", () => {
  it("makes a brand on a deck without one, from an id and a name, and names it in deck.json", () => {
    const result = apply(demoDoc(), [{ op: "brand.set", set: { id: "acme", name: "Acme" } }]);
    expect(result).toMatchObject({ ok: true, deckChanged: true, brandChanged: true });
    if (!result.ok) return;
    expect(result.doc.deck).toMatchObject({ brand: "acme", schemaVersion: "0.4" });
    expect(JSON.parse(docToFiles(result.doc)[BRAND_FILE] as string)).toEqual({
      schemaVersion: "0.4",
      id: "acme",
      name: "Acme",
    });
    expect(apply(demoDoc(), [{ op: "brand.set", set: { name: "Acme" } }])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "missing-property", message: 'A new brand needs "id".' }],
    });
  });

  it("changes fields, removes one with null, and refuses a new id, styles and unknown keys", () => {
    const doc = applied(brandDoc(), [{ op: "brand.set", set: { name: "Harbor", chrome: null, lock: true } }]);
    expect(doc.brand).toMatchObject({ name: "Harbor", lock: true });
    expect(doc.brand?.chrome).toBeUndefined();
    const refused = (set: Record<string, unknown>) => apply(brandDoc(), [{ op: "brand.set", set } as Op]);
    expect(refused({ id: "other" })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "forbidden-property" }],
    });
    expect(refused({ styles: {} })).toMatchObject({
      diagnostics: [{ code: "forbidden-property", fix: "Use style.set, one style at a time." }],
    });
    expect(refused({ colour: {} })).toMatchObject({ diagnostics: [{ fix: 'Did you mean "colors"?' }] });
  });

  it("checks the brand it writes, in brand.json", () => {
    const colors = { paper: { chart: ["#0B6E6E", "red"] } };
    expect(apply(brandDoc(), [{ op: "brand.set", set: { colors } }])).toMatchObject({
      ok: false,
      code: "invalid-deck",
      diagnostics: [{ code: "bad-format", file: BRAND_FILE, path: "/colors/paper/chart/1" }],
    });
  });

  it("takes the brand off with null: brand.json, the templates and deck.json's brand, keeping the binaries", () => {
    const doc = brandDoc();
    const unused = applied(doc, [
      { op: "scene.set", id: "welcome", set: { template: "section" } },
      { op: "block.set", scene: "welcome", id: "welcome-byline", set: { slot: "lede" } },
      { op: "scene.set", id: "growth", set: { template: null, layout: "claim-evidence" } },
      ...retemplate(doc, "growth", { layout: "claim-evidence" }).ops.slice(1),
      { op: "block.set", scene: "context", id: "context-kicker", set: { style: null } },
      { op: "block.set", scene: "context", id: "context-body", set: { style: null } },
    ]);
    const result = apply(unused, [{ op: "brand.set", set: null }]);
    expect(result).toMatchObject({ ok: true, brandChanged: true });
    if (!result.ok) return;
    expect(result.doc.deck.brand).toBeUndefined();
    expect(Object.keys(docToFiles(result.doc)).filter((path) => path.startsWith("brand/"))).toEqual([]);
    expect([...(result.doc.brandFiles ?? [])]).toEqual(FIXTURE_BRAND_FILES);
    expect(apply(brandDoc(), [{ op: "brand.set", set: null }])).toMatchObject({
      ok: false,
      code: "invalid-deck",
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "unknown-template" })]),
    });
    expect(apply(demoDoc(), [{ op: "brand.set", set: null }])).toMatchObject({
      diagnostics: [{ code: "no-brand" }],
    });
  });

  it("cannot be done with deck.set", () => {
    expect(apply(brandDoc(), [{ op: "deck.set", set: { brand: "other" } } as Op])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "forbidden-property", fix: expect.stringContaining("Use brand.set") }],
    });
  });
});

describe("style.set and template.set", () => {
  const quiet: BlockStyle = { name: "Quiet", for: ["body"], tone: "muted" };

  it("write, replace and remove a style by id, and need a brand", () => {
    const added = applied(brandDoc(), [{ op: "style.set", id: "quiet", style: quiet }]);
    expect(added.brand?.styles?.quiet).toEqual(quiet);
    const replaced = applied(added, [{ op: "style.set", id: "quiet", style: { ...quiet, tone: "text" } }]);
    expect(replaced.brand?.styles?.quiet?.tone).toBe("text");
    const removed = applied(replaced, [{ op: "style.set", id: "quiet", style: null }]);
    expect(removed.brand?.styles?.quiet).toBeUndefined();
    expect(apply(removed, [{ op: "style.set", id: "quiet", style: null }])).toMatchObject({
      diagnostics: [{ code: "unknown-style" }],
    });
    expect(apply(demoDoc(), [{ op: "style.set", id: "quiet", style: quiet }])).toMatchObject({
      diagnostics: [{ code: "no-brand", fix: expect.stringContaining("brand.set") }],
    });
  });

  it("refuse removing a style a block uses, on the result", () => {
    expect(apply(brandDoc(), [{ op: "style.set", id: "quiet-panel", style: null }])).toMatchObject({
      ok: false,
      code: "invalid-deck",
      diagnostics: [
        { code: "unknown-style", file: "brand/templates/chart-and-note.json", path: "/slots/2/style" },
        { code: "unknown-style", file: "scenes/context.json", path: "/blocks/2/style" },
      ],
    });
  });

  it("let a block fall back to Depthcue's own style when the brand's one of the same id is removed", () => {
    const result = apply(brandDoc(), [{ op: "style.set", id: "kicker", style: null }]);
    expect(result).toMatchObject({ ok: true, brandChanged: true });
    if (!result.ok) return;
    expect(blockStylesOf(brandPartOf(result.doc)).kicker).toEqual(BUILT_IN_STYLES.kicker);
  });

  it("write a template with its id and version filled in, and refuse one that says another id", () => {
    const section = BUILT_IN_TEMPLATES.section as Template;
    const { id: _, schemaVersion: __, ...body } = section;
    const result = apply(brandDoc(), [{ op: "template.set", id: "big-title", template: body }]);
    expect(result).toMatchObject({ ok: true, brandChanged: true, deckChanged: false });
    if (!result.ok) return;
    expect(JSON.parse(docToFiles(result.doc)["brand/templates/big-title.json"] as string)).toMatchObject({
      schemaVersion: "0.4",
      id: "big-title",
    });
    expect(apply(brandDoc(), [{ op: "template.set", id: "big-title", template: section }])).toMatchObject({
      diagnostics: [{ code: "template-id-mismatch", path: "/0/template/id" }],
    });
  });

  it("remove a template, and refuse it on the result while a scene uses it", () => {
    expect(apply(brandDoc(), [{ op: "template.set", id: "cover", template: null }])).toMatchObject({
      ok: false,
      code: "invalid-deck",
      diagnostics: [{ code: "unknown-template", file: "scenes/welcome.json" }],
    });
    const moved = applied(brandDoc(), [
      ...retemplate(brandDoc(), "welcome", { template: "section" }).ops,
      { op: "template.set", id: "cover", template: null },
    ]);
    expect(Object.keys(docToFiles(moved))).not.toContain("brand/templates/cover.json");
  });

  it("explain a broken template in its own file", () => {
    const result = apply(brandDoc(), [
      { op: "template.set", id: "empty", template: { name: "E", slots: [] } as never },
    ]);
    expect(result).toMatchObject({
      ok: false,
      code: "invalid-deck",
      diagnostics: [
        { code: "missing-property", file: "brand/templates/empty.json" },
        { code: "too-few", file: "brand/templates/empty.json", path: "/slots" },
      ],
    });
  });
});

describe("slots and templates through block.set and scene.set", () => {
  it("raises an older scene to 0.4 when it gains a template, a slot or a style", () => {
    const doc = demoDoc();
    expect(doc.scenes.opening?.schemaVersion).toBe("0.1");
    const moved = retemplate(doc, "opening", { template: "section" });
    expect(moved).toEqual({
      ops: [
        { op: "scene.set", id: "opening", set: { template: "section", layout: null } },
        { op: "block.set", scene: "opening", id: "opening-title", set: { slot: "title" } },
        { op: "block.set", scene: "opening", id: "opening-sub", set: { slot: "lede" } },
      ],
      unplaced: [],
    });
    const opening = applied(doc, moved.ops).scenes.opening as Scene;
    expect(opening).toMatchObject({ schemaVersion: "0.4", template: "section" });
    expect(opening.layout).toBeUndefined();
    expect(
      apply(doc, [{ op: "block.set", scene: "demand", id: "chart-demand", set: { style: "callout" } }]),
    ).toMatchObject({
      ok: false,
      code: "invalid-deck",
      diagnostics: [{ code: "style-wrong-kind", file: "scenes/demand.json", path: "/blocks/0/style" }],
    });
    const quote = applied(doc, [
      {
        op: "block.add",
        scene: "opening",
        block: { id: "opening-quote", type: "text", role: "quote", text: "Hi", style: "callout" } as never,
      },
    ]);
    expect(quote.scenes.opening?.schemaVersion).toBe("0.4");
  });

  it("reads text written in the same operations as markup, whether the template or the slots came first", () => {
    const doc = demoDoc();
    const { ops } = retemplate(doc, "opening", { template: "section" });
    const [moveScene, ...slots] = ops as [Op, ...Op[]];
    const text: Op = { op: "block.set", scene: "opening", id: "opening-sub", set: { text: "**bold**" } };
    for (const order of [
      [moveScene, text, ...slots],
      [moveScene, ...slots, text],
      [...slots, moveScene, text],
    ]) {
      const result = apply(doc, order);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const sub = result.doc.scenes.opening?.blocks.find((block) => block.id === "opening-sub");
      expect(sub).toMatchObject({ text: "**bold**" });
      expect(codes(result.diagnostics)).not.toContain("text-is-literal");
    }
  });

  it("writes new scenes as 0.4", () => {
    const doc = applied(demoDoc(), [
      {
        op: "scene.add",
        scene: {
          id: "fresh",
          title: "Fresh",
          template: "section",
          blocks: [{ id: "fresh-title", type: "text", role: "heading", text: "Part two", slot: "title" }],
        } as never,
      },
    ]);
    expect(doc.scenes.fresh?.schemaVersion).toBe("0.4");
  });
});

describe("retemplate", () => {
  it("moves a layout scene into a template's slots by kind and order, and the result is valid", () => {
    const doc = brandDoc();
    const { ops, unplaced } = retemplate(doc, "context", { template: "section" });
    expect(unplaced).toEqual(["context-quote"]);
    expect(ops[0]).toEqual({ op: "scene.set", id: "context", set: { template: "section", layout: null } });
    expect(ops.slice(1)).toEqual([
      { op: "block.set", scene: "context", id: "context-kicker", set: { slot: "kicker" } },
      { op: "block.set", scene: "context", id: "context-heading", set: { slot: "title" } },
      { op: "block.set", scene: "context", id: "context-body", set: { slot: "lede" } },
    ]);
    // The block no slot takes is still there, so the move is refused until someone decides about it.
    expect(apply(doc, ops)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "missing-slot" })]),
    });
    // The kicker's accent is not readable on the section's dark background, so it gives up its style too.
    expect(apply(doc, [{ op: "block.remove", scene: "context", id: "context-quote" }, ...ops])).toMatchObject(
      {
        ok: false,
        diagnostics: [{ code: "block-low-contrast", path: "/blocks/0/style" }],
      },
    );
    const decided = applied(doc, [
      { op: "block.remove", scene: "context", id: "context-quote" },
      { op: "block.set", scene: "context", id: "context-kicker", set: { style: null } },
      ...ops,
    ]);
    expect(decided.scenes.context?.blocks.map((block) => block.slot)).toEqual(["kicker", "title", "lede"]);
  });

  it("keeps the claim and its evidence in a template's claim slot, and lists it when there is none", () => {
    const summary = { id: "context-claim", text: "Two *berths* were shut.", evidenceIds: ["context-body"] };
    const doc = applied(brandDoc(), [
      ...retemplate(brandDoc(), "context", { layout: "claim-evidence" }).ops,
      { op: "scene.set", id: "context", set: { summary } },
    ]);
    const kept = retemplate(doc, "context", { template: "statement" });
    expect(kept.ops).toEqual([
      { op: "scene.set", id: "context", set: { template: "statement", layout: null } },
      { op: "block.set", scene: "context", id: "context-kicker", set: { slot: "evidence" } },
      { op: "block.set", scene: "context", id: "context-body", set: { slot: "evidence" } },
      { op: "block.set", scene: "context", id: "context-quote", set: { slot: "evidence" } },
    ]);
    // The heading has no slot here; the claim needs none of a block's.
    expect(kept.unplaced).toEqual(["context-heading"]);
    const moved = applied(doc, [
      { op: "block.remove", scene: "context", id: "context-heading" },
      ...kept.ops,
    ]);
    expect(moved.scenes.context?.summary).toEqual(summary);
    expect(moved.scenes.context?.blocks.map((block) => block.id)).not.toContain("context-claim");

    // A template with no claim slot lists the claim first, and the move applies once it is decided.
    const none = retemplate(doc, "context", { template: "two-column" });
    expect(none.unplaced).toEqual(["context-claim"]);
    expect(
      none.ops.some((op) => op.op === "block.add" || (op.op === "scene.set" && "summary" in op.set)),
    ).toBe(false);
    expect(apply(doc, none.ops)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "claim-without-slot", path: "/summary" })],
    });
    const decided = apply(doc, [{ op: "scene.set", id: "context", set: { summary: null } }, ...none.ops]);
    expect(decided).toMatchObject({ ok: true });
  });

  it("lists the claim when moving to a layout that does not draw one, and only then", () => {
    const summary = { id: "context-claim", text: "Two berths were shut.", evidenceIds: ["context-body"] };
    const doc = applied(brandDoc(), [
      ...retemplate(brandDoc(), "context", { template: "statement" }).ops,
      { op: "scene.set", id: "context", set: { summary } },
      { op: "block.remove", scene: "context", id: "context-heading" },
    ]);
    expect(retemplate(doc, "context", { layout: "text-media" }).unplaced).toEqual(["context-claim"]);
    expect(retemplate(doc, "context", { layout: "title" }).unplaced).toEqual(["context-claim"]);
    expect(retemplate(doc, "context", { layout: "claim-evidence" }).unplaced).toEqual([]);
    expect(retemplate(brandDoc(), "growth", { layout: "text-media" }).unplaced).toEqual([]);
  });

  it("gives a pinned block a slot with room like any other, and keeps one no slot takes pinned over the slots", () => {
    const frame = { x: 60, y: 30, w: 35, h: 50 };
    // A pinned chart that no slot of section takes stays pinned, out of its old slot, instead of being left over.
    const pinned = applied(brandDoc(), [{ op: "block.frame", scene: "growth", id: "growth-chart", frame }]);
    const moved = retemplate(pinned, "growth", { template: "section" });
    expect(moved).toEqual({
      ops: [
        { op: "scene.set", id: "growth", set: { template: "section", layout: null } },
        { op: "block.set", scene: "growth", id: "growth-chart", set: { slot: null } },
        { op: "block.set", scene: "growth", id: "growth-note", set: { slot: "lede" } },
      ],
      unplaced: [],
    });
    expect(applied(pinned, moved.ops).scenes.growth?.blocks.map((block) => block.slot)).toEqual([
      "title",
      undefined,
      "lede",
    ]);
    // A pinned heading takes the title's one place, so the heading after it has none.
    const headings = applied(brandDoc(), [
      { op: "block.frame", scene: "context", id: "context-heading", frame },
      {
        op: "block.add",
        scene: "context",
        block: { id: "context-more", type: "text", role: "heading", text: "More" } as never,
      },
    ]);
    const crowded = retemplate(headings, "context", { template: "section" });
    expect(crowded.ops).toContainEqual({
      op: "block.set",
      scene: "context",
      id: "context-heading",
      set: { slot: "title" },
    });
    expect(crowded.unplaced).toEqual(["context-quote", "context-more"]);
    // A block already pinned over a template's slots stays over the new one's, though a slot would take it.
    const overlay = { id: "badge", type: "text", role: "body", text: "New", frame } as never;
    const welcome = applied(brandDoc(), [{ op: "block.add", scene: "welcome", block: overlay }]);
    const columns = retemplate(welcome, "welcome", { template: "two-column" });
    expect(columns.unplaced).toEqual([]);
    expect(columns.ops.filter((op) => op.op === "block.set" && op.id === "badge")).toEqual([]);
  });

  it("keeps a block in a slot of the same id, and moves a scene back to a layout by clearing slots", () => {
    const doc = brandDoc();
    const { ops } = retemplate(doc, "growth", { template: "two-column" });
    expect(ops).toContainEqual({
      op: "scene.set",
      id: "growth",
      set: { template: "two-column", layout: null },
    });
    expect(ops.find((op) => op.op === "block.set" && op.id === "growth-title")).toBeUndefined();
    const back = retemplate(doc, "growth", { layout: "title" });
    expect(back.unplaced).toEqual([]);
    expect(back.ops.filter((op) => op.op === "block.set")).toHaveLength(3);
  });

  it("throws for a scene or a template the deck does not have", () => {
    expect(() => retemplate(brandDoc(), "nope", { layout: "title" })).toThrow(/no scene "nope"/);
    expect(() => retemplate(brandDoc(), "growth", { template: "nope" })).toThrow(/no template "nope"/);
  });
});

describe("drafts and reviews of a branded deck", () => {
  it("keep the brand and its templates in a draft, and recover them", () => {
    const doc = applied(brandDoc(), [{ op: "brand.set", set: { name: "Harbor" } }]);
    const store = memoryDraftStore();
    store.write(serializeDraft({ doc, rev: revisionOf(doc), savedRev: revisionOf(brandDoc()) }, new Date(0)));
    const recovery = recoverDraft(store, {
      assets: doc.assets,
      brandFiles: doc.brandFiles ?? new Set(),
      savedRev: revisionOf(brandDoc()),
    });
    expect(recovery).toMatchObject({ status: "found", rev: revisionOf(doc), diskChanged: false });
    if (recovery.status !== "found") return;
    expect(recovery.doc.brand?.name).toBe("Harbor");
    expect(Object.keys(recovery.doc.templates ?? {}).sort()).toEqual(["chart-and-note", "cover"]);
    expect([...(recovery.doc.brandFiles ?? [])]).toEqual(FIXTURE_BRAND_FILES);
  });

  it("read back a review of a branded deck, list the brand's changes with the scene's, and accept them", () => {
    const review = startReview(brandDoc());
    const read = readReview(reviewToText(review));
    expect(read).toMatchObject({ ok: true, review: { brand: { id: "harbor" } } });
    const changed = applied(brandDoc(), [
      { op: "brand.set", set: { name: "Harbor" } },
      { op: "scene.set", id: "growth", set: { title: "Growth, by berth" } },
    ]);
    const changes = reviewChanges(review, changed);
    expect(changes.map((change) => change.id)).toEqual(["deck/brand", "scene:growth/title"]);
    const accepted = acceptChanges(review, changed, "all");
    expect(accepted).toMatchObject({ ok: true, accepted: ["deck/brand", "scene:growth/title"] });
    if (accepted.ok) expect(accepted.review.brand?.name).toBe("Harbor");
  });

  it("refuse a review file whose brand is broken", () => {
    const review = { ...startReview(brandDoc()), brand: { id: "harbor" } };
    expect(readReview(JSON.stringify(review))).toEqual({
      ok: false,
      diagnostics: ["schemaVersion", "name"].map((property) => ({
        severity: "error",
        code: "missing-property",
        file: "review.json",
        path: "/brand",
        message: `Missing "${property}".`,
        fix: `Add "${property}".`,
      })),
    });
  });
});
