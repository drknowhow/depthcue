import { describe, expect, it } from "vitest";
import { type ApplyResult, applyOps, type Doc, parseTarget, revisionOf } from "../src/index.ts";
import { demoDoc } from "./helpers.ts";

const run = (doc: Doc, ops: unknown) => applyOps(doc, ops, revisionOf(doc));
const ok = (result: ApplyResult) => {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
};
const codes = (result: ApplyResult) => result.diagnostics.map((d) => d.code);

const add = (id: string, target: string) => ({ op: "link.add", link: { id, title: id, target } });
const use = (id: string) => ({
  op: "block.set",
  scene: "opening",
  id: "opening-title",
  set: { link: id },
});

describe("parseTarget", () => {
  it.each([
    ["https://example.com/a?b=1", "address"],
    ["mailto:a@example.com", "address"],
    ["tel:+1-555-0100", "address"],
    ["assets/report.pdf", "asset"],
    ["scene:opening#first", "scene"],
    ["path:Y:\\Projects\\Depthcue", "path"],
    ["path:/home/me/docs", "path"],
  ])("reads %s as a %s", (text, kind) => {
    expect(parseTarget(text)?.kind).toBe(kind);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "https://a b.com",
    "https://a.com/<x>",
    "assets/../secret.pdf",
    "path:",
    "path:https://example.com",
    "path:a\nb",
    "ftp://example.com",
  ])("refuses %s", (text) => {
    expect(parseTarget(text)).toBeUndefined();
  });
});

describe("the link operations", () => {
  it("adds a link, raises the deck to 0.5 and lets a block use it", () => {
    const added = ok(run(demoDoc(), [add("report", "assets/report.csv")]));
    expect(added.doc.deck.schemaVersion).toBe("0.5");
    const used = ok(applyOps(added.doc, [use("report")], added.rev));
    expect(used.doc.scenes.opening?.schemaVersion).toBe("0.5");
  });

  it("refuses a block that names a link the deck lacks", () => {
    const failed = run(demoDoc(), [use("missing")]);
    expect(failed.ok).toBe(false);
    expect(codes(failed)).toContain("unknown-link");
  });

  it("refuses a target that is not one of the forms", () => {
    const failed = run(demoDoc(), [add("bad", "javascript:alert(1)")]);
    expect(codes(failed)).toContain("bad-link-target");
  });

  it("refuses a link to a deck file that is not there", () => {
    expect(codes(run(demoDoc(), [add("gone", "assets/missing.pdf")]))).toContain("missing-asset");
  });

  it("refuses a scene target that is not in the deck", () => {
    expect(codes(run(demoDoc(), [add("jump", "scene:nowhere")]))).toContain("unknown-link-scene");
  });

  it("warns about a local path and an http address without refusing them", () => {
    const result = ok(run(demoDoc(), [add("here", "path:Y:\\docs"), add("old", "http://example.com")]));
    expect(codes(result)).toEqual(expect.arrayContaining(["link-local-path", "link-insecure"]));
  });

  it("changes a link once for every use", () => {
    const first = ok(run(demoDoc(), [add("site", "https://example.com"), use("site")]));
    const next = ok(
      applyOps(
        first.doc,
        [{ op: "link.set", id: "site", set: { target: "https://example.org" } }],
        first.rev,
      ),
    );
    expect(next.doc.deck.links?.[0]?.target).toBe("https://example.org");
    expect(next.doc.scenes.opening?.blocks[0]).toMatchObject({ link: "site" });
  });

  it("refuses to remove a link that is in use, and says where", () => {
    const first = ok(run(demoDoc(), [add("site", "https://example.com"), use("site")]));
    const failed = applyOps(first.doc, [{ op: "link.remove", id: "site" }], first.rev);
    expect(failed.ok).toBe(false);
    expect(codes(failed)).toContain("link-in-use");
  });

  it("moves the uses to another link when removing one", () => {
    const first = ok(
      run(demoDoc(), [add("old", "https://example.com"), add("new", "https://example.org"), use("old")]),
    );
    const next = ok(applyOps(first.doc, [{ op: "link.remove", id: "old", to: "new" }], first.rev));
    expect(next.doc.deck.links?.map((link) => link.id)).toEqual(["new"]);
    expect(next.doc.scenes.opening?.blocks[0]).toMatchObject({ link: "new" });
  });

  it("removes an unused link and the empty library with it", () => {
    const first = ok(run(demoDoc(), [add("site", "https://example.com")]));
    const next = ok(applyOps(first.doc, [{ op: "link.remove", id: "site" }], first.rev));
    expect(next.doc.deck.links).toBeUndefined();
  });

  it("refuses to remove a scene that a link jumps to", () => {
    const first = ok(run(demoDoc(), [add("jump", "scene:opening")]));
    const failed = applyOps(first.doc, [{ op: "scene.remove", id: "opening" }], first.rev);
    expect(codes(failed)).toContain("unknown-link-scene");
  });

  it("keeps links out of deck.set", () => {
    const failed = run(demoDoc(), [{ op: "deck.set", set: { links: [] } }]);
    expect(failed.ok).toBe(false);
  });
});
