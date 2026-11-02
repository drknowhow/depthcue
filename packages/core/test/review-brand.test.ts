import { describe, expect, it } from "vitest";
import {
  acceptChanges,
  applyOps,
  type BlockStyle,
  type Doc,
  describeChange,
  docToFiles,
  foldEdit,
  type Op,
  recordAgentEdit,
  retemplate,
  revertChanges,
  reviewChanges,
  revisionOf,
  startReview,
  type Template,
} from "../src/index.ts";
import { brandDoc, demoDoc } from "./helpers.ts";

/** The branded fixture with some operations applied, which must all be valid. */
function applied(ops: Op[], doc: Doc = brandDoc()): Doc {
  const result = applyOps(doc, ops, revisionOf(doc));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.doc;
}

const ids = (changes: readonly { id: string }[]): string[] => changes.map((change) => change.id);

/** A template of the agent's own, a copy of the cover under another name, so a scene on the cover can move to it whole. */
const NOTE: Omit<Template, "id" | "schemaVersion"> = (() => {
  const {
    id: _id,
    schemaVersion: _version,
    ...cover
  } = (brandDoc().templates as Record<string, Template>).cover as Template;
  return { ...cover, name: "Note" };
})();

/** The operations that make the template `note` and move the scene `welcome` to it, as the agent would. */
const newTemplateAndScene = (): Op[] => {
  const withTemplate = applied([{ op: "template.set", id: "note", template: NOTE }]);
  return [
    { op: "template.set", id: "note", template: NOTE },
    ...retemplate(withTemplate, "welcome", { template: "note" }).ops,
  ];
};
describe("a review of the brand's own files", () => {
  const before = brandDoc();
  const review = startReview(before);

  it("lists nothing while the brand is as it was reviewed", () => {
    expect(reviewChanges(review, before)).toEqual([]);
  });

  it("lists each property of brand.json as its own change", () => {
    const named = applied([{ op: "brand.set", set: { name: "Harbor", lock: true } }]);
    const [name, lock, ...rest] = reviewChanges(review, named);
    expect(rest).toEqual([]);
    expect(name).toMatchObject({
      id: "deck/brand/name",
      scope: "deck",
      kind: "changed",
      field: "brand/name",
      before: "Harbor Analytics",
      after: "Harbor",
      by: "outside",
    });
    expect(name?.scene).toBeUndefined();
    expect(describeChange(name as never)).toBe("Brand name changed");
    expect(lock).toMatchObject({ id: "deck/brand/lock", kind: "added", after: true });
    // Nothing else in the file is a change, and neither is what an operation cannot write.
    expect(ids(reviewChanges(review, applied([{ op: "brand.set", set: { fonts: null } }])))).toEqual([
      "deck/brand/fonts",
    ]);
  });

  it("lists each style as its own change, added, changed and removed", () => {
    const shout: BlockStyle = { name: "Shout", for: ["heading"], case: "upper" };
    const doc = applied([
      { op: "style.set", id: "shout", style: shout },
      { op: "style.set", id: "kicker", style: null },
      {
        op: "style.set",
        id: "quiet-panel",
        style: { ...(before.brand?.styles?.["quiet-panel"] as BlockStyle), name: "Calm panel" },
      },
    ]);
    const changes = reviewChanges(review, doc);
    expect(changes.map((change) => `${change.id} ${change.kind}`)).toEqual([
      "deck/style:kicker removed",
      "deck/style:quiet-panel changed",
      "deck/style:shout added",
    ]);
    expect(changes[2]).toMatchObject({ field: "style:shout", after: shout, by: "outside" });
    expect(describeChange(changes[2] as never)).toBe('Style "shout" added');
  });

  it("lists each template as its own change, added, changed and removed", () => {
    const added = applied(newTemplateAndScene());
    expect(ids(reviewChanges(review, added))).toEqual(["deck/template:note", "scene:welcome/template"]);
    const [template] = reviewChanges(review, added);
    expect(template).toMatchObject({ kind: "added", scope: "deck", field: "template:note" });
    expect(describeChange(template as never)).toBe('Template "note" added');

    const edited = applied([
      {
        op: "template.set",
        id: "cover",
        template: { ...(before.templates?.cover as Template), name: "Front page" },
      },
    ]);
    const [changed] = reviewChanges(review, edited);
    expect(changed).toMatchObject({
      id: "deck/template:cover",
      kind: "changed",
      before: { name: "Cover" },
      after: { name: "Front page" },
    });

    const moved = retemplate(before, "welcome", { template: "section" }).ops;
    const removed = applied([...moved, { op: "template.set", id: "cover", template: null }]);
    expect(
      reviewChanges(review, removed).find((change) => change.id === "deck/template:cover"),
    ).toMatchObject({
      kind: "removed",
    });
  });

  it("lists the brand ahead of the scenes, so a person reads what they depend on first", () => {
    const both = applied(newTemplateAndScene());
    const changed = applied([{ op: "brand.set", set: { name: "Harbor" } }], both);
    expect(ids(reviewChanges(review, changed))).toEqual([
      "deck/brand/name",
      "deck/template:note",
      "scene:welcome/template",
    ]);
  });
});

describe("accepting a change of the brand's files", () => {
  const before = brandDoc();
  const review = startReview(before);

  it("copies brand.json into the reviewed deck and leaves the templates to be reviewed", () => {
    const doc = applied([{ op: "brand.set", set: { name: "Harbor" } }, ...newTemplateAndScene()]);
    const accepted = acceptChanges(review, doc, ["deck/brand/name"]);
    expect(accepted).toMatchObject({ ok: true, accepted: ["deck/brand/name"] });
    if (!accepted.ok) return;
    expect(accepted.review.brand?.name).toBe("Harbor");
    expect(Object.keys(accepted.review.templates ?? {}).sort()).toEqual(["chart-and-note", "cover"]);
    expect(ids(reviewChanges(accepted.review, doc))).toEqual([
      "deck/template:note",
      "scene:welcome/template",
    ]);
  });

  it("refuses a scene that names a template the review has not taken yet, and takes it with the template", () => {
    const doc = applied(newTemplateAndScene());
    const refused = acceptChanges(review, doc, ["scene:welcome/template"]);
    expect(refused).toMatchObject({
      ok: false,
      code: "invalid-deck",
      diagnostics: [expect.objectContaining({ code: "unknown-template" })],
    });
    const both = acceptChanges(review, doc, ["deck/template:note", "scene:welcome/template"]);
    expect(both).toMatchObject({ ok: true });
    if (both.ok) expect(reviewChanges(both.review, doc)).toEqual([]);
  });

  it("checks what it copies, so a brand the reviewed deck cannot hold is refused", () => {
    // The reviewed deck keeps a template the current brand dropped; taking the brand alone is fine, and it is the
    // scene that names the template that cannot be accepted without it.
    const doc = applied([
      ...retemplate(before, "welcome", { template: "section" }).ops,
      { op: "template.set", id: "cover", template: null },
    ]);
    const ok = acceptChanges(review, doc, ["deck/template:cover"]);
    expect(ok).toMatchObject({ ok: false, code: "invalid-deck" });
  });

  it("takes all of it at once", () => {
    const doc = applied([{ op: "brand.set", set: { name: "Harbor" } }, ...newTemplateAndScene()]);
    const accepted = acceptChanges(review, doc, "all");
    expect(accepted).toMatchObject({ ok: true });
    if (accepted.ok) expect(accepted.review.rev).toBe(revisionOf(doc));
  });

  it("copies a new brand with its styles and templates when the deck had none", () => {
    const bare = demoDoc();
    const unbranded = startReview(bare);
    const doc = applied(
      [
        { op: "brand.set", set: { id: "acme", name: "Acme" } },
        { op: "style.set", id: "shout", style: { name: "Shout", for: ["heading"], case: "upper" } },
        { op: "template.set", id: "note", template: NOTE },
      ],
      bare,
    );
    expect(ids(reviewChanges(unbranded, doc))).toEqual(["deck/brand", "deck/template:note"]);
    const both = acceptChanges(unbranded, doc, ["deck/brand", "deck/template:note"]);
    expect(both).toMatchObject({ ok: true });
    if (!both.ok) return;
    expect(both.review.brand?.styles).toHaveProperty("shout");
    expect(Object.keys(both.review.templates ?? {})).toEqual(["note"]);
    // A template with no brand to hold it is the change that needs the other.
    expect(acceptChanges(unbranded, doc, ["deck/template:note"])).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "no-brand" })]),
    });
    const reverted = revertChanges(unbranded, doc, "all");
    expect(reverted).toMatchObject({ ok: true });
    // (The first operation on a 0.1 deck raised it to 0.4, which a revert does not undo.)
    if (reverted.ok) expect(reverted.doc.brand).toBeUndefined();
  });
});
describe("reverting a change of the brand's files", () => {
  const before = brandDoc();
  const review = startReview(before);

  it("puts brand.json back by operations on the current deck, styles included", () => {
    const doc = applied([
      { op: "brand.set", set: { name: "Harbor", lock: true } },
      { op: "style.set", id: "shout", style: { name: "Shout", for: ["heading"], case: "upper" } },
      { op: "style.set", id: "kicker", style: null },
    ]);
    const every = ["deck/brand/name", "deck/brand/lock", "deck/style:kicker", "deck/style:shout"];
    const reverted = revertChanges(review, doc, every);
    expect(reverted).toMatchObject({ ok: true, reverted: every, brandChanged: true });
    if (!reverted.ok) return;
    expect(revisionOf(reverted.doc)).toBe(revisionOf(before));
    expect(reviewChanges(reverted.review, reverted.doc)).toEqual([]);
  });

  it("refuses one edit and keeps another, a color and a style that a block now uses", () => {
    const shout: BlockStyle = { name: "Shout", for: ["heading"], case: "upper" };
    const colors = before.brand?.colors as NonNullable<typeof before.brand>["colors"];
    const doc = applied([
      { op: "brand.set", set: { colors: { ...colors, paper: { ...colors?.paper, line: "#9A9A9A" } } } },
      { op: "style.set", id: "shout", style: shout },
      { op: "block.set", scene: "welcome", id: "welcome-title", set: { style: "shout" } },
    ]);
    expect(ids(reviewChanges(review, doc))).toEqual([
      "deck/brand/colors",
      "deck/style:shout",
      "scene:welcome/block:welcome-title/style",
    ]);
    // Accept the style and the block that uses it, revert the color.
    const accepted = acceptChanges(review, doc, [
      "deck/style:shout",
      "scene:welcome/block:welcome-title/style",
    ]);
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) return;
    expect(ids(reviewChanges(accepted.review, doc))).toEqual(["deck/brand/colors"]);
    const reverted = revertChanges(accepted.review, doc, ["deck/brand/colors"]);
    expect(reverted).toMatchObject({ ok: true, reverted: ["deck/brand/colors"] });
    if (!reverted.ok) return;
    expect(reverted.doc.brand?.colors).toEqual(colors);
    expect(reverted.doc.brand?.styles).toHaveProperty("shout");
    expect(reviewChanges(reverted.review, reverted.doc)).toEqual([]);
    // The block's style is a change of the scene, so a style alone cannot be taken back from under it. (The fixture's
    // light-only logo is warned of too, as on every check of it.)
    expect(revertChanges(review, doc, ["deck/style:shout"])).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: "logo-without-dark" }),
        expect.objectContaining({ code: "unknown-style" }),
      ],
    });
  });

  it("reverts one style and keeps another", () => {
    const doc = applied([
      { op: "style.set", id: "shout", style: { name: "Shout", for: ["heading"], case: "upper" } },
      { op: "style.set", id: "calm", style: { name: "Calm", for: ["body"] } },
    ]);
    const reverted = revertChanges(review, doc, ["deck/style:shout"]);
    expect(reverted).toMatchObject({ ok: true, reverted: ["deck/style:shout"] });
    if (!reverted.ok) return;
    expect(Object.keys(reverted.doc.brand?.styles ?? {}).sort()).toEqual(["calm", "kicker", "quiet-panel"]);
    expect(ids(reviewChanges(reverted.review, reverted.doc))).toEqual(["deck/style:calm"]);
  });

  it("takes a template the agent added out again, and brings a removed one back", () => {
    const doc = applied(newTemplateAndScene());
    const reverted = revertChanges(review, doc, "all");
    expect(reverted).toMatchObject({ ok: true });
    if (reverted.ok) expect(revisionOf(reverted.doc)).toBe(revisionOf(before));

    const gone = applied([
      ...retemplate(before, "welcome", { template: "section" }).ops,
      { op: "template.set", id: "cover", template: null },
    ]);
    const back = revertChanges(review, gone, "all");
    expect(back).toMatchObject({ ok: true });
    if (back.ok) {
      expect(revisionOf(back.doc)).toBe(revisionOf(before));
      expect(Object.keys(docToFiles(back.doc))).toContain("brand/templates/cover.json");
    }
  });

  it("refuses a template that a scene of the agent's still needs, and says so", () => {
    const doc = applied(newTemplateAndScene());
    const refused = revertChanges(review, doc, ["deck/template:note"]);
    expect(refused).toMatchObject({ ok: false, code: "invalid-deck" });
    expect(refused.ok ? [] : refused.diagnostics.map((d) => d.code)).toEqual([
      "logo-without-dark",
      "unknown-template",
    ]);
  });

  it("lists a brand the agent took off the deck as one change, and brings it back with its templates on a revert", () => {
    const doc = applied([
      ...retemplate(before, "welcome", { layout: "title" }).ops,
      ...retemplate(before, "growth", { layout: "claim-evidence" }).ops,
      { op: "block.set", scene: "context", id: "context-body", set: { style: null } },
      { op: "brand.set", set: null },
    ]);
    expect(doc.brand).toBeUndefined();
    const changes = reviewChanges(review, doc);
    expect(changes.find((change) => change.id === "deck/brand")).toMatchObject({ kind: "removed" });
    // Its templates went with it, and are listed as removed, so a revert of the whole brings each back.
    expect(ids(changes).filter((id) => id.startsWith("deck/template:"))).toEqual([
      "deck/template:chart-and-note",
      "deck/template:cover",
    ]);
    const accepted = acceptChanges(review, doc, ["deck/brand"]);
    expect(accepted).toMatchObject({ ok: false });
    const back = revertChanges(review, doc, "all");
    expect(back).toMatchObject({ ok: true });
    if (back.ok) expect(back.doc.brand?.id).toBe("harbor");
  });
});
describe("a deck that changed to another brand", () => {
  const before = brandDoc();
  const review = startReview(before);
  const swapped = (): Doc => {
    // The scenes leave the old brand's templates first, as `depthcue brand use` would require.
    const away: Op[] = [
      ...retemplate(before, "welcome", { template: "section" }).ops,
      ...retemplate(before, "growth", { template: "two-column" }).ops,
      { op: "block.set", scene: "context", id: "context-body", set: { style: null } },
    ];
    return applied([
      ...away,
      { op: "brand.set", set: null },
      { op: "brand.set", set: { id: "acme", name: "Acme" } },
      { op: "template.set", id: "note", template: NOTE },
    ]);
  };

  it("is one change of brand.json, and each template is listed as what changed from the old brand's", () => {
    const doc = swapped();
    const changes = reviewChanges(review, doc);
    expect(changes.find((change) => change.id === "deck/brand")).toMatchObject({
      kind: "changed",
      before: { id: "harbor" },
      after: { id: "acme" },
    });
    expect(
      changes
        .filter((change) => change.id.startsWith("deck/template:"))
        .map((change) => `${change.id} ${change.kind}`),
    ).toEqual([
      "deck/template:note added",
      "deck/template:chart-and-note removed",
      "deck/template:cover removed",
    ]);
  });

  it("is accepted and reverted whole", () => {
    const doc = swapped();
    const accepted = acceptChanges(review, doc, "all");
    expect(accepted).toMatchObject({ ok: true });
    const reverted = revertChanges(review, doc, "all");
    expect(reverted).toMatchObject({ ok: true });
    if (!reverted.ok) return;
    expect(reverted.doc.brand?.id).toBe("harbor");
    expect(Object.keys(reverted.doc.templates ?? {}).sort()).toEqual(["chart-and-note", "cover"]);
    expect(revisionOf(reverted.doc)).toBe(revisionOf(before));
  });

  it("brings the new brand's templates with it when its brand.json is accepted, with the scenes that need them", () => {
    const doc = swapped();
    const every = reviewChanges(review, doc).map((change) => change.id);
    // The scenes of the reviewed deck still name the old brand's templates, so the brand alone is refused.
    expect(acceptChanges(review, doc, ["deck/brand"])).toMatchObject({ ok: false, code: "invalid-deck" });
    const accepted = acceptChanges(review, doc, every);
    expect(accepted).toMatchObject({ ok: true });
    if (!accepted.ok) return;
    expect(accepted.review.brand?.id).toBe("acme");
    expect(Object.keys(accepted.review.templates ?? {})).toEqual(["note"]);
    expect(reviewChanges(accepted.review, doc)).toEqual([]);
  });
});
describe("whose change it is", () => {
  const before = brandDoc();
  const review = startReview(before);

  it("marks a change of the brand the agent made as the agent's, and a person's own edit as reviewed", () => {
    const agent = applied([{ op: "brand.set", set: { name: "Harbor" } }]);
    const recorded = recordAgentEdit(review, before, agent);
    expect(reviewChanges(recorded, agent)).toMatchObject([{ id: "deck/brand/name", by: "agent" }]);

    // A person then renames a template; theirs is folded into the reviewed deck and leaves only the agent's.
    const edited = applied(
      [
        {
          op: "template.set",
          id: "cover",
          template: { ...(agent.templates?.cover as Template), name: "Front page" },
        },
      ],
      agent,
    );
    const folded = foldEdit(recorded, agent, edited);
    expect(reviewChanges(folded, edited)).toMatchObject([{ id: "deck/brand/name", by: "agent" }]);
    expect(folded.templates?.cover?.name).toBe("Front page");
  });
});
