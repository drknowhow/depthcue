import { BLOCK_KINDS, BRAND_LIMITS, FRAME_MIN } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { importBrand } from "../src/brand-import/index.ts";
import { frameOf, trimmed } from "../src/brand-import/templates.ts";
import {
  EMF,
  importFixture,
  jpeg,
  type LayoutSpec,
  LIGHT,
  MASTER,
  type PackageSpec,
  PNG,
  type ShapeSpec,
  temporaryFolders,
  writeFixture,
} from "./brand-import-fixtures.ts";

const make = temporaryFolders();

type Frame = { x: number; y: number; w: number; h: number };
type Ph = Extract<ShapeSpec, { kind: "ph" }>;

const ph = (type: string | undefined, frame: Frame | undefined, extra: Partial<Ph> = {}): ShapeSpec =>
  ({
    kind: "ph",
    ...(type === undefined ? {} : { type }),
    ...(frame ? { frame } : {}),
    ...extra,
  }) as ShapeSpec;

/** A layout with a title across the top and these shapes. */
const layout = (name: string, shapes: ShapeSpec[], extra: Partial<LayoutSpec> = {}): LayoutSpec => ({
  name,
  shapes: [ph("title", { x: 8, y: 6, w: 78, h: 16 }), ...shapes],
  ...extra,
});

const only = (layouts: LayoutSpec[], extra: PackageSpec = {}): PackageSpec => ({ layouts, ...extra });

/** The left-out entries that concern a layout. */
const skippedLayouts = (left: Array<{ what: string; why: string }>) =>
  left.filter((item) => item.what.startsWith("The layout"));

describe("the templates of an import", () => {
  it("makes a template of each layout, with an id from its name", async () => {
    const done = await importFixture(make);
    expect(done.report.templates.map((template) => [template.id, template.name, template.layout])).toEqual([
      ["title-slide", "Title Slide", "Title Slide"],
      ["title-and-content", "Title and Content", "Title and Content"],
      ["two-content", "Two Content", "Two Content"],
    ]);
    expect(done.report.files).toEqual(
      [
        ".depthcue-brand-import",
        "brand.json",
        "logos/logo.png",
        "templates/title-slide.json",
        "templates/title-and-content.json",
        "templates/two-content.json",
      ].sort(),
    );
  });

  it("writes the title slide's slots with the role, frame, vertical place and hint the layout gives", async () => {
    const done = await importFixture(make);
    expect(done.json("templates/title-slide.json")).toEqual({
      schemaVersion: "0.4",
      id: "title-slide",
      name: "Title Slide",
      description: 'The PowerPoint layout "Title Slide", with the slots title, subtitle.',
      slots: [
        {
          id: "title",
          role: "title",
          frame: { x: 10, y: 28, w: 80, h: 24 },
          accepts: ["heading"],
          required: true,
          valign: "bottom",
          hint: "The slide's title, in a few words.",
        },
        {
          id: "subtitle",
          role: "subtitle",
          frame: { x: 10, y: 56, w: 80, h: 14 },
          accepts: ["body"],
          hint: "Who presents, and when",
        },
      ],
    });
  });

  it("takes a placeholder's place from the master's when the layout gives none", async () => {
    const done = await importFixture(make);
    const slots = done.json("templates/title-and-content.json").slots;
    expect(slots[0]).toMatchObject({ id: "title", role: "title", frame: { x: 8, y: 6, w: 78, h: 16 } });
    expect(slots[1]).toMatchObject({ id: "content", role: "content", frame: { x: 8, y: 26, w: 84, h: 60 } });
    expect(slots[1].accepts).toEqual([...BLOCK_KINDS]);
    const two = done.json("templates/two-content.json").slots;
    expect(two.map((slot: { id: string }) => slot.id)).toEqual(["title", "content", "content-2"]);
    expect(two[2].frame).toEqual({ x: 51, y: 26, w: 41, h: 60 });
  });

  it("gives the slot a role and the blocks it takes from the placeholder's type", async () => {
    const grid = (n: number): Frame => ({
      x: 4 + (n % 4) * 24,
      y: 26 + Math.floor(n / 4) * 30,
      w: 22,
      h: 26,
    });
    const done = await importFixture(
      make,
      only([
        layout("Types", [
          ph("ctrTitle", grid(0)),
          ph("subTitle", grid(1)),
          ph("body", grid(2)),
          ph("pic", grid(3)),
          ph("chart", grid(4)),
          ph("tbl", grid(5)),
          ph(undefined, grid(6)),
          ph("obj", grid(7)),
        ]),
      ]),
    );
    const slots = done.report.templates[0]?.slots ?? [];
    expect(slots.map((slot) => [slot.placeholder, slot.id, slot.role, slot.accepts.join()])).toEqual([
      ["title", "title", "title", "heading"],
      ["ctrTitle", "title-2", "title", "heading"],
      ["subTitle", "subtitle", "subtitle", "body"],
      ["body", "body", "body", "body"],
      ["pic", "picture", "picture", "image"],
      ["chart", "chart", "chart", "chart"],
      ["tbl", "table", "table", "table"],
      ["obj", "content", "content", BLOCK_KINDS.join()],
      ["obj", "content-2", "content", BLOCK_KINDS.join()],
    ]);
  });

  it("makes a placeholder type with no slot of its own a content slot, and says so", async () => {
    const done = await importFixture(
      make,
      only([layout("Video", [ph("media", { x: 8, y: 26, w: 84, h: 60 })])]),
    );
    expect(done.report.templates[0]?.slots[1]).toMatchObject({ role: "content", placeholder: "media" });
    expect(done.report.notes).toContain(
      "Placeholders of the type media became content slots, which take any block.",
    );
  });

  it("requires a title slot, and nothing else", async () => {
    const done = await importFixture(make);
    for (const id of ["title-slide", "title-and-content", "two-content"]) {
      const slots = done.json(`templates/${id}.json`).slots as Array<{ role: string; required?: boolean }>;
      expect(slots.filter((slot) => slot.required).map((slot) => slot.role)).toEqual(["title"]);
    }
  });

  it("never makes a claim slot, and says PowerPoint has none", async () => {
    const done = await importFixture(make);
    expect(
      done.report.templates.flatMap((template) => template.slots).some((slot) => slot.role === "claim"),
    ).toBe(false);
    expect(done.report.left.find((item) => item.what === "Claim slots")?.why).toMatch(
      /PowerPoint has no placeholder for a claim/,
    );
  });

  describe("the vertical place of the text", () => {
    const valigns = async (spec: PackageSpec) =>
      (await importFixture(make, spec)).report.templates[0]?.slots.map((slot) => [slot.id, slot.valign]);

    it("comes from the anchor of the layout's placeholder", async () => {
      const grid = (n: number): Frame => ({ x: 4 + n * 31, y: 26, w: 29, h: 60 });
      expect(
        await valigns(
          only([
            layout("Anchors", [
              ph("body", grid(0), { anchor: "t" }),
              ph("body", grid(1), { anchor: "ctr" }),
              ph("body", grid(2), { anchor: "b" }),
            ]),
          ]),
        ),
      ).toEqual([
        ["title", undefined],
        ["body", undefined],
        ["body-2", "middle"],
        ["body-3", "bottom"],
      ]);
    });

    it("comes from the master's placeholder when the layout's has none", async () => {
      const master: ShapeSpec[] = [
        ph("title", { x: 8, y: 6, w: 78, h: 16 }, { anchor: "b" }),
        ph("body", { x: 8, y: 26, w: 84, h: 60 }, { idx: 1, anchor: "ctr" }),
      ];
      expect(
        await valigns(
          only([{ name: "Plain", shapes: [ph("title", undefined), ph(undefined, undefined, { idx: 1 })] }], {
            master,
          }),
        ),
      ).toEqual([
        ["title", "bottom"],
        ["content", "middle"],
      ]);
    });

    it("is the layout's own when it differs from the master's", async () => {
      const master: ShapeSpec[] = [ph("title", { x: 8, y: 6, w: 78, h: 16 }, { anchor: "b" })];
      expect(
        await valigns(
          only([{ name: "Own", shapes: [ph("title", undefined, { anchor: "ctr" })] }], { master }),
        ),
      ).toEqual([["title", "middle"]]);
    });
  });

  describe("the hint", () => {
    const hintOf = async (text: string | undefined) => {
      const done = await importFixture(
        make,
        only([
          layout("Hints", [ph("body", { x: 8, y: 26, w: 84, h: 60 }, text === undefined ? {} : { text })]),
        ]),
      );
      return done.report.templates[0]?.slots[1]?.hint;
    };

    it("is the placeholder's prompt text", async () => {
      expect(await hintOf("Add the three numbers that matter")).toBe("Add the three numbers that matter");
    });

    it("is the role's own words when the prompt is PowerPoint's stock one or there is none", async () => {
      expect(await hintOf("Click to edit Master text styles")).toBe("The text of the slide.");
      expect(await hintOf("click here")).toBe("The text of the slide.");
      expect(await hintOf(undefined)).toBe("The text of the slide.");
    });

    it("is cut at the length a hint may be", async () => {
      expect((await hintOf("x".repeat(400)))?.length).toBe(BRAND_LIMITS.hint);
    });
  });

  describe("the id and name", () => {
    const ids = async (names: string[]) => {
      const done = await importFixture(make, only(names.map((name) => layout(name, []))));
      return done.report.templates.map((template) => template.id);
    };

    it("is the layout's name as a lower case slug", async () => {
      expect(await ids(["Title & Content!", "  Two  Columns  ", "Café Menu"])).toEqual([
        "title-content",
        "two-columns",
        "cafe-menu",
      ]);
    });

    it("gets a number when a name is used twice", async () => {
      expect(await ids(["Title", "Title", "Title"])).toEqual(["title", "title-2", "title-3"]);
    });

    it("starts with a letter, and falls back to layout when the name has none", async () => {
      expect(await ids(["123", "Заголовок", "7 steps"])).toEqual(["layout-123", "layout", "layout-7-steps"]);
    });

    it("says when an id is one of Depthcue's own templates", async () => {
      const done = await importFixture(make, only([layout("Section", []), layout("Statement", [])]));
      expect(done.report.notes).toContain(
        'The template "section" has the id of one of Depthcue\'s own, so decks of this brand get yours instead.',
      );
      expect(done.report.notes).toContain(
        'The template "statement" has the id of one of Depthcue\'s own, so decks of this brand get yours instead.',
      );
    });

    it("keeps the name within the length a name may be", async () => {
      const done = await importFixture(make, only([layout("N".repeat(80), [])]));
      expect(done.report.templates[0]?.name).toHaveLength(BRAND_LIMITS.styleName);
    });

    it("is the part's file name when the layout has no name", async () => {
      const done = await importFixture(make, only([layout("", [])]));
      expect(done.report.templates[0]?.layout).toBe("slideLayout1");
      expect(done.report.templates[0]?.id).toBe("slidelayout1");
    });
  });

  describe("a layout that is not a template", () => {
    const skippedFor = async (layouts: LayoutSpec[], spec: PackageSpec = {}) => {
      const done = await importFixture(
        make,
        only([...layouts, layout("Fine", [ph("body", { x: 8, y: 26, w: 84, h: 60 })])], spec),
      );
      expect(done.report.templates.map((template) => template.layout)).toEqual(["Fine"]);
      return skippedLayouts(done.report.left);
    };

    it("is skipped when it has nothing to make a slot from", async () => {
      expect(await skippedFor([{ name: "Blank", shapes: [] }])).toEqual([
        {
          what: 'The layout "Blank"',
          why: "it is not a template: it has no placeholder a slot can be made from (a blank layout)",
        },
      ]);
    });

    it("is skipped when it has more placeholders than a template holds slots", async () => {
      const crowded = Array.from({ length: BRAND_LIMITS.slots + 1 }, (_, n) =>
        ph("body", { x: 2 + (n % 6) * 16, y: 26 + Math.floor(n / 6) * 30, w: 14, h: 26 }),
      );
      const [item] = await skippedFor([{ name: "Crowded", shapes: crowded }]);
      expect(item?.why).toBe(
        `it is not a template: it has ${BRAND_LIMITS.slots + 1} placeholders, and a template holds at most ${BRAND_LIMITS.slots} slots`,
      );
    });

    it("is skipped when a slot lies off the slide", async () => {
      const [item] = await skippedFor([layout("Off", [ph("body", { x: 60, y: 26, w: 50, h: 60 })])]);
      expect(item?.why).toBe(
        'it is not a template: the slot "body" runs off the slide (to 110% across and 86% down), and a slot must lie on it',
      );
    });

    it("is skipped when a slot lies wholly above the slide", async () => {
      const [item] = await skippedFor([layout("Above", [ph("body", { x: 8, y: -20, w: 40, h: 15 })])]);
      expect(item?.why).toMatch(/the slot "body" runs off the slide \(to 48% across and -5% down\)/);
    });

    it("is skipped when two slots overlap by more than a percent of the slide", async () => {
      const [item] = await skippedFor([
        layout("Overlap", [
          ph("body", { x: 8, y: 24, w: 40, h: 40 }),
          ph("body", { x: 40, y: 50, w: 40, h: 40 }),
        ]),
      ]);
      expect(item?.why).toBe(
        'it is not a template: the slots "body" and "body-2" overlap, and a template\'s slots do not',
      );
    });

    it.each([
      ["vert", "vertically"],
      ["eaVert", "vertically"],
      ["vert270", "vertically"],
    ])("is skipped when a placeholder runs its text %s", async (vert) => {
      const [item] = await skippedFor([
        layout("Vertical", [ph("body", { x: 8, y: 26, w: 84, h: 60 }, { vert })]),
      ]);
      expect(item?.why).toBe(
        `it is not a template: the placeholder "body 3" (text direction ${vert}) runs its text vertically, which Depthcue does not draw`,
      );
    });

    it("is skipped when the master's placeholder runs its text vertically and the layout's does not say otherwise", async () => {
      const master: ShapeSpec[] = [ph("body", { x: 8, y: 26, w: 84, h: 60 }, { idx: 1, vert: "eaVert" })];
      const done = await importFixture(
        make,
        only(
          [
            { name: "Inherits", shapes: [ph(undefined, undefined, { idx: 1 })] },
            { name: "Overrides", shapes: [ph(undefined, undefined, { idx: 1, vert: "horz" })] },
          ],
          { master },
        ),
      );
      expect(done.report.templates.map((template) => template.layout)).toEqual(["Overrides"]);
      expect(skippedLayouts(done.report.left)[0]?.why).toMatch(/runs its text vertically/);
    });
  });

  describe("a slot close to the edge or to another slot", () => {
    it("is trimmed to the edge when it passes by half a percent or less, and the report says so", async () => {
      const done = await importFixture(
        make,
        only([layout("Bleed", [ph("pic", { x: 50, y: 26, w: 50.3, h: 74.2 })])]),
      );
      expect(done.report.templates[0]?.slots[1]?.frame).toEqual({ x: 50, y: 26, w: 50, h: 74 });
      expect(done.report.left).toContainEqual({
        what: 'the placeholder "pic 3" of the layout "Bleed"',
        why: "it ran 0.3% past the edge of the slide, and the part past the edge is cut",
      });
    });

    it("is reported once, as a whole, when the layout is skipped after one of its slots was trimmed", async () => {
      const done = await importFixture(
        make,
        only([
          layout("Bleed and vertical", [
            ph("pic", { x: 50, y: 26, w: 50.3, h: 74.2 }),
            ph("body", { x: 8, y: 26, w: 40, h: 60 }, { vert: "eaVert" }),
          ]),
          layout("Fine", [ph("body", { x: 8, y: 26, w: 84, h: 60 })]),
        ]),
      );
      expect(done.report.templates.map((template) => template.layout)).toEqual(["Fine"]);
      const mentions = done.report.left.filter((item) => item.what.includes("Bleed and vertical"));
      expect(mentions).toHaveLength(1);
      expect(mentions[0]?.why).toMatch(/runs its text vertically/);
      expect(done.report.left.some((item) => /past the edge/.test(item.why))).toBe(false);
    });

    it("is trimmed on the near edge too", async () => {
      const done = await importFixture(
        make,
        only([layout("Bleed", [ph("pic", { x: -0.2, y: 26, w: 40.2, h: 60 })])]),
      );
      expect(done.report.templates[0]?.slots[1]?.frame).toEqual({ x: 0, y: 26, w: 40, h: 60 });
    });

    it("keeps its frame and warns when it overlaps another by a percent or less", async () => {
      const done = await importFixture(
        make,
        only([layout("Touch", [ph("body", { x: 8, y: 21.5, w: 84, h: 40 })])]),
      );
      expect(done.report.templates.map((template) => template.id)).toEqual(["touch"]);
      expect(done.report.templates[0]?.slots[1]?.frame).toEqual({ x: 8, y: 21.5, w: 84, h: 40 });
      expect(done.diagnostics.map((diagnostic) => diagnostic.code)).toContain("slots-overlap");
    });

    it("is left out, with the layout kept, when it is under the smallest a slot may be", async () => {
      const done = await importFixture(
        make,
        only([
          layout("Small", [
            ph("body", { x: 8, y: 30, w: 60, h: FRAME_MIN - 1 }),
            ph("body", { x: 8, y: 40, w: 60, h: 30 }),
          ]),
        ]),
      );
      expect(done.report.templates[0]?.slots.map((slot) => slot.id)).toEqual(["title", "body"]);
      expect(done.report.left.find((item) => item.what.includes('"Small"'))?.why).toBe(
        `it is 60% by ${FRAME_MIN - 1}% of the slide, under the ${FRAME_MIN}% a slot must be`,
      );
    });

    it("is left out, with the layout kept, when it is rotated", async () => {
      const done = await importFixture(
        make,
        only([
          layout("Turned", [
            ph("body", { x: 8, y: 30, w: 60, h: 30 }, { rotated: true }),
            ph("body", { x: 8, y: 65, w: 60, h: 20 }),
          ]),
        ]),
      );
      expect(done.report.templates[0]?.slots.map((slot) => slot.id)).toEqual(["title", "body"]);
      expect(
        done.report.left.some(
          (item) => item.why === "it is rotated or flipped, and a slot is an upright box",
        ),
      ).toBe(true);
    });

    it("is left out when it has no place of its own and the master has none to give", async () => {
      const done = await importFixture(
        make,
        only([{ name: "Lost", shapes: [ph("title", undefined), ph("body", undefined, { idx: 1 })] }], {
          master: [ph("title", { x: 8, y: 6, w: 78, h: 16 })],
        }),
      );
      expect(done.report.templates[0]?.slots.map((slot) => slot.id)).toEqual(["title"]);
      expect(done.report.left).toContainEqual({
        what: 'the placeholder "body 3" of the layout "Lost"',
        why: "it has no position in the layout, and the master has no placeholder to take one from",
      });
    });
  });

  it("is told to leave out the master's shapes when the layout turns them off", async () => {
    const done = await importFixture(
      make,
      only([
        layout("Clean", [ph("body", { x: 8, y: 26, w: 84, h: 60 })], { showMasterShapes: false }),
        layout("Plain", []),
      ]),
    );
    expect(done.report.templates.map((template) => [template.id, template.chrome])).toEqual([
      ["clean", "none"],
      ["plain", undefined],
    ]);
    expect(done.json("templates/clean.json").chrome).toBe("none");
    expect(done.json("templates/plain.json").chrome).toBeUndefined();
  });

  it("fails with the reason for each layout when none can be a template", async () => {
    const folder = make();
    const { file, out } = await writeFixture(
      folder,
      only([
        { name: "Blank", shapes: [] },
        { name: "Empty", shapes: [] },
      ]),
    );
    const result = await importBrand({ file, out });
    expect(result).toMatchObject({ ok: false, code: "no-layout" });
    expect(result.ok ? [] : result.left.map((item) => item.what)).toEqual([
      'The layout "Blank"',
      'The layout "Empty"',
    ]);
  });

  it("leaves out the decoration, and counts it", async () => {
    const done = await importFixture(
      make,
      only(
        [
          layout("Art", [
            { kind: "shape", name: "Bar", frame: { x: 0, y: 90, w: 100, h: 10 } },
            ph("body", { x: 8, y: 26, w: 84, h: 50 }),
          ]),
        ],
        {
          master: [...MASTER, { kind: "shape", name: "Stripe", frame: { x: 0, y: 0, w: 100, h: 2 } }],
        },
      ),
    );
    const item = done.report.left.find((entry) => entry.what.startsWith("Decoration"));
    expect(item?.what).toBe("Decoration: 2 shapes and 0 pictures on the master and the layouts");
  });
});

describe("the background of a layout", () => {
  const backgroundOf = async (bg: LayoutSpec["bg"], spec: PackageSpec = {}) => {
    const done = await importFixture(
      make,
      only([layout("Back", [ph("body", { x: 8, y: 26, w: 84, h: 60 })], bg ? { bg } : {})], spec),
    );
    return {
      done,
      template: done.json("templates/back.json"),
      left: done.report.left.filter((item) => item.what.startsWith("The background")),
    };
  };

  it("is nothing when the layout sets none, or sets the slide's own color", async () => {
    expect((await backgroundOf(undefined)).template.background).toBeUndefined();
    const same = await backgroundOf({ scheme: "bg1" });
    expect(same.template.background).toBeUndefined();
    expect(same.left).toEqual([]);
  });

  it("is the named color when it is one of the brand's colors", async () => {
    expect((await backgroundOf({ scheme: "bg2" })).template.background).toEqual({ color: "surface" });
    expect((await backgroundOf({ scheme: "accent1" })).template.background).toEqual({ color: "action" });
    expect((await backgroundOf({ scheme: "hlink" })).template.background).toEqual({ color: "evidence" });
    expect((await backgroundOf({ rgb: "1B1B1B" })).template.background).toEqual({ color: "text" });
  });

  it("is reported, not guessed, when its color is not one of the brand's", async () => {
    const odd = await backgroundOf({ rgb: "123456" });
    expect(odd.template.background).toBeUndefined();
    expect(odd.left[0]?.why).toBe(
      "its color #123456 is not one of the brand's colors (background, panel, text, accent or link)",
    );
  });

  it("is reported when its color is lightened, darkened or made transparent", async () => {
    const adjusted = await backgroundOf({ scheme: "bg1", adjust: true });
    expect(adjusted.template.background).toBeUndefined();
    expect(adjusted.left[0]?.why).toMatch(/lightened, darkened or made transparent/);
  });

  it("is reported when it is a gradient, or a fill this does not read", async () => {
    expect((await backgroundOf({ gradient: true })).left[0]?.why).toBe(
      "it is a grad fill, and a template's background is a plain color or a picture",
    );
    expect((await backgroundOf({ none: true })).left[0]?.why).toBe("it has no fill this reads");
  });

  it("is a picture in images/ under a scrim, when the layout paints one", async () => {
    const bytes = jpeg(200, 100);
    const { done, template } = await backgroundOf(
      { picture: "photo.jpg" },
      { media: { "logo.png": PNG, "photo.jpg": bytes } },
    );
    expect(template.background).toEqual({ color: "bg", image: "images/photo.jpg", scrim: 65 });
    expect(done.bytes("images/photo.jpg")).toEqual(bytes);
    expect(done.report.templates[0]?.background).toBe("images/photo.jpg under a 65% bg scrim");
    expect(done.report.files).toContain("images/photo.jpg");
  });

  it("shares one image file between layouts that paint the same picture", async () => {
    const done = await importFixture(
      make,
      only(
        [
          layout("One", [ph("body", { x: 8, y: 26, w: 84, h: 60 })], { bg: { picture: "photo.png" } }),
          layout("Two", [ph("body", { x: 8, y: 26, w: 84, h: 60 })], { bg: { picture: "photo.png" } }),
        ],
        { media: { "logo.png": PNG, "photo.png": PNG } },
      ),
    );
    expect(done.report.files.filter((file) => file.startsWith("images/"))).toEqual(["images/photo.png"]);
    expect(done.json("templates/two.json").background.image).toBe("images/photo.png");
  });

  it("is reported when the picture is in a format a background cannot be", async () => {
    const { template, left } = await backgroundOf(
      { picture: "photo.emf" },
      { media: { "logo.png": PNG, "photo.emf": EMF } },
    );
    expect(template.background).toBeUndefined();
    expect(left[0]?.why).toBe(
      "its picture is in a format a template's background cannot be (EMF); use PNG, JPEG, WebP or SVG",
    );
  });

  it("is reported when the picture is not in the file", async () => {
    const { template, left } = await backgroundOf({ picture: "gone.jpg" }, { media: { "logo.png": PNG } });
    expect(template.background).toBeUndefined();
    expect(left[0]?.why).toBe("its picture is not in the file");
  });

  it("is taken out, and reported, when text could not be read on it", async () => {
    // Text on a colored background is drawn in the slide's own color, and white on this orange is under 4.5:1.
    const { template, left, done } = await backgroundOf(
      { rgb: "E45730" },
      { colors: { ...LIGHT, accent1: "E45730" } },
    );
    expect(template.background).toBeUndefined();
    expect(left).toHaveLength(1);
    expect(left[0]?.why).toMatch(/contrast of 3\.6\d:1 on paper slides, under the 4\.5:1 text needs/);
    expect(done.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});

describe("frameOf and trimmed", () => {
  const slide = { w: 12192000, h: 6858000 };

  it("gives a box as percent of the slide, rounded to two places", () => {
    expect(frameOf({ x: 1219200, y: 685800, w: 6096000, h: 3429000 }, slide)).toEqual({
      x: 10,
      y: 10,
      w: 50,
      h: 50,
    });
    expect(frameOf({ x: 1000000, y: 1000000, w: 1000000, h: 1000000 }, slide)).toEqual({
      x: 8.2,
      y: 14.58,
      w: 8.2,
      h: 14.58,
    });
  });

  it("rounds both edges, so boxes that touch still touch", () => {
    const a = frameOf({ x: 0, y: 0, w: 4000001, h: 100 }, slide);
    const b = frameOf({ x: 4000001, y: 0, w: 4000001, h: 100 }, slide);
    expect(Math.round((a.x + a.w) * 100)).toBe(Math.round(b.x * 100));
  });

  it("leaves a frame on the slide as it is", () => {
    expect(trimmed({ x: 0, y: 0, w: 100, h: 100 })).toEqual({ frame: { x: 0, y: 0, w: 100, h: 100 } });
  });

  it("cuts a frame back by up to half a percent, and says by how much", () => {
    expect(trimmed({ x: 50, y: 10, w: 50.5, h: 20 })).toEqual({
      frame: { x: 50, y: 10, w: 50, h: 20 },
      by: 0.5,
    });
    expect(trimmed({ x: -0.5, y: 10, w: 20.5, h: 20 })).toEqual({
      frame: { x: 0, y: 10, w: 20, h: 20 },
      by: 0.5,
    });
    expect(trimmed({ x: 10, y: 90, w: 20, h: 10.25 })).toEqual({
      frame: { x: 10, y: 90, w: 20, h: 10 },
      by: 0.25,
    });
  });

  it("leaves a frame that is further out for the skip", () => {
    expect(trimmed({ x: 50, y: 10, w: 50.6, h: 20 })).toEqual({ frame: { x: 50, y: 10, w: 50.6, h: 20 } });
    expect(trimmed({ x: -0.6, y: 10, w: 20, h: 20 }).frame.x).toBe(-0.6);
  });
});

describe("a 4:3 file", () => {
  it("keeps each frame's share of the slide, and the report says the slide was stretched", async () => {
    const wide = await importFixture(make);
    const narrow = await importFixture(make, { size: { cx: 9144000, cy: 6858000 } });
    expect(narrow.json("templates/title-slide.json").slots).toEqual(
      wide.json("templates/title-slide.json").slots,
    );
    expect(narrow.report.source.slide.ratio).toBe("4:3");
    expect(narrow.report.notes.join("\n")).toContain(
      "The slides are 4:3 (9144000 by 6858000 EMU) and Depthcue's are 16:9, so every frame was scaled",
    );
    expect(wide.report.notes.join("\n")).not.toContain("so every frame was scaled");
  });
});
