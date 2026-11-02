import { describe, expect, it } from "vitest";
import {
  acceptChanges,
  applyOps,
  checkDeckFiles,
  createSession,
  type DeckFiles,
  type Doc,
  describeChange,
  docToFiles,
  FILE_REVERT_REASON,
  loadDoc,
  memoryDraftStore,
  type Op,
  readReview,
  recordAgentEdit,
  recoverDraft,
  revertChanges,
  reviewChanges,
  reviewToText,
  revisionOf,
  serializeDraft,
  startReview,
  type Template,
  type TemplateSlot,
  withBrandFile,
  withBrandHashes,
} from "../src/index.ts";
import { brandDir, brandDoc, demoDir, demoDoc, loadDir } from "./helpers.ts";

const hash = (c: string): string => c.repeat(64);
const BOLD = "brand/fonts/HarborSans-Bold.woff2";
const REGULAR = "brand/fonts/HarborSans-Regular.woff2";
const LOGO = "brand/logos/harbor.svg";
const SEA = "brand/images/sea.png";

/** The branded fixture as the CLI loads it: each font and logo with its hash in `text`, changed or added by `files`. */
function hashed(files: Record<string, string | null> = {}): Doc {
  const read = loadDir(brandDir);
  const text: Record<string, string> = {
    ...read.text,
    [BOLD]: hash("a"),
    [REGULAR]: hash("b"),
    [LOGO]: hash("c"),
  };
  const listed = new Set(read.brandFiles);
  for (const [path, value] of Object.entries(files)) {
    if (value === null) {
      delete text[path];
      listed.delete(path);
    } else {
      text[path] = value;
      listed.add(path);
    }
  }
  const loaded = loadDoc({ ...read, text, brandFiles: [...listed] } as DeckFiles);
  if (!loaded.doc) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.doc;
}

function applied(doc: Doc, ops: Op[]): Doc {
  const result = applyOps(doc, ops, revisionOf(doc));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.doc;
}

function refused(doc: Doc, ops: Op[]) {
  const result = applyOps(doc, ops, revisionOf(doc));
  if (result.ok) throw new Error("expected a refusal");
  return result;
}

const cover = (doc: Doc): Template => doc.templates?.cover as Template;

/** A slot as the template schema takes one, less its id. */
const SPARE: Omit<TemplateSlot, "id"> = {
  role: "body",
  frame: { x: 8, y: 62, w: 40, h: 6 },
  accepts: ["caption"],
  hint: "The date.",
};

describe("slot operations", () => {
  it("adds a slot after another, and the template is checked whole", () => {
    const doc = applied(brandDoc(), [
      {
        op: "slot.add",
        template: "cover",
        after: "title",
        slot: { id: "date", ...SPARE },
      },
    ]);
    expect(cover(doc).slots.map((slot) => slot.id)).toEqual(["kicker", "title", "date", "byline"]);
    const twice = refused(doc, [{ op: "slot.add", template: "cover", slot: { id: "date", ...SPARE } }]);
    expect(twice.diagnostics.map((d) => d.code)).toContain("duplicate-id");
  });

  it("changes a slot's fields with set, null taking one out, and never its id", () => {
    const doc = applied(brandDoc(), [
      { op: "slot.set", template: "cover", id: "kicker", set: { accepts: ["caption", "body"] } },
      { op: "slot.set", template: "cover", id: "title", set: { valign: null } },
    ]);
    const kicker = cover(doc).slots[0];
    expect(kicker).toMatchObject({ id: "kicker", accepts: ["caption", "body"] });
    expect("valign" in (cover(doc).slots[1] as object)).toBe(false);
    const renamed = refused(brandDoc(), [
      // The type leaves id out; an agent's JSON may still send it.
      { op: "slot.set", template: "cover", id: "kicker", set: { id: "label" } } as unknown as Op,
    ]);
    expect(renamed.diagnostics[0]).toMatchObject({ code: "forbidden-property", fix: "Use slot.rename." });
  });

  it("renames a slot and moves the blocks of every scene on the template, and says which scenes changed", () => {
    const before = brandDoc();
    const result = applyOps(
      before,
      [{ op: "slot.rename", template: "cover", id: "kicker", to: "label" }],
      revisionOf(before),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(cover(result.doc).slots.map((slot) => slot.id)).toEqual(["label", "title", "byline"]);
    expect(result.doc.scenes.welcome?.blocks.find((block) => block.id === "welcome-kicker")?.slot).toBe(
      "label",
    );
    expect(result.changed).toEqual(["welcome"]);
    // A scene on another template keeps its blocks as they were.
    expect(result.doc.scenes.growth).toBe(before.scenes.growth);
    const taken = refused(before, [{ op: "slot.rename", template: "cover", id: "kicker", to: "title" }]);
    expect(taken.diagnostics.map((d) => d.code)).toContain("duplicate-id");
  });

  it("moves no block of a scene on another template whose slot has the same id", () => {
    const before = brandDoc();
    // "growth" is on chart-and-note, which has a "title" slot of its own.
    expect(before.scenes.growth?.blocks.find((block) => block.id === "growth-title")?.slot).toBe("title");
    const result = applyOps(
      before,
      [{ op: "slot.rename", template: "cover", id: "title", to: "headline" }],
      revisionOf(before),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.doc.scenes.welcome?.blocks.find((block) => block.id === "welcome-title")?.slot).toBe(
      "headline",
    );
    expect(result.doc.scenes.growth).toBe(before.scenes.growth);
    expect(result.changed).toEqual(["welcome"]);
  });

  it("refuses to remove a slot that holds blocks, naming each, until `to` says where they go", () => {
    const blocked = refused(brandDoc(), [{ op: "slot.remove", template: "cover", id: "kicker" }]);
    expect(blocked.diagnostics[0]).toMatchObject({
      code: "slot-in-use",
      message: 'The slot "kicker" holds block "welcome-kicker" of scene "welcome".',
    });
    expect(blocked.diagnostics[0]?.fix).toContain("title, byline");
    const moved = applied(brandDoc(), [
      { op: "slot.set", template: "cover", id: "byline", set: { max: 2 } },
      { op: "slot.remove", template: "cover", id: "kicker", to: "byline" },
    ]);
    expect(cover(moved).slots.map((slot) => slot.id)).toEqual(["title", "byline"]);
    expect(
      moved.scenes.welcome?.blocks.filter((block) => block.slot === "byline").map((block) => block.id),
    ).toEqual(["welcome-kicker", "welcome-byline"]);
    const unknown = refused(brandDoc(), [
      { op: "slot.remove", template: "cover", id: "kicker", to: "nowhere" },
    ]);
    expect(unknown.diagnostics[0]?.code).toBe("unknown-slot");
  });

  it("pins the blocks of a removed slot where the slot was, with `to: null`", () => {
    const pinned = applied(brandDoc(), [{ op: "slot.remove", template: "cover", id: "kicker", to: null }]);
    const block = pinned.scenes.welcome?.blocks.find((found) => found.id === "welcome-kicker");
    expect(block?.slot).toBeUndefined();
    expect(block?.frame).toEqual({ x: 8, y: 20, w: 60, h: 8 });
  });

  it("removes an empty slot without `to`", () => {
    const doc = applied(brandDoc(), [
      { op: "slot.add", template: "cover", slot: { id: "spare", ...SPARE } },
      { op: "slot.remove", template: "cover", id: "spare" },
    ]);
    expect(cover(doc)).toEqual(cover(brandDoc()));
  });

  it("refuses Depthcue's own templates, with the template.set that copies one into the brand", () => {
    for (const op of [
      { op: "slot.add", template: "title", slot: { id: "x", ...SPARE } },
      { op: "slot.set", template: "title", id: "kicker", set: { hint: "x" } },
      { op: "slot.rename", template: "title", id: "kicker", to: "label" },
      { op: "slot.remove", template: "title", id: "kicker", to: null },
      { op: "template.set", id: "title", set: { name: "Mine" } },
    ] as Op[]) {
      const [found] = refused(brandDoc(), [op]).diagnostics;
      expect(found?.code, op.op).toBe("built-in-template");
      expect(found?.message).toBe('"title" is Depthcue\'s own template, which cannot be changed.');
      expect(found?.fix).toMatch(
        /^Copy it into the brand first, then change the copy: \{"op": "template\.set", "id": "title", "template": \{/,
      );
    }
  });

  it("refuses a slot operation on a deck with no brand, or on a template it does not have", () => {
    expect(
      refused(demoDoc(), [{ op: "slot.remove", template: "cover", id: "kicker" }]).diagnostics[0]?.code,
    ).toBe("no-brand");
    expect(
      refused(brandDoc(), [{ op: "slot.remove", template: "nothing", id: "kicker" }]).diagnostics[0]?.code,
    ).toBe("unknown-template");
  });
});

describe("template.set and style.set with set", () => {
  it("changes a template's fields, null removing one, and checks the result whole", () => {
    const doc = applied(brandDoc(), [
      { op: "template.set", id: "cover", set: { name: "Opening", chrome: null } },
    ]);
    expect(cover(doc).name).toBe("Opening");
    expect("chrome" in cover(doc)).toBe(false);
    expect(cover(doc).slots).toEqual(cover(brandDoc()).slots);
    const broken = refused(brandDoc(), [{ op: "template.set", id: "cover", set: { slots: [] } }]);
    expect(broken.code).toBe("invalid-deck");
  });

  it("takes either the whole template or set, not both and not neither, and never a new id", () => {
    const both = refused(brandDoc(), [
      { op: "template.set", id: "cover", template: cover(brandDoc()), set: { name: "x" } },
    ]);
    expect(both.diagnostics[0]?.code).toBe("forbidden-property");
    const neither = refused(brandDoc(), [{ op: "template.set", id: "cover" } as Op]);
    expect(neither.diagnostics[0]?.code).toBe("missing-property");
    const renamed = refused(brandDoc(), [
      { op: "template.set", id: "cover", set: { id: "other" } } as unknown as Op,
    ]);
    expect(renamed.diagnostics[0]?.code).toBe("forbidden-property");
    expect(
      refused(brandDoc(), [{ op: "template.set", id: "nothing", set: { name: "x" } }]).diagnostics[0]?.code,
    ).toBe("unknown-template");
  });

  it("changes a style's fields, and refuses Depthcue's own styles", () => {
    const doc = applied(brandDoc(), [
      { op: "style.set", id: "kicker", set: { case: null, tone: "evidence" } },
    ]);
    expect(doc.brand?.styles?.kicker).toEqual({
      name: "Kicker",
      for: ["caption"],
      weight: "bold",
      tone: "evidence",
    });
    const own = refused(brandDoc(), [{ op: "style.set", id: "callout", set: { pad: "s" } }]);
    expect(own.diagnostics[0]).toMatchObject({
      code: "built-in-style",
      message: '"callout" is Depthcue\'s own style, which cannot be changed.',
    });
    expect(own.diagnostics[0]?.fix).toContain('{"op": "style.set", "id": "callout", "style": {');
    expect(
      refused(brandDoc(), [{ op: "style.set", id: "nothing", set: { pad: "s" } }]).diagnostics[0]?.code,
    ).toBe("unknown-style");
  });

  it("leaves the whole-object forms as they were", () => {
    const whole = applied(brandDoc(), [
      { op: "template.set", id: "cover", template: { ...cover(brandDoc()), name: "W" } },
    ]);
    const patched = applied(brandDoc(), [{ op: "template.set", id: "cover", set: { name: "W" } }]);
    expect(whole.templates).toEqual(patched.templates);
    expect(revisionOf(whole)).toBe(revisionOf(patched));
  });
});

describe("brand files in the revision", () => {
  it("leaves a deck without brand files exactly as it was", () => {
    expect(withBrandHashes("0123456789abcdef", undefined)).toBe("0123456789abcdef");
    expect(withBrandHashes("0123456789abcdef", {})).toBe("0123456789abcdef");
    const doc = brandDoc();
    expect(doc.brandHashes).toBeUndefined();
    expect(revisionOf(doc)).toBe(revisionOf({ ...doc, brandFiles: undefined }));
  });

  it("changes when a file's bytes change, and carries the hashes through an edit", () => {
    const doc = hashed();
    expect(doc.brandHashes).toEqual({ [BOLD]: hash("a"), [REGULAR]: hash("b"), [LOGO]: hash("c") });
    expect(revisionOf(doc)).not.toBe(revisionOf(brandDoc()));
    expect(revisionOf(hashed({ [BOLD]: hash("d") }))).not.toBe(revisionOf(doc));
    const edited = applyOps(doc, [{ op: "brand.set", set: { name: "Harbor" } }], revisionOf(doc));
    expect(edited.ok && edited.doc.brandHashes).toEqual(doc.brandHashes);
  });

  it("reads a hash in `text` only as a hash: no check, template or written file takes one", () => {
    const read = loadDir(brandDir);
    const listed = [...(read.brandFiles ?? []), SEA];
    const hashes = { [BOLD]: hash("a"), [REGULAR]: hash("b"), [LOGO]: hash("c"), [SEA]: hash("f") };
    const files: DeckFiles = { ...read, text: { ...read.text, ...hashes }, brandFiles: listed };
    expect(checkDeckFiles(files)).toEqual(checkDeckFiles({ ...read, brandFiles: listed }));
    const doc = loadDoc(files).doc as Doc;
    expect(doc.templates).toEqual(brandDoc().templates);
    expect(doc.brandHashes).toEqual(hashes);
    expect(docToFiles(doc)).toEqual(docToFiles(brandDoc()));
    // Even a hash that is not one: whatever is under a brand file's path, nothing parses it.
    const odd = { ...files, text: { ...files.text, [BOLD]: "{not json" } };
    expect(checkDeckFiles(odd)).toEqual(checkDeckFiles(files));
  });

  it("does not count the files of a brand folder that deck.json does not name", () => {
    const plain = demoDoc();
    const files = loadDir(demoDir);
    const loaded = loadDoc({ ...files, text: { ...files.text, [BOLD]: hash("a") }, brandFiles: [BOLD] });
    expect(loaded.doc?.brandHashes).toEqual({ [BOLD]: hash("a") });
    expect(revisionOf(loaded.doc as Doc)).toBe(revisionOf(plain));
  });
});

describe("a brand file uploaded while the deck is open", () => {
  const SPACE = "brand/fonts/Space.ttf";
  /** What the server answers: the revisions of the deck on disk before the upload and after it. */
  const answer = (disk: Doc, path: string, value: string | null) => ({
    prevRev: revisionOf(disk),
    rev: revisionOf(withBrandFile(disk, path, value)),
  });

  it("adds, replaces and removes a file with its hash, as loading the folder would", () => {
    const added = withBrandFile(hashed(), SPACE, hash("e"));
    expect(added.brandHashes).toEqual(hashed({ [SPACE]: hash("e") }).brandHashes);
    expect(revisionOf(added)).toBe(revisionOf(hashed({ [SPACE]: hash("e") })));
    expect(revisionOf(withBrandFile(added, SPACE, hash("f")))).toBe(
      revisionOf(hashed({ [SPACE]: hash("f") })),
    );
    const removed = withBrandFile(hashed({ [SPACE]: hash("e") }), SPACE, null);
    expect(removed.brandFiles?.has(SPACE)).toBe(false);
    expect(removed.brandHashes).toEqual(hashed().brandHashes);
    expect(revisionOf(removed)).toBe(revisionOf(hashed()));
  });

  it("leaves a clean session clean, so its next save is not refused as stale", () => {
    const disk = hashed();
    const session = createSession(disk);
    const seen: string[] = [];
    session.subscribe((event) => seen.push(event.type));
    session.brandFile(SPACE, hash("e"), answer(disk, SPACE, hash("e")));
    expect(seen).toEqual(["files"]);
    expect(session.dirty).toBe(false);
    expect(session.rev).toBe(revisionOf(hashed({ [SPACE]: hash("e") })));
    session.apply([{ op: "brand.set", set: { name: "Harbor" } }]);
    expect(session.dirty).toBe(true);
    // Undo goes back to the deck with the file, which is what is on disk.
    session.undo();
    expect(session.dirty).toBe(false);
  });

  it("keeps unsaved edits unsaved, and gives every undo step the file", () => {
    const disk = hashed();
    const session = createSession(disk);
    session.apply([{ op: "brand.set", set: { name: "Harbor" } }]);
    session.brandFile(SPACE, hash("e"), answer(disk, SPACE, hash("e")));
    expect(session.dirty).toBe(true);
    expect(session.doc.brandHashes?.[SPACE]).toBe(hash("e"));
    session.undo();
    expect(session.doc.brandHashes?.[SPACE]).toBe(hash("e"));
    expect(session.dirty).toBe(false);
    session.redo();
    expect(session.rev).toBe(revisionOf(withBrandFile(session.doc, SPACE, hash("e"))));
    session.brandFile(SPACE, null, answer(withBrandFile(disk, SPACE, hash("e")), SPACE, null));
    expect(session.doc.brandFiles?.has(SPACE)).toBe(false);
    session.undo();
    expect([session.doc.brandFiles?.has(SPACE), session.dirty]).toEqual([false, false]);
  });

  it("does not call a session clean whose disk had already changed under it", () => {
    const disk = hashed();
    const session = createSession(disk);
    // Someone else saved first: the upload's prevRev is not what this session last saved.
    const moved = applied(disk, [{ op: "deck.set", set: { title: "Elsewhere" } }]);
    session.brandFile(SPACE, hash("e"), answer(moved, SPACE, hash("e")));
    expect(session.savedRev).toBe(revisionOf(disk));
    expect(session.dirty).toBe(true);
  });
});

describe("drafts and brand files", () => {
  it("keeps the files' hashes in a new draft", () => {
    const session = createSession(hashed());
    session.apply([{ op: "brand.set", set: { name: "Harbor" } }]);
    const text = serializeDraft(session, new Date(0));
    expect(JSON.parse(text).files).toEqual(hashed().brandHashes);
    const disk = hashed();
    const found = recoverDraft(memoryDraftStore(text), {
      assets: disk.assets,
      ...(disk.brandFiles ? { brandFiles: disk.brandFiles } : {}),
      savedRev: revisionOf(disk),
    });
    expect(found).toMatchObject({ status: "found", diskChanged: false });
  });

  it("recovers a draft from before files counted, with no work lost and no false warning", () => {
    // The draft an editor wrote before: no `files`, and both revisions without them.
    const old = createSession(brandDoc());
    old.apply([{ op: "brand.set", set: { name: "Harbor" } }]);
    const { files: _files, ...draft } = JSON.parse(serializeDraft(old, new Date(0)));
    const disk = hashed();
    const found = recoverDraft(memoryDraftStore(JSON.stringify(draft)), {
      assets: disk.assets,
      ...(disk.brandFiles ? { brandFiles: disk.brandFiles } : {}),
      savedRev: revisionOf(disk),
    });
    if (found.status !== "found") throw new Error(JSON.stringify(found));
    expect(found.diskChanged).toBe(false);
    expect(found.doc.brand?.name).toBe("Harbor");
    expect(found.doc.brandHashes).toEqual(disk.brandHashes);
    // A hand edit of the saved files since is still a change on disk.
    const edited = applied(disk, [{ op: "deck.set", set: { title: "Edited by hand" } }]);
    const later = recoverDraft(memoryDraftStore(JSON.stringify(draft)), {
      assets: edited.assets,
      ...(edited.brandFiles ? { brandFiles: edited.brandFiles } : {}),
      savedRev: revisionOf(edited),
    });
    expect(later).toMatchObject({ status: "found", diskChanged: true });
  });

  it("says the disk changed when a file was replaced after a new draft was written", () => {
    const session = createSession(hashed());
    session.apply([{ op: "brand.set", set: { name: "Harbor" } }]);
    const text = serializeDraft(session, new Date(0));
    const replaced = hashed({ [BOLD]: hash("e") });
    const found = recoverDraft(memoryDraftStore(text), {
      assets: replaced.assets,
      ...(replaced.brandFiles ? { brandFiles: replaced.brandFiles } : {}),
      savedRev: revisionOf(replaced),
    });
    expect(found).toMatchObject({ status: "found", diskChanged: true });
  });
});

const fileId = (path: string): string => `deck/file:${path.slice("brand/".length)}`;

describe("brand files in review", () => {
  it("lists each file added, replaced and removed as its own change", () => {
    const review = startReview(hashed());
    expect(review.files).toEqual(hashed().brandHashes);
    const now = hashed({ [BOLD]: hash("d"), [SEA]: hash("f") });
    const changes = reviewChanges(review, now);
    expect(changes.map((change) => change.id)).toEqual([fileId(BOLD), fileId(SEA)]);
    expect(changes[0]).toMatchObject({ kind: "changed", before: hash("a"), after: hash("d"), by: "outside" });
    expect(changes[1]).toMatchObject({ kind: "added", after: hash("f") });
    expect(changes.map((change) => describeChange(change))).toEqual([
      "Brand file fonts/HarborSans-Bold.woff2 changed",
      "Brand file images/sea.png added",
    ]);
    const gone = reviewChanges(startReview(now), hashed());
    expect(gone.find((change) => change.id === fileId(SEA))).toMatchObject({
      kind: "removed",
      before: hash("f"),
    });
  });

  it("accepts a file change, and never reverts one", () => {
    const review = startReview(hashed());
    const now = applied(hashed({ [BOLD]: hash("d") }), [{ op: "brand.set", set: { name: "Harbor" } }]);
    const accepted = acceptChanges(review, now, [fileId(BOLD)]);
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.diagnostics));
    expect(accepted.review.files?.[BOLD]).toBe(hash("d"));
    expect(reviewChanges(accepted.review, now).map((change) => change.id)).toEqual(["deck/brand/name"]);

    const reverted = revertChanges(review, now, "all");
    if (!reverted.ok) throw new Error(JSON.stringify(reverted.diagnostics));
    expect(reverted.reverted).toEqual(["deck/brand/name"]);
    expect(reverted.left).toEqual([{ id: fileId(BOLD), why: FILE_REVERT_REASON }]);
    expect(reverted.doc.brandHashes?.[BOLD]).toBe(hash("d"));
    expect(FILE_REVERT_REASON).toContain("cannot be reverted");
  });

  it("reverts the rest, and leaves a change whose reviewed value names a file that is gone, naming the file", () => {
    const DARK = "brand/logos/dark.svg";
    const logos = { light: "logos/harbor.svg", alt: "Harbor Analytics" };
    // Reviewed with a dark logo; since then the agent un-named it, removed the file, and renamed the brand.
    const reviewed = applied(hashed({ [DARK]: hash("9") }), [
      { op: "brand.set", set: { logos: { ...logos, dark: "logos/dark.svg" } } },
    ]);
    const review = startReview(reviewed);
    const now = applied(hashed(), [{ op: "brand.set", set: { name: "Renamed" } }]);
    expect(reviewChanges(review, now).map((change) => change.id)).toEqual([
      "deck/brand/name",
      "deck/brand/logos",
      fileId(DARK),
    ]);
    const reverted = revertChanges(review, now, "all");
    if (!reverted.ok) throw new Error(JSON.stringify(reverted.diagnostics));
    expect(reverted.reverted).toEqual(["deck/brand/name"]);
    expect(reverted.doc.brand?.name).toBe(reviewed.brand?.name);
    expect(reverted.doc.brand?.logos).toEqual(logos);
    expect(reverted.left).toEqual([
      {
        id: "deck/brand/logos",
        why: "brand/logos/dark.svg does not exist. Put the file back, then revert this change.",
      },
      { id: fileId(DARK), why: FILE_REVERT_REASON },
    ]);
    // Named alone, it is left the same way, and nothing else is touched.
    const alone = revertChanges(review, now, ["deck/brand/logos"]);
    expect(alone.ok && [alone.reverted, alone.left.map((left) => left.id), alone.rev]).toEqual([
      [],
      ["deck/brand/logos"],
      revisionOf(now),
    ]);
  });

  it("does not list a file already in the folder as added when the brand is made, or removed when it is taken off", () => {
    const files = loadDir(demoDir);
    const plain = loadDoc({ ...files, text: { ...files.text, [BOLD]: hash("a") }, brandFiles: [BOLD] })
      .doc as Doc;
    const made = applied(plain, [{ op: "brand.set", set: { id: "acme", name: "Acme" } }]);
    expect(reviewChanges(startReview(plain), made).map((change) => change.id)).toEqual(["deck/brand"]);
    const off = applied(made, [{ op: "brand.set", set: null }]);
    expect(reviewChanges(startReview(made), off).map((change) => change.id)).toEqual(["deck/brand"]);
    // A file that did change while the brand was made is still listed.
    const replaced = { ...made, brandHashes: { [BOLD]: hash("d") } };
    expect(reviewChanges(startReview(plain), replaced).map((change) => change.id)).toEqual([
      "deck/brand",
      fileId(BOLD),
    ]);
    // And with no brand on either side, the folder's files are no change at all.
    expect(reviewChanges(startReview(plain), { ...plain, brandHashes: { [BOLD]: hash("d") } })).toEqual([]);
  });

  it("refuses to accept a brand change without the file it names, and takes both together", () => {
    const review = startReview(hashed());
    const withFile = hashed({ "brand/logos/new.svg": hash("9") });
    const now = applied(withFile, [
      { op: "brand.set", set: { logos: { light: "logos/new.svg", alt: "New" } } },
    ]);
    const ids = reviewChanges(review, now).map((change) => change.id);
    expect(ids).toEqual(["deck/brand/logos", "deck/file:logos/new.svg"]);
    const alone = acceptChanges(review, now, ["deck/brand/logos"]);
    expect(alone.ok).toBe(false);
    expect(alone.ok ? [] : alone.diagnostics.map((d) => d.code)).toContain("missing-brand-file");
    const together = acceptChanges(review, now, ids);
    expect(together.ok && reviewChanges(together.review, now)).toEqual([]);
  });

  it("reads a review from before files were reviewed, and the agent's next edit takes them in", () => {
    const old = startReview(brandDoc());
    expect(old.files).toBeUndefined();
    const read = readReview(reviewToText(old));
    if (!read.ok || read.review === undefined) throw new Error("the old review should read");
    const before = hashed();
    // Until then the files are taken as they are: nothing to review.
    expect(reviewChanges(read.review, before)).toEqual([]);
    const after = hashed({ [BOLD]: hash("d") });
    const next = recordAgentEdit(read.review, before, after);
    expect(next.files).toEqual(before.brandHashes);
    expect(reviewChanges(next, after)).toMatchObject([{ id: fileId(BOLD), by: "agent" }]);
    const again = readReview(reviewToText(next));
    expect(again.ok && again.review).toEqual(next);
  });

  it("refuses a review whose files are not brand paths with sha256 hashes", () => {
    const review = startReview(hashed());
    for (const files of [{ "assets/x.png": hash("a") }, { [BOLD]: "not-a-hash" }, []]) {
      const read = readReview(reviewToText({ ...review, files } as never));
      expect(read.ok ? undefined : read.diagnostics[0]?.path, JSON.stringify(files)).toBe("/files");
    }
  });
});
