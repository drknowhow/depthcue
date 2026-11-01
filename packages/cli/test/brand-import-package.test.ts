import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  firstOfKind,
  LIMITS,
  OfficePackage,
  PackageError,
  relationshipKind,
} from "../src/brand-import/package.ts";

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: "uint8array" });
}

const RELS = (items: string) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;

describe("OfficePackage", () => {
  it("opens a zip and finds parts without regard to case", async () => {
    const pkg = await OfficePackage.open(await zipOf({ "ppt/Theme/Theme1.xml": "<a/>" }));
    expect(pkg.has("PPT/theme/THEME1.XML")).toBe(true);
    expect(pkg.nameOf("ppt/theme/theme1.xml")).toBe("ppt/Theme/Theme1.xml");
    expect(pkg.names()).toEqual(["ppt/Theme/Theme1.xml"]);
    expect(pkg.has("ppt/other.xml")).toBe(false);
  });

  it("says a file that is not a zip is not a PowerPoint file, and mentions the old formats", async () => {
    await expect(OfficePackage.open(new TextEncoder().encode("not a zip at all"))).rejects.toMatchObject({
      code: "not-a-package",
      message: expect.stringContaining(".ppt"),
    });
    await expect(OfficePackage.open(new Uint8Array())).rejects.toBeInstanceOf(PackageError);
  });

  it("refuses a package with more parts than any deck has", async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n <= LIMITS.parts; n++) files[`p/${n}.xml`] = "";
    await expect(OfficePackage.open(await zipOf(files))).rejects.toMatchObject({ code: "too-large" });
  });

  it("reads bytes, and nothing for a part that is not there", async () => {
    const pkg = await OfficePackage.open(await zipOf({ "a.bin": Uint8Array.from([1, 2, 3]) }));
    expect(await pkg.bytes("a.bin")).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await pkg.bytes("b.bin")).toBeUndefined();
  });

  it("refuses a part that unpacks past the limit", async () => {
    const pkg = await OfficePackage.open(await zipOf({ "big.bin": new Uint8Array(5000) }));
    await expect(pkg.bytes("big.bin", 1000)).rejects.toMatchObject({ code: "too-large" });
    expect(await pkg.bytes("big.bin", 6000)).toHaveLength(5000);
  });

  it("parses XML parts once, and says which part is not valid XML", async () => {
    const pkg = await OfficePackage.open(await zipOf({ "ok.xml": "<a><b/></a>", "bad.xml": "<a><b></a>" }));
    const first = await pkg.xml("ok.xml");
    expect(first?.name).toBe("a");
    expect(await pkg.xml("OK.xml")).toBe(first);
    expect(await pkg.xml("missing.xml")).toBeUndefined();
    await expect(pkg.xml("bad.xml")).rejects.toMatchObject({
      code: "bad-xml",
      message: expect.stringContaining("bad.xml"),
    });
  });

  it("reads relationships, resolving each target to a part name from the root", async () => {
    const pkg = await OfficePackage.open(
      await zipOf({
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": RELS(
          [
            '<Relationship Id="rId1" Type="http://x/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>',
            '<Relationship Id="rId2" Type="http://x/relationships/theme" Target="/ppt/theme/theme1.xml"/>',
            '<Relationship Id="rId3" Type="http://x/relationships/image" Target="./media/./a.png"/>',
            '<Relationship Id="rId4" Type="http://x/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>',
            '<Relationship Type="http://x/relationships/broken" Target="x"/>',
          ].join(""),
        ),
        "_rels/.rels": RELS(
          '<Relationship Id="rId1" Type="http://x/relationships/officeDocument" Target="ppt/presentation.xml"/>',
        ),
      }),
    );
    const master = await pkg.rels("ppt/slideMasters/slideMaster1.xml");
    expect(master.map((rel) => [rel.id, relationshipKind(rel), rel.target])).toEqual([
      ["rId1", "slideLayout", "ppt/slideLayouts/slideLayout1.xml"],
      ["rId2", "theme", "ppt/theme/theme1.xml"],
      ["rId3", "image", "ppt/slideMasters/media/a.png"],
      ["rId4", "hyperlink", undefined],
    ]);
    expect(firstOfKind(master, "theme")?.target).toBe("ppt/theme/theme1.xml");
    expect(firstOfKind(master, "slide")).toBeUndefined();
    expect((await pkg.rels("")).map((rel) => rel.target)).toEqual(["ppt/presentation.xml"]);
    expect(await pkg.rels("ppt/none.xml")).toEqual([]);
  });

  it("does not let a target climb out of the package", async () => {
    const pkg = await OfficePackage.open(
      await zipOf({
        "a/_rels/b.xml.rels": RELS(
          '<Relationship Id="rId1" Type="http://x/relationships/image" Target="../../../../etc/passwd"/>',
        ),
      }),
    );
    expect((await pkg.rels("a/b.xml"))[0]?.target).toBe("etc/passwd");
  });
});
