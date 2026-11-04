import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describe as describeNode,
  expand,
  fenced,
  fieldTable,
  frontMatter,
  languageOf,
  paletteCss,
  rewriteFrontMatterLinks,
  rewriteLinks,
  schemaReference,
  section,
  splitTitle,
  toolReference,
} from "./lib.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));

const BASE = "/depthcue";
const REPO = "https://github.com/drknowhow/depthcue";
const pages = { "docs/lease.md": "/guides/lease/", "docs/PLAN.md": "/project/plan/" };
const link = (markdown, from = "docs/export.md") =>
  rewriteLinks(markdown, { from, pages, base: BASE, repo: REPO });

describe("splitTitle", () => {
  it("takes the first level-one heading as the title and removes it from the body", () => {
    expect(splitTitle("# Lease: edits\n\nBody.\n")).toEqual({ title: "Lease: edits", body: "Body.\n" });
  });

  it("names the file when there is no heading", () => {
    expect(() => splitTitle("no heading", "docs/x.md")).toThrow(/docs\/x\.md has no level-one heading/);
  });
});

describe("frontMatter", () => {
  it("quotes a title so a colon or a quote cannot break the YAML", () => {
    expect(frontMatter({ title: 'Say "hi": now' })).toBe('---\ntitle: "Say \\"hi\\": now"\n---\n\n');
  });
});

describe("rewriteLinks", () => {
  it("points a link to another page at that page's address, keeping the anchor", () => {
    expect(link("[lease](lease.md#expiry)")).toBe("[lease](/depthcue/guides/lease/#expiry)");
  });

  it("resolves a link from where the page is written", () => {
    expect(link("[plan](../PLAN.md)", "docs/clips/a.md")).toBe("[plan](/depthcue/project/plan/)");
  });

  it("sends a link to any other repository file to GitHub, and a folder to its tree", () => {
    expect(link("[code](../packages/core/src/index.ts)")).toBe(
      `[code](${REPO}/blob/main/packages/core/src/index.ts)`,
    );
    expect(link("[dir](../packages/core/)")).toBe(`[dir](${REPO}/tree/main/packages/core/)`);
  });

  it("puts the base in front of a site address", () => {
    expect(link("[start](/start/)")).toBe("[start](/depthcue/start/)");
  });

  it("leaves absolute URLs, mail links and in-page anchors alone", () => {
    const text = "[a](https://example.com/x) [b](mailto:x@y.z) [c](#top)";
    expect(link(text)).toBe(text);
  });

  it("refuses a link that leaves the repository", () => {
    expect(() => link("[out](../../secret.md)")).toThrow(/outside the repository/);
  });
});

describe("rewriteFrontMatterLinks", () => {
  it("puts the base in front of a `link:` in the front matter only", () => {
    const page = "---\nhero:\n  actions:\n    - text: Go\n      link: /start/\n---\n\nlink: /start/\n";
    const out = rewriteFrontMatterLinks(page, BASE);
    expect(out).toContain("link: /depthcue/start/\n---");
    expect(out.endsWith("\nlink: /start/\n")).toBe(true);
  });

  it("leaves a full URL and a page with no front matter alone", () => {
    const external = "---\nlink: https://example.com\n---\n";
    expect(rewriteFrontMatterLinks(external, BASE)).toBe(external);
    expect(rewriteFrontMatterLinks("plain\n", BASE)).toBe("plain\n");
  });
});

describe("section", () => {
  const doc = "# T\n\n## One\n\nfirst\n\n## Two\n\nsecond\nmore\n";

  it("returns the text under a heading, up to the next one", () => {
    expect(section(doc, "One")).toBe("first");
    expect(section(doc, "Two")).toBe("second\nmore");
  });

  it("names the file and the heading when the heading is missing", () => {
    expect(() => section(doc, "Three", "README.md")).toThrow(/README\.md has no "## Three" section/);
  });
});

describe("fenced", () => {
  it("uses a fence longer than any run of backticks inside", () => {
    expect(fenced("a ```b``` c\n", "md")).toBe("````md\na ```b``` c\n````");
  });

  it("picks the language from the extension", () => {
    expect(languageOf("scenes/a.json")).toBe("json");
    expect(languageOf("x.mjs")).toBe("js");
    expect(languageOf("LICENSE")).toBe("text");
  });
});

describe("expand", () => {
  const files = { "a.json": '{"a":1}\n', "r.md": "## Try it\n\nrun it\n\n## Other\n\nx\n" };
  const context = {
    read: (path) => files[path],
    generated: { table: () => "| t |" },
    path: "page.md",
  };

  it("replaces each kind of directive with what it names", () => {
    const out = expand(
      "<!-- include: a.json -->\n<!-- include-section: r.md#Try it -->\n<!-- generated: table -->",
      context,
    );
    expect(out).toBe('```json\n{"a":1}\n```\nrun it\n| t |');
  });

  it("stops on a generator that does not exist, and lists the ones that do", () => {
    expect(() => expand("<!-- generated: nope -->", context)).toThrow(/page\.md asks for "nope".*table/);
  });

  it("stops on a section that does not exist", () => {
    expect(() => expand("<!-- include-section: r.md#Missing -->", context)).toThrow(
      /r\.md has no "## Missing"/,
    );
  });
});

describe("describe", () => {
  it("says what each kind of schema node holds", () => {
    expect(describeNode({ const: "0.1" })).toBe('always `"0.1"`');
    expect(describeNode({ enum: ["a", "b"] })).toBe("one of `a`, `b`");
    expect(describeNode({ type: "string", minLength: 1, maxLength: 120 })).toBe("text, 1 to 120 characters");
    expect(describeNode({ type: "string", pattern: "^[a-z][a-z0-9-]{1,63}$" })).toBe("an id");
    expect(describeNode({ type: "integer", minimum: 0 })).toBe("a whole number, at least 0");
    expect(describeNode({ type: "number", maximum: 10 })).toBe("a number, up to 10");
    expect(describeNode({ type: "boolean" })).toBe("true or false");
    expect(describeNode({ type: "array", maxItems: 3, items: { type: "boolean" } })).toBe(
      "a list, up to 3 items of true or false",
    );
    expect(describeNode({ type: "object", properties: { x: {} } })).toBe("an object with `x`");
    expect(describeNode({ type: ["string", "number", "null"], maxLength: 5 })).toBe(
      "text, up to 5 characters, a number or null",
    );
  });

  it("says so when it does not know, instead of guessing", () => {
    expect(describeNode({ oneOf: [] })).toBe("see the schema file");
  });
});

describe("fieldTable", () => {
  it("marks required fields, skips $schema and escapes pipes", () => {
    const table = fieldTable({
      required: ["a"],
      properties: { $schema: { type: "string" }, a: { type: "boolean" }, b: { enum: ["x|y"] } },
    });
    expect(table).toBe(
      [
        "| Field | Required | Holds |",
        "| --- | --- | --- |",
        "| `a` | yes | true or false |",
        "| `b` | no | one of `x\\|y` |",
      ].join("\n"),
    );
  });

  it("says a field is required unless a flag is true when `else` requires it", () => {
    const table = fieldTable({
      properties: { alt: { type: "boolean" }, decorative: { type: "boolean" } },
      if: { properties: { decorative: { const: true } }, required: ["decorative"] },
      else: { properties: { alt: {} }, required: ["alt"] },
    });
    expect(table).toContain("| `alt` | unless `decorative` is true | true or false |");
    expect(table).toContain("| `decorative` | no | true or false |");
  });
});

describe("the generated reference, from the real schemas", () => {
  const deck = json("packages/core/schema/deck.schema.json");
  const scene = json("packages/core/schema/scene.schema.json");
  const reference = schemaReference({ deck, scene });

  it("has a table for the deck, the scene and every block type", () => {
    const blocks = scene.properties.blocks.items.oneOf.map((variant) => variant.properties.type.const);
    expect(blocks.length).toBeGreaterThan(0);
    for (const type of blocks) expect(reference).toContain(`## Block: ${type}`);
    expect(reference).toContain("## Deck fields");
    expect(reference).toContain("## Scene fields");
  });

  it("describes every field, so a new kind of schema node is noticed", () => {
    expect(reference).not.toContain("see the schema file");
  });
});

describe("toolReference", () => {
  it("gives each tool a section with the description an agent reads", () => {
    expect(toolReference({ a: "does a", b: "does b" })).toBe("## a\n\ndoes a\n\n## b\n\ndoes b");
  });
});

describe("paletteCss", () => {
  const css = paletteCss(json("brand/tokens.json"));

  it("writes the dark palette for the default and the dark theme, and the light one for the light theme", () => {
    expect(css).toMatch(/:root,\n:root\[data-theme="dark"\] \{/);
    expect(css).toMatch(/:root\[data-theme="light"\] \{/);
  });

  it("carries every token the theme reads, in both palettes", () => {
    const theme = read("site/src/styles/theme.css");
    const used = [...theme.matchAll(/--dc-site-([a-z-]+)/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of new Set(used)) {
      expect(css.match(new RegExp(`--dc-site-${name}:`, "g"))?.length, `--dc-site-${name}`).toBe(2);
    }
  });
});
