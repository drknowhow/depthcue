import { describe, expect, it } from "vitest";
import {
  cornerOf,
  formatOf,
  isSafeSvg,
  jpegSize,
  nearestSize,
  svgAroundJpeg,
  touchesEdge,
} from "../src/brand-import/logo.ts";
import {
  DARK,
  EMF,
  GIF,
  importFixture,
  jpeg,
  LAYOUTS,
  MASTER,
  type PackageSpec,
  PNG,
  SCRIPTED_SVG,
  type ShapeSpec,
  STANDARD_MEDIA,
  svg,
  temporaryFolders,
} from "./brand-import-fixtures.ts";

const make = temporaryFolders();

/** A master with the standard placeholders and these pictures instead of the standard logo. */
const withPictures = (pictures: ShapeSpec[], media: PackageSpec["media"] = STANDARD_MEDIA): PackageSpec => ({
  master: [...MASTER.filter((shape) => shape.kind !== "pic"), ...pictures],
  media,
});

const pic = (
  frame: { x: number; y: number; w: number; h: number },
  extra: Partial<ShapeSpec> = {},
): ShapeSpec => ({ kind: "pic", name: "Picture 5", frame, media: "logo.png", ...extra }) as ShapeSpec;

describe("formatOf", () => {
  it("knows a picture by its first bytes, not by its name", () => {
    expect(formatOf(PNG)).toBe("png");
    expect(formatOf(jpeg(10, 10))).toBe("jpeg");
    expect(formatOf(GIF)).toBe("gif");
    expect(formatOf(EMF)).toBe("emf");
    expect(formatOf(Uint8Array.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0]))).toBe("wmf");
    expect(formatOf(Uint8Array.from([0x01, 0x00, 0x09, 0x00, 0, 0]))).toBe("wmf");
    expect(formatOf(svg())).toBe("svg");
    expect(formatOf(new TextEncoder().encode("\n  <svg width='1'/>"))).toBe("svg");
    expect(formatOf(Uint8Array.from([1, 2, 3, 4]))).toBe("unknown");
    expect(formatOf(new Uint8Array())).toBe("unknown");
  });
});

describe("isSafeSvg", () => {
  it("accepts a plain drawing", () => {
    expect(isSafeSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')).toBe(true);
  });

  it.each([
    ["a script", "<svg><script>x()</script></svg>"],
    ["a foreignObject", "<svg><foreignObject/></svg>"],
    ["an entity", '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'],
    ["a javascript: link", '<svg><a href="javascript:x()"/></svg>'],
    ["an event handler", '<svg><rect onload="x()"/></svg>'],
    ["an event handler after a newline", '<svg><rect\nonclick = "x()"/></svg>'],
  ])("refuses an SVG with %s", (_, text) => {
    expect(isSafeSvg(text)).toBe(false);
  });
});

describe("jpegSize and svgAroundJpeg", () => {
  it("reads a JPEG's size from its frame marker", () => {
    expect(jpegSize(jpeg(640, 480))).toEqual({ w: 640, h: 480 });
    expect(jpegSize(jpeg(300, 1000))).toEqual({ w: 300, h: 1000 });
  });

  it("says nothing for bytes that are not a JPEG's markers", () => {
    expect(jpegSize(Uint8Array.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined();
  });

  it("wraps the JPEG byte for byte in an SVG of the same size", () => {
    const bytes = jpeg(120, 40);
    const text = new TextDecoder().decode(svgAroundJpeg(bytes, { w: 1, h: 1 }));
    expect(text).toContain('width="120" height="40" viewBox="0 0 120 40"');
    const data = /base64,([A-Za-z0-9+/=]+)"/.exec(text)?.[1] as string;
    expect(Uint8Array.from(Buffer.from(data, "base64"))).toEqual(bytes);
    expect(isSafeSvg(text)).toBe(true);
  });

  it("falls back to the size it is given when the JPEG's own cannot be read", () => {
    const text = new TextDecoder().decode(
      svgAroundJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0]), { w: 80.4, h: 20.6 }),
    );
    expect(text).toContain('width="80" height="21"');
  });
});

describe("nearestSize, cornerOf, touchesEdge", () => {
  const slide = { w: 1000, h: 500 };

  it("picks the size whose height is nearest the picture's share of the slide", () => {
    expect(nearestSize(0.02)).toBe("s");
    expect(nearestSize(0.05)).toBe("s");
    expect(nearestSize(0.07)).toBe("m");
    expect(nearestSize(0.08)).toBe("m");
    expect(nearestSize(0.11)).toBe("l");
    expect(nearestSize(0.5)).toBe("l");
  });

  it("names the corner by the quadrant the picture's center is in", () => {
    expect(cornerOf({ x: 50, y: 20, w: 50, h: 30 }, slide)).toBe("top-start");
    expect(cornerOf({ x: 900, y: 20, w: 50, h: 30 }, slide)).toBe("top-end");
    expect(cornerOf({ x: 50, y: 450, w: 50, h: 30 }, slide)).toBe("bottom-start");
    expect(cornerOf({ x: 900, y: 450, w: 50, h: 30 }, slide)).toBe("bottom-end");
  });

  it("finds no corner for a picture in the middle, or on one side only", () => {
    expect(cornerOf({ x: 450, y: 225, w: 100, h: 50 }, slide)).toBeUndefined();
    expect(cornerOf({ x: 450, y: 20, w: 100, h: 30 }, slide)).toBeUndefined();
    expect(cornerOf({ x: 20, y: 225, w: 50, h: 50 }, slide)).toBeUndefined();
  });

  it("says a picture reaches the edge when it comes within half a percent of it", () => {
    expect(touchesEdge({ x: 0, y: 100, w: 100, h: 100 }, slide)).toBe(true);
    expect(touchesEdge({ x: 4, y: 100, w: 100, h: 100 }, slide)).toBe(true);
    expect(touchesEdge({ x: 6, y: 100, w: 100, h: 100 }, slide)).toBe(false);
    expect(touchesEdge({ x: 100, y: 100, w: 895, h: 100 }, slide)).toBe(true);
    expect(touchesEdge({ x: 100, y: 100, w: 100, h: 398 }, slide)).toBe(true);
    expect(touchesEdge({ x: 100, y: 100, w: 100, h: 100 }, slide)).toBe(false);
  });
});

describe("the logo in an import", () => {
  it("is the picture in the corner, in its own format, with its place and size", async () => {
    const done = await importFixture(make);
    expect(done.report.logo).toMatchObject({
      file: "logos/logo.png",
      corner: "top-end",
      size: "m",
      alt: "The Harbor Co. wordmark",
    });
    expect(done.report.logo?.from).toBe("Harbor logo on the slide master");
    expect(done.bytes("logos/logo.png")).toEqual(PNG);
    const brand = done.json("brand.json");
    expect(brand.logos).toEqual({ light: "logos/logo.png", alt: "The Harbor Co. wordmark" });
    expect(brand.chrome.logo).toEqual({ corner: "top-end", size: "m" });
    expect(done.report.chrome.logo).toBe("top-end, size m");
  });

  it("goes in the dark slot of a dark master", async () => {
    const done = await importFixture(make, { dark: true, colors: DARK });
    expect(done.json("brand.json").logos.dark).toBe("logos/logo.png");
    expect(done.json("brand.json").logos.light).toBeUndefined();
  });

  it("keeps an SVG as it is", async () => {
    const bytes = svg('<rect width="8" height="8"/>');
    const done = await importFixture(
      make,
      withPictures([{ kind: "pic", name: "Mark", frame: { x: 3, y: 5, w: 6, h: 10 }, media: "mark.svg" }], {
        "mark.svg": bytes,
      }),
    );
    expect(done.report.logo).toMatchObject({ file: "logos/logo.svg", corner: "top-start" });
    expect(done.bytes("logos/logo.svg")).toEqual(bytes);
  });

  it("wraps a JPEG in an SVG, unchanged, because a brand's logo is an SVG or a PNG", async () => {
    const bytes = jpeg(400, 200);
    const done = await importFixture(
      make,
      withPictures([{ kind: "pic", name: "Photo", frame: { x: 90, y: 5, w: 8, h: 9 }, media: "logo.jpg" }], {
        "logo.jpg": bytes,
      }),
    );
    expect(done.report.logo?.file).toBe("logos/logo.svg");
    expect(done.report.logo?.from).toContain("a JPEG, so it is kept unchanged inside an SVG");
    const text = done.read("logos/logo.svg");
    expect(text).toContain('viewBox="0 0 400 200"');
    const data = /base64,([A-Za-z0-9+/=]+)"/.exec(text)?.[1] as string;
    expect(Uint8Array.from(Buffer.from(data, "base64"))).toEqual(bytes);
    expect(done.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("is left out, with the reason, when it is a format a logo cannot be", async () => {
    const cases: Array<[string, Uint8Array, RegExp]> = [
      [
        "logo.emf",
        EMF,
        /EMF picture, which this cannot convert; save the logo from PowerPoint as a PNG or SVG/,
      ],
      ["logo.gif", GIF, /it is a GIF, and a brand's logo is an SVG or a PNG/],
      ["logo.bin", Uint8Array.from([9, 9, 9, 9]), /its image is in a format this does not know/],
      ["logo.svg", SCRIPTED_SVG, /its SVG holds a script/],
    ];
    for (const [name, bytes, why] of cases) {
      const done = await importFixture(
        make,
        withPictures([{ kind: "pic", name: "Logo", frame: { x: 90, y: 5, w: 5, h: 9 }, media: name }], {
          [name]: bytes,
        }),
      );
      expect(done.report.logo, name).toBeNull();
      expect(done.report.chrome.logo, name).toBeUndefined();
      expect(
        done.report.left.find((item) => item.what === 'The picture "Logo" on the slide master')?.why,
        name,
      ).toMatch(why);
      expect(done.json("brand.json").logos, name).toBeUndefined();
    }
  });

  it("is left out when its image is not in the file", async () => {
    const done = await importFixture(make, withPictures([pic({ x: 90, y: 5, w: 5, h: 9 })], {}));
    expect(done.report.logo).toBeNull();
    expect(done.report.left.map((item) => item.why).join("\n")).toContain("its image is not in the file");
  });

  it("is the smallest picture in a corner, and the others are listed", async () => {
    const done = await importFixture(
      make,
      withPictures([
        pic({ x: 3, y: 80, w: 12, h: 14 }, { name: "Big mark" }),
        pic({ x: 90, y: 5, w: 5, h: 9 }, { name: "Small mark" }),
      ]),
    );
    expect(done.report.logo?.from).toContain("Small mark");
    expect(done.report.logo?.corner).toBe("top-end");
    expect(done.report.left).toContainEqual({
      what: 'The picture "Big mark" on the slide master',
      why: "a smaller picture in a corner was taken as the logo",
    });
  });

  it.each([
    [
      "covers more than a fifth of the slide",
      { x: 3, y: 5, w: 50, h: 50 },
      /covers \d+% of the slide, which is a decoration/,
    ],
    ["is in the middle of the slide", { x: 45, y: 40, w: 10, h: 18 }, /it is not in a corner of the slide/],
    [
      "reaches the edge of the slide",
      { x: 0, y: 5, w: 6, h: 10 },
      /it reaches the edge of the slide, as artwork does/,
    ],
    ["reaches the bottom edge", { x: 90, y: 90, w: 6, h: 10 }, /it reaches the edge of the slide/],
  ])("is not taken when the picture %s", async (_, frame, why) => {
    const done = await importFixture(make, withPictures([pic(frame, { name: "Art" })]));
    expect(done.report.logo).toBeNull();
    expect(
      done.report.left.find((item) => item.what === 'The picture "Art" on the slide master')?.why,
    ).toMatch(why);
  });

  it("is not taken when the picture is flipped", async () => {
    const done = await importFixture(
      make,
      withPictures([pic({ x: 90, y: 5, w: 5, h: 9 }, { name: "Flipped", flipped: true })]),
    );
    expect(done.report.logo).toBeNull();
    expect(done.report.left).toContainEqual({
      what: 'The picture "Flipped" on the slide master',
      why: "it is rotated or flipped",
    });
  });

  it.each([
    [{ x: 4, y: 6, w: 5, h: 9 }, "top-start"],
    [{ x: 91, y: 6, w: 5, h: 9 }, "top-end"],
    [{ x: 4, y: 84, w: 5, h: 9 }, "bottom-start"],
    [{ x: 91, y: 84, w: 5, h: 9 }, "bottom-end"],
  ])("sits in the corner its center is in: %j is %s", async (frame, corner) => {
    const done = await importFixture(make, withPictures([pic(frame)]));
    expect(done.report.logo?.corner).toBe(corner);
  });

  it.each([
    [4, "s"],
    [8, "m"],
    [15, "l"],
  ])("is size by its height: %i%% of the slide is %s", async (height, size) => {
    const done = await importFixture(make, withPictures([pic({ x: 90, y: 5, w: 5, h: height })]));
    expect(done.report.logo?.size).toBe(size);
  });

  it("takes its alt text from the picture's, then from a name that says logo, then from the brand's name", async () => {
    const frame = { x: 90, y: 5, w: 5, h: 9 };
    const own = await importFixture(make, withPictures([pic(frame, { descr: "Harbor, a ship's wheel" })]));
    expect(own.report.logo?.alt).toBe("Harbor, a ship's wheel");
    const named = await importFixture(make, withPictures([pic(frame, { name: "Company Logo 2" })]));
    expect(named.report.logo?.alt).toBe("Company Logo 2");
    const neither = await importFixture(make, withPictures([pic(frame, { name: "Picture 5" })]), "Harbor Co");
    expect(neither.report.logo?.alt).toBe("Harbor Co logo");
  });

  it("says when the picture is cropped, as the crop is not applied", async () => {
    const done = await importFixture(
      make,
      withPictures([pic({ x: 90, y: 5, w: 5, h: 9 }, { cropped: true })]),
    );
    expect(done.report.logo?.from).toContain("its crop is not applied");
  });

  /** The standard layouts, with a logo on the title slide. */
  const layoutsWithCoverLogo = () => [
    {
      ...(LAYOUTS[0] as (typeof LAYOUTS)[number]),
      shapes: [
        ...(LAYOUTS[0]?.shapes ?? []),
        {
          kind: "pic",
          name: "Cover logo",
          frame: { x: 4, y: 6, w: 5, h: 9 },
          media: "logo.png",
        } as ShapeSpec,
      ],
    },
    ...LAYOUTS.slice(1),
  ];

  it("is taken from the title layout when the master has no pictures", async () => {
    const done = await importFixture(make, {
      master: MASTER.filter((shape) => shape.kind !== "pic"),
      layouts: layoutsWithCoverLogo(),
    });
    expect(done.report.logo).toMatchObject({ corner: "top-start", file: "logos/logo.png" });
    expect(done.report.logo?.from).toBe('Cover logo on the layout "Title Slide"');
    expect(done.report.notes.join("\n")).toContain(
      'The logo was on the layout "Title Slide", not the master.',
    );
    // The picture is the logo, not decoration: it is not counted among the shapes left out.
    expect(done.report.left.some((item) => item.what.startsWith("Decoration"))).toBe(false);
  });

  it("is not looked for on the title layout when the master has pictures of its own", async () => {
    const done = await importFixture(make, {
      master: [
        ...MASTER.filter((shape) => shape.kind !== "pic"),
        pic({ x: 40, y: 40, w: 20, h: 20 }, { name: "Art" }),
      ],
      layouts: layoutsWithCoverLogo(),
    });
    expect(done.report.logo).toBeNull();
  });

  it("is absent from a file with no pictures at all", async () => {
    const done = await importFixture(make, {
      master: MASTER.filter((shape) => shape.kind !== "pic"),
      media: {},
    });
    expect(done.report.logo).toBeNull();
    expect(done.report.chrome.logo).toBeUndefined();
    expect(done.json("brand.json").logos).toBeUndefined();
  });
});
