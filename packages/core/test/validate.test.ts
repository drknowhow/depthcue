import { describe, expect, it } from "vitest";
import { checkDeckFiles, checkManifest, checkScene, type Diagnostic } from "../src/index.ts";
import { demoDir, loadDir, scene } from "./helpers.ts";

const first = (diagnostics: Diagnostic[]): Diagnostic => {
  const found = diagnostics[0];
  if (!found) throw new Error("expected a diagnostic");
  return found;
};

describe("fixture deck", () => {
  it("has no diagnostics", () => {
    expect(checkDeckFiles(loadDir(demoDir))).toEqual([]);
  });
});

describe("scene structure", () => {
  it("rejects an overlong heading and says how much to cut", () => {
    const long = scene({ blocks: [{ id: "h", type: "text", role: "heading", text: "x".repeat(112) }] });
    const found = first(checkScene(long, "scenes/a.json").filter((d) => d.code === "too-long"));
    expect(found.path).toBe("/blocks/0/text");
    expect(found.message).toBe("112 characters; the limit is 90.");
    expect(found.fix).toContain("Shorten it by 22");
  });

  it("allows body text the same length", () => {
    const body = scene({ blocks: [{ id: "bd", type: "text", role: "body", text: "x".repeat(112) }] });
    expect(checkScene(body, "scenes/a.json")).toEqual([]);
  });

  it("suggests the near miss for an unknown property", () => {
    const found = first(checkScene(scene({ titel: "x" }), "scenes/a.json"));
    expect(found).toMatchObject({ code: "unknown-property", path: "/titel", fix: 'Did you mean "title"?' });
  });

  it("lists the allowed properties when nothing is close", () => {
    const found = first(checkScene(scene({ music: "jazz" }), "scenes/a.json"));
    expect(found.fix).toBe(
      "Allowed here: $schema, schemaVersion, id, title, layout, template, background, lead, summary, blocks, sources, reading, steps, notes, voiceover.",
    );
  });

  it("suggests the near miss for a misspelt layout", () => {
    const found = first(checkScene(scene({ layout: "claim-evidance" }), "scenes/a.json"));
    expect(found.fix).toContain('Did you mean "claim-evidence"?');
  });

  it("requires alt text on images, and says a decorative picture may leave it out", () => {
    const image = scene({ blocks: [{ id: "pic", type: "image", asset: "assets/a.png" }] });
    expect(checkScene(image, "scenes/a.json")).toEqual([
      {
        severity: "error",
        code: "missing-property",
        file: "scenes/a.json",
        path: "/blocks/0",
        message: 'Missing "alt": a picture needs alt text unless it is decorative.',
        fix: 'Add "alt" that says what the picture shows, for someone who cannot see it, or set "decorative": true if it carries no information.',
      },
    ]);
  });

  it("names the allowed block types for an unknown one", () => {
    const found = first(checkScene(scene({ blocks: [{ id: "v", type: "video" }] }), "scenes/a.json"));
    expect(found).toMatchObject({ code: "bad-value", path: "/blocks/0/type" });
    expect(found.fix).toContain("text, image, bar-chart, clip");
  });

  it("rejects a chart with no data", () => {
    const chart = scene({ blocks: [{ id: "c", type: "bar-chart", data: [] }] });
    expect(checkScene(chart, "scenes/a.json").map((d) => d.code)).toContain("too-few");
  });

  it("explains a bad id and a path that escapes assets/", () => {
    const bad = scene({
      id: "Bad_ID",
      blocks: [{ id: "pic", type: "image", asset: "assets/../x.png", alt: "x" }],
    });
    const messages = checkScene(bad, "scenes/a.json").map((d) => d.fix ?? "");
    expect(messages.some((fix) => fix.startsWith("Ids use lowercase"))).toBe(true);
    expect(messages.some((fix) => fix.includes('never contain ".."'))).toBe(true);
  });
});

describe("manifest structure", () => {
  const manifest = {
    schemaVersion: "0.1",
    id: "d",
    title: "T",
    language: "en",
    theme: "paper",
    scenes: ["a-scene"],
  };

  it("accepts a minimal manifest", () => {
    expect(checkManifest({ ...manifest, id: "dd" })).toEqual([]);
  });

  it("reports a repeated scene id", () => {
    const found = checkManifest({ ...manifest, id: "dd", scenes: ["a-scene", "a-scene"] });
    expect(found.map((d) => d.code)).toContain("duplicate");
  });
});

describe("deck files", () => {
  const files = () => {
    const { text, assets } = loadDir(demoDir);
    return { text: { ...text }, assets: [...assets] };
  };

  it("reports a listed scene whose file is missing", () => {
    const deck = files();
    delete deck.text["scenes/method.json"];
    expect(first(checkDeckFiles(deck))).toMatchObject({ code: "missing-file", path: "/scenes/2" });
  });

  it("warns about a scene file nobody lists", () => {
    const deck = files();
    deck.text["scenes/extra.json"] = deck.text["scenes/method.json"] as string;
    expect(first(checkDeckFiles(deck))).toMatchObject({ severity: "warning", code: "orphan-scene-file" });
  });

  it("reports a scene whose id differs from its listing", () => {
    const deck = files();
    deck.text["scenes/method.json"] = (deck.text["scenes/method.json"] as string).replace(
      '"id": "method"',
      '"id": "approach"',
    );
    expect(first(checkDeckFiles(deck))).toMatchObject({
      code: "scene-id-mismatch",
      file: "scenes/method.json",
    });
  });

  it("reports an asset that is not in the folder", () => {
    const deck = files();
    deck.assets = deck.assets.filter((path) => path !== "assets/method.svg");
    expect(first(checkDeckFiles(deck))).toMatchObject({ code: "missing-asset", path: "/blocks/2/asset" });
  });

  it("reports invalid JSON with the parser's reason", () => {
    const deck = files();
    deck.text["scenes/opening.json"] = "{ nope";
    const found = checkDeckFiles(deck).find((d) => d.code === "json-parse");
    expect(found?.file).toBe("scenes/opening.json");
  });

  it("reports a missing manifest", () => {
    expect(first(checkDeckFiles({ text: {}, assets: [] }))).toMatchObject({
      code: "missing-file",
      file: "deck.json",
    });
  });
});
