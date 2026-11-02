// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  applyOps,
  type Block,
  createSession,
  type Doc,
  loadDoc,
  type Op,
  retemplate,
  revisionOf,
  type Scene,
  type Template,
} from "@depthcue/core";
import { renderScene } from "@depthcue/player";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changeTemplate,
  drawSlots,
  keyOf,
  optionsOf,
  pickTemplate,
  planOf,
  sceneFor,
  styleOps,
  stylePreview,
  styleSection,
  templateScene,
} from "../src/branduse.ts";
import { removeClaim } from "../src/cleanup.ts";
import { describeBlock } from "../src/templates.ts";

const decks = resolve(import.meta.dirname, "../../../fixtures/decks");

/** A fixture deck as core reads it, with its brand's files listed. */
function fixture(name: string): Doc {
  const root = join(decks, name);
  const text: Record<string, string> = {};
  const assets: string[] = [];
  const brandFiles: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      const path = relative(root, full).split(sep).join("/");
      if (statSync(full).isDirectory()) walk(full);
      else if (path.endsWith(".json")) text[path] = readFileSync(full, "utf8");
      else if (path.startsWith("brand/")) brandFiles.push(path);
      else assets.push(path);
    }
  };
  walk(root);
  const { doc, diagnostics } = loadDoc({ text, assets, brandFiles });
  if (!doc) throw new Error(`${name} should load: ${JSON.stringify(diagnostics)}`);
  return doc;
}

const harbor = () => fixture("v0-4-brand");
const plain = () => fixture("v0-3");

/** The deck with `change` made to its brand, as a brand.set would leave it. */
const withBrand = (doc: Doc, change: Partial<NonNullable<Doc["brand"]>>): Doc => ({
  ...doc,
  brand: { ...(doc.brand as NonNullable<Doc["brand"]>), ...change },
});

/** A scene drawn by the player, as the editor's canvas and the thumbnails draw it. */
const drawn = (scene: Scene) => {
  const view = document.createElement("div");
  view.append(renderScene(scene, { assetBase: "" }));
  document.body.append(view);
  return view;
};

const sceneOf = (doc: Doc, id: string) => doc.scenes[id] as Scene;
const blockOf = (scene: Scene, id: string) => scene.blocks.find((block) => block.id === id) as Block;

afterEach(() => {
  document.body.replaceChildren();
});

describe("the templates a scene can have", () => {
  it("lists the brand's templates, then Depthcue's own, then the three layouts", () => {
    const options = optionsOf(harbor());
    const groups = [...new Set(options.map((option) => option.group))];
    expect(groups).toEqual(["Harbor Analytics", "Built in", "Layouts"]);
    // The brand's in the order its files are read, which is by id.
    expect(
      options.filter((option) => option.group === "Harbor Analytics").map((option) => keyOf(option.to)),
    ).toEqual(["template:chart-and-note", "template:cover"]);
    expect(options.filter((option) => option.group === "Layouts").map((option) => keyOf(option.to))).toEqual([
      "layout:title",
      "layout:claim-evidence",
      "layout:text-media",
    ]);
    expect(options.filter((option) => option.group === "Built in").length).toBeGreaterThan(3);
    // Each says what it is for, in the template's own words.
    expect(options[1]?.about).toMatch(/^The first slide/);
  });

  it("shows a template the brand replaces once, as the brand's", () => {
    const doc = harbor();
    const builtIn = optionsOf(doc).find((option) => keyOf(option.to) === "template:quote");
    expect(builtIn?.group).toBe("Built in");
    const own: Template = { ...(doc.templates?.cover as Template), id: "quote", name: "Harbor quote" };
    const options = optionsOf({ ...doc, templates: { ...doc.templates, quote: own } });
    const quotes = options.filter((option) => keyOf(option.to) === "template:quote");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ group: "Harbor Analytics", name: "Harbor quote" });
  });

  it("leaves Depthcue's own out when the brand hides them", () => {
    const options = optionsOf(withBrand(harbor(), { hideBuiltIn: ["templates"] }));
    expect(options.some((option) => option.group === "Built in")).toBe(false);
    expect(options.filter((option) => option.group === "Layouts")).toHaveLength(3);
  });

  it("gives a deck with no brand Depthcue's own and the layouts", () => {
    const groups = [...new Set(optionsOf(plain()).map((option) => option.group))];
    expect(groups).toEqual(["Built in", "Layouts"]);
  });
});

describe("a new scene from a template", () => {
  it("starts with one text, in the first slot that takes a heading, and adds as one valid operation", () => {
    const doc = harbor();
    const scene = templateScene(doc, "cover");
    expect(scene).toMatchObject({ template: "cover", title: "New scene" });
    expect(scene.blocks).toEqual([
      expect.objectContaining({ type: "text", role: "heading", slot: "title", text: "New scene" }),
    ]);
    const result = applyOps(doc, [{ op: "scene.add", scene, after: "welcome" }], revisionOf(doc));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc.deck.scenes).toEqual(["welcome", scene.id, "context", "growth"]);
  });

  it("gets an id no scene has", () => {
    const doc = harbor();
    const first = templateScene(doc, "cover");
    const added = applyOps(doc, [{ op: "scene.add", scene: first, after: null }], revisionOf(doc));
    if (!added.ok) throw new Error("the first add should work");
    expect(templateScene(added.doc, "cover").id).not.toBe(first.id);
  });

  it("pins its text over a template with no slot for text", () => {
    const doc = harbor();
    const picture: Template = {
      ...(doc.templates?.cover as Template),
      id: "picture",
      slots: [
        {
          id: "picture",
          role: "content",
          frame: { x: 0, y: 0, w: 100, h: 100 },
          accepts: ["image"],
          hint: "A picture.",
        },
      ],
    };
    const withPicture = { ...doc, templates: { ...doc.templates, picture } };
    const scene = templateScene(withPicture, "picture");
    expect(scene.blocks[0]).toMatchObject({ role: "body", frame: { x: 8, y: 8, w: 84, h: 16 } });
    expect(scene.blocks[0]?.slot).toBeUndefined();
  });

  it("makes a layout scene for a layout", () => {
    const scene = sceneFor(harbor(), { layout: "text-media" });
    expect(scene).toMatchObject({ layout: "text-media" });
    expect("template" in scene).toBe(false);
  });
});

describe("the empty slots of a template scene", () => {
  /** The cover with only its title filled. */
  const bare = () => {
    const doc = harbor();
    const scene = sceneOf(doc, "welcome");
    return { doc, scene: { ...scene, blocks: [blockOf(scene, "welcome-title")] } };
  };

  it("draws each empty slot at its frame with the template's hint, and marks the required ones", () => {
    const doc = harbor();
    const growth = sceneOf(doc, "growth");
    const scene = { ...growth, blocks: growth.blocks.filter((block) => block.slot !== "chart") };
    const view = drawn(scene);
    drawSlots(doc, scene, view);
    const slots = [...view.querySelectorAll<HTMLElement>(".ed-slot")];
    expect(slots.map((slot) => slot.dataset.slot)).toEqual(["chart"]);
    const [chart] = slots as [HTMLElement];
    expect(chart.hasAttribute("data-required")).toBe(true);
    expect(chart.querySelector(".ed-slot-hint")?.textContent).toBe(
      "The chart or table that shows the finding.",
    );
    expect(chart.querySelector(".ed-slot-required")?.textContent).toBe("Required");
    expect(chart.style.getPropertyValue("--x")).toBe("6");
    expect(chart.style.getPropertyValue("--w")).toBe("58");
    // It sits in the slide, with the slots the player drew.
    expect(chart.parentElement?.classList.contains("dc-scene")).toBe(true);
  });

  it("counts the claim as what fills a claim slot", () => {
    const doc = plain();
    const data = sceneOf(doc, "data");
    const { layout: _layout, ...rest } = data;
    const statement = { ...rest, template: "statement", blocks: [] } as Scene;
    const slotsOf = (scene: Scene) => {
      const view = drawn(scene);
      drawSlots(doc, scene, view);
      return [...view.querySelectorAll<HTMLElement>(".ed-slot")].map((slot) => slot.dataset.slot);
    };
    expect(statement.summary).toBeDefined();
    expect(slotsOf(statement)).toEqual(["evidence"]);
    const { summary: _summary, ...bare } = statement;
    expect(slotsOf(bare as Scene)).toEqual(["claim", "evidence"]);
  });

  it("draws nothing for a filled slot, or for a scene with a layout", () => {
    const doc = harbor();
    const view = drawn(sceneOf(doc, "welcome"));
    drawSlots(doc, sceneOf(doc, "welcome"), view);
    expect(view.querySelector(".ed-slot")).toBeNull();
    const layout = drawn(sceneOf(doc, "context"));
    drawSlots(doc, sceneOf(doc, "context"), layout);
    expect(layout.querySelector(".ed-slot")).toBeNull();
  });

  it("adds at once to a slot that takes one kind, and names what it adds", () => {
    const { doc, scene } = bare();
    const add = vi.fn();
    const view = drawn(scene);
    drawSlots(doc, scene, view, { add, claim: vi.fn(), hasVideo: () => false });
    const kicker = view.querySelector<HTMLButtonElement>(
      "[data-slot='kicker'] .ed-slot-add",
    ) as HTMLButtonElement;
    expect(kicker.getAttribute("aria-label")).toBe("Add caption to the kicker slot");
    kicker.click();
    expect(add).toHaveBeenCalledWith("kicker", "caption");
  });

  it("asks which kind for a slot that takes more than one", () => {
    const { doc, scene } = bare();
    const add = vi.fn();
    const view = drawn(scene);
    drawSlots(doc, scene, view, { add, claim: vi.fn(), hasVideo: () => false });
    const byline = view.querySelector<HTMLElement>("[data-slot='byline']") as HTMLElement;
    const open = byline.querySelector<HTMLButtonElement>(".ed-slot-add") as HTMLButtonElement;
    const menu = byline.querySelector<HTMLElement>(".ed-slot-menu") as HTMLElement;
    expect(menu.hidden).toBe(true);
    open.click();
    expect(menu.hidden).toBe(false);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect([...menu.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["Text", "Caption"]);
    (menu.querySelector("[data-slot-kind='caption']") as HTMLButtonElement).click();
    expect(add).toHaveBeenCalledWith("byline", "caption");
    // Esc puts the menu away and the keyboard back on the slot.
    open.click();
    open.click();
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
  });

  it("keeps a clip slot shut while the deck has no video", () => {
    const doc = harbor();
    const film: Template = {
      ...(doc.templates?.cover as Template),
      id: "film",
      slots: [
        {
          id: "title",
          role: "title",
          frame: { x: 8, y: 8, w: 84, h: 12 },
          accepts: ["heading"],
          hint: "The title.",
        },
        {
          id: "film",
          role: "content",
          frame: { x: 8, y: 24, w: 84, h: 66 },
          accepts: ["clip"],
          hint: "A film.",
        },
      ],
    };
    const withFilm = { ...doc, templates: { ...doc.templates, film } };
    const scene = { ...templateScene(withFilm, "film"), schemaVersion: "0.4" } as Scene;
    const view = drawn(scene);
    drawSlots(withFilm, scene, view, { add: vi.fn(), claim: vi.fn(), hasVideo: () => false });
    const button = view.querySelector<HTMLButtonElement>(
      "[data-slot='film'] .ed-slot-add",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/assets folder/);
  });

  it("never reaches what the player draws: the slide without the hook has no hint", () => {
    const { scene } = bare();
    const view = drawn(scene);
    expect(view.querySelector(".ed-slot")).toBeNull();
    expect(view.textContent).not.toContain("A short label above the title");
  });
});

describe("the template picker", () => {
  it("is a dialog of buttons, one for each template and layout, each with its picture and what it is for", () => {
    const doc = harbor();
    const root = document.createElement("div");
    document.body.append(root);
    pickTemplate(createSession(doc), root, { add: () => undefined });
    const dialog = root.querySelector<HTMLDialogElement>("dialog[data-dialog='picker']") as HTMLDialogElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    const picks = [...dialog.querySelectorAll<HTMLButtonElement>(".ed-pick")];
    expect(picks.map((pick) => pick.dataset.pick)).toEqual(optionsOf(doc).map((option) => keyOf(option.to)));
    const cover = picks[1] as HTMLButtonElement;
    expect(cover.dataset.pick).toBe("template:cover");
    // The picture is the player's drawing, in the deck's look, with the slots it leaves empty and their hints.
    expect(cover.querySelector(".ed-mini .dc-player .dc-scene")).not.toBeNull();
    expect(cover.querySelector(".ed-mini .ed-slot-hint")?.textContent).toBe(
      "A short label above the title, such as the quarter.",
    );
    expect(cover.querySelector(".ed-mini")?.getAttribute("aria-hidden")).toBe("true");
    // Named by its name alone and described by what it is for, so neither is read twice.
    const name = document.getElementById(cover.getAttribute("aria-labelledby") as string);
    expect(name?.textContent).toBe("Cover");
    const about = document.getElementById(cover.getAttribute("aria-describedby") as string);
    expect(about?.textContent).toMatch(/^The first slide/);
    // The keyboard starts on the first, and the arrows move along them.
    expect(document.activeElement).toBe(picks[0]);
    (picks[0] as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(document.activeElement).toBe(cover);
    cover.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.pick).toBe("layout:text-media");
  });

  it("adds the scene for a choice and shuts, or says why it was refused and stays", () => {
    const doc = harbor();
    const root = document.createElement("div");
    document.body.append(root);
    const added: string[] = [];
    let answer: string | undefined = "The deck has too many scenes.";
    pickTemplate(createSession(doc), root, {
      add(scene) {
        added.push(scene.template ?? scene.layout ?? "");
        return answer;
      },
    });
    const pick = (key: string) =>
      root.querySelector<HTMLButtonElement>(`[data-pick='${key}']`) as HTMLButtonElement;
    pick("template:chart-and-note").click();
    expect(root.querySelector("dialog .ed-problem")?.textContent).toBe("The deck has too many scenes.");
    expect(root.querySelector("dialog")).not.toBeNull();
    answer = undefined;
    pick("layout:title").click();
    expect(added).toEqual(["chart-and-note", "title"]);
    expect(root.querySelector("dialog")).toBeNull();
  });

  it("shuts on Escape and on Cancel, and gives the keyboard back", () => {
    const root = document.createElement("div");
    const opener = document.createElement("button");
    document.body.append(root, opener);
    opener.focus();
    pickTemplate(createSession(harbor()), root, { add: () => undefined });
    const dialog = root.querySelector("dialog") as HTMLDialogElement;
    const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    dialog.dispatchEvent(key);
    expect(root.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    pickTemplate(createSession(harbor()), root, { add: () => undefined });
    (root.querySelector("[data-dialog-action='cancel']") as HTMLButtonElement).click();
    expect(root.querySelector("dialog")).toBeNull();
  });

  it("gives the keyboard back to where it was when a second one replaced the first", () => {
    const root = document.createElement("div");
    const opener = document.createElement("button");
    document.body.append(root, opener);
    opener.focus();
    pickTemplate(createSession(harbor()), root, { add: () => undefined });
    pickTemplate(createSession(harbor()), root, { add: () => undefined });
    expect(root.querySelectorAll("dialog")).toHaveLength(1);
    (root.querySelector("dialog") as HTMLDialogElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(opener);
  });

  it("keeps a key pressed in it from the editor behind it", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const heard = vi.fn();
    document.body.addEventListener("keydown", heard);
    pickTemplate(createSession(harbor()), root, { add: () => undefined });
    (root.querySelector(".ed-pick") as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "t", bubbles: true }),
    );
    expect(heard).not.toHaveBeenCalled();
    document.body.removeEventListener("keydown", heard);
  });
});

describe("Change template", () => {
  const measure = (id: string) => (id === "growth-chart" ? { x: 6, y: 24, w: 58, h: 68 } : undefined);

  it("says where each block goes and names each block no slot takes, with what happens to it", () => {
    const doc = harbor();
    const plan = planOf(doc, "growth", { template: "cover" }, measure);
    expect(plan.problem).toBeUndefined();
    expect(plan.placed).toEqual([
      expect.stringMatching(/→ title slot$/),
      expect.stringMatching(/→ pinned over the slide$/),
      expect.stringMatching(/→ byline slot$/),
    ]);
    expect(plan.unplaced).toHaveLength(1);
    expect(plan.unplaced[0]).toMatch(
      /^Chart.*No slot here takes a chart, so it stays on the slide, pinned where it is now/,
    );
    const chart = blockOf(plan.after?.scene as Scene, "growth-chart");
    expect(chart.slot).toBeUndefined();
    expect(chart.frame).toEqual({ x: 6, y: 24, w: 58, h: 68 });
  });

  it("applies as one step of Undo, with the operations depthcue apply takes", () => {
    const doc = harbor();
    const session = createSession(doc);
    const plan = planOf(doc, "growth", { template: "cover" }, measure);
    expect(plan.ops.every((op: Op) => ["scene.set", "block.set", "block.frame"].includes(op.op))).toBe(true);
    expect(session.apply(plan.ops).ok).toBe(true);
    expect(sceneOf(session.doc, "growth").template).toBe("cover");
    session.undo();
    expect(sceneOf(session.doc, "growth")).toEqual(sceneOf(doc, "growth"));
  });

  it("moves a claim as core does: never into a block, and removed, by name with its links, where no slot takes it", () => {
    const doc = plain();
    const data = sceneOf(doc, "data");
    expect(data.summary?.evidenceIds).toEqual(["data-chart", "data-table"]);
    // Depthcue's Two columns has no slot for a claim: core's own operations, and the claim taken off as core suggests.
    const plan = planOf(doc, "data", { template: "two-column" }, () => undefined);
    expect(plan.problem).toBeUndefined();
    expect(plan.ops).toEqual([
      ...retemplate(doc, "data", { template: "two-column" }).ops,
      ...removeClaim(data),
    ]);
    expect(removeClaim(data)).toEqual([
      {
        op: "scene.set",
        id: "data",
        set: { summary: null, steps: [{ id: "data-step-evidence", reveal: ["data-chart", "data-table"] }] },
      },
    ]);
    expect(plan.unplaced).toEqual([
      expect.stringContaining(
        'The claim "Channel B now leads, 60 to 40." has no slot in this template, so it is removed, and its links to Chart: Share of orders by quarter, Table: Orders, latest quarter are removed with it.',
      ),
    ]);
    expect(plan.unplaced[0]).toMatch(
      /To keep it, choose .*Statement.*Big number.* or the layout Claim and evidence\.$/,
    );
    const after = plan.after?.scene as Scene;
    expect(after.summary).toBeUndefined();
    expect(after.blocks.map((block) => block.id)).toEqual(data.blocks.map((block) => block.id));
  });

  it("keeps the claim, with its links to its evidence, on a template with a claim slot", () => {
    const doc = plain();
    const plan = planOf(doc, "data", { template: "statement" }, () => ({ x: 5, y: 5, w: 40, h: 20 }));
    expect(plan.problem).toBeUndefined();
    expect(plan.ops.some((op) => op.op === "scene.set" && "summary" in op.set)).toBe(false);
    expect(plan.after?.scene.summary).toEqual(sceneOf(doc, "data").summary);
  });

  it("names the required slots the change leaves empty", () => {
    const doc = plain();
    // The data scene has no heading for Two columns' title.
    expect(planOf(doc, "data", { template: "two-column" }, () => undefined).empty).toEqual([
      "title (required)",
    ]);
    expect(planOf(harbor(), "growth", { template: "cover" }, measure).empty).toEqual([]);
  });

  it("names the block a refusal is about", () => {
    const doc = plain();
    const overview = sceneOf(doc, "overview");
    const plan = planOf(doc, "overview", { template: "section" }, () => undefined);
    expect(plan.problem).toMatch(/: The text is drawn in "action"/);
    expect(
      overview.blocks.some((block) =>
        plan.problem?.startsWith(`${describeBlock(block, 40, overview)}: The text is drawn in`),
      ),
    ).toBe(true);
  });

  it("says a claim stays in the scene, unseen, on a layout that does not show one", () => {
    const doc = plain();
    const withClaim = Object.values(doc.scenes).find((scene) => scene.summary !== undefined) as Scene;
    const plan = planOf(doc, withClaim.id, { layout: "title" }, () => undefined);
    expect(plan.unplaced).toEqual([
      expect.stringMatching(/stays in the scene, but .* does not show a claim/),
    ]);
    expect(plan.after?.scene.summary).toEqual(withClaim.summary);
  });

  it("shows the plan for the choice in a dialog, and Apply makes it", () => {
    const doc = harbor();
    const root = document.createElement("div");
    document.body.append(root);
    const act = vi.fn((_ops: readonly Op[]) => undefined);
    changeTemplate(createSession(doc), root, "growth", { act, measure }, { template: "cover" });
    const dialog = root.querySelector("dialog[data-dialog='retemplate']") as HTMLDialogElement;
    const checked = dialog.querySelector<HTMLInputElement>("input[data-choice]:checked");
    expect(checked?.value).toBe("template:cover");
    const preview = dialog.querySelector(".ed-retemplate-preview") as HTMLElement;
    expect(preview.getAttribute("aria-live")).toBe("polite");
    expect(preview.querySelector(".ed-mini .dc-scene")).not.toBeNull();
    expect(preview.querySelectorAll(".ed-retemplate-placed li")).toHaveLength(3);
    expect(preview.querySelector(".ed-retemplate-unplaced li")?.textContent).toMatch(/^Chart/);
    // The template the scene has now is marked, and choosing it offers nothing to apply.
    const now = dialog.querySelector<HTMLInputElement>(
      "input[value='template:chart-and-note']",
    ) as HTMLInputElement;
    expect(now.closest("label")?.hasAttribute("data-current")).toBe(true);
    now.checked = true;
    now.dispatchEvent(new Event("change", { bubbles: true }));
    const apply = dialog.querySelector<HTMLButtonElement>(
      "[data-dialog-action='apply']",
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    const cover = dialog.querySelector<HTMLInputElement>("input[value='template:cover']") as HTMLInputElement;
    cover.checked = true;
    cover.dispatchEvent(new Event("change", { bubbles: true }));
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(act).toHaveBeenCalledTimes(1);
    expect(act.mock.calls[0]?.[0]).toEqual(planOf(doc, "growth", { template: "cover" }, measure).ops);
    expect(root.querySelector("dialog")).toBeNull();
  });

  it("stays open with the reason when the change is refused", () => {
    const root = document.createElement("div");
    document.body.append(root);
    changeTemplate(
      createSession(harbor()),
      root,
      "growth",
      { act: () => "Refused.", measure },
      { template: "cover" },
    );
    (root.querySelector("[data-dialog-action='apply']") as HTMLButtonElement).click();
    expect(root.querySelector("dialog .ed-problem")?.textContent).toBe("Refused.");
  });
});

describe("the styles of a block", () => {
  it("styles each block a style is for, and names the others", () => {
    const doc = harbor();
    const { ops, refused } = styleOps(doc, "welcome", ["welcome-kicker", "welcome-title"], "kicker");
    expect(ops).toEqual([
      { op: "block.set", scene: "welcome", id: "welcome-kicker", set: { style: "kicker" } },
    ]);
    expect(refused).toEqual([expect.stringMatching(/^Heading/)]);
  });

  it("takes a style off with no style, and leaves a block that has none alone", () => {
    const doc = harbor();
    const styled = applyOps(
      doc,
      [{ op: "block.set", scene: "growth", id: "growth-note", set: { style: "callout" } }],
      revisionOf(doc),
    );
    if (!styled.ok) throw new Error(`the style should apply: ${JSON.stringify(styled)}`);
    expect(styleOps(styled.doc, "growth", ["growth-note", "growth-title"], "").ops).toEqual([
      { op: "block.set", scene: "growth", id: "growth-note", set: { style: null } },
    ]);
  });

  it("leaves a style the deck refuses to the session, which says why", () => {
    // The kicker is drawn in the brand's color, and the cover is that color: the text would not be seen.
    const session = createSession(harbor());
    const { ops } = styleOps(session.doc, "welcome", ["welcome-kicker"], "kicker");
    const result = session.apply(ops);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.code).toBe("block-low-contrast");
  });

  it("draws a style as its sample block alone, by the player, with none of the brand's chrome", () => {
    const preview = stylePreview(harbor(), "quiet-panel");
    expect(preview.classList.contains("ed-style-thumb")).toBe(true);
    const sample = preview.querySelector<HTMLElement>(".dc-scene [data-id='sample']");
    expect(sample?.textContent).toBe("Aa");
    // The footer, the logo and the accent would be all a picture this small showed of the slide round the block.
    expect(preview.querySelector(".dc-chrome")).toBeNull();
    expect(preview.textContent).not.toContain("Harbor");
  });

  it("checks a new choice in place, so the keyboard stays on it, and draws the pictures again only for a new look", () => {
    const session = createSession(harbor());
    const section = styleSection(
      session,
      "growth",
      () => ["growth-note"],
      (ops) => session.apply(ops).ok,
    );
    document.body.append(section.body);
    const radio = (id: string) =>
      section.body.querySelector<HTMLInputElement>(`input[data-style='${id}']`) as HTMLInputElement;
    const pictures = () => [...section.body.querySelectorAll(".ed-style-thumb")];
    const same = (before: Element[]) => pictures().every((node, i) => node === before[i]);
    const before = pictures();
    const panel = radio("quiet-panel");
    panel.focus();
    panel.checked = true;
    panel.dispatchEvent(new Event("change", { bubbles: true }));
    section.fill();
    expect(radio("quiet-panel")).toBe(panel);
    expect(document.activeElement).toBe(panel);
    expect([panel.checked, radio("none").checked]).toEqual([true, false]);
    expect(same(before)).toBe(true);
    // A keystroke in the block changes nothing the pictures are drawn from.
    session.apply([{ op: "block.set", scene: "growth", id: "growth-note", set: { text: "Typed." } }]);
    section.fill(true);
    section.fill();
    expect(same(before)).toBe(true);
    // Another look draws them again, but not in the middle of typing.
    session.apply([{ op: "deck.set", set: { theme: "ink" } }]);
    section.fill(true);
    expect(same(before)).toBe(true);
    section.fill();
    expect(same(before)).toBe(false);
    expect(radio("quiet-panel").checked).toBe(true);
  });

  it("lists No style and the styles for the block's kind, the one it has checked, and writes the choice", () => {
    const doc = harbor();
    const session = createSession(doc);
    const run = vi.fn((ops: readonly Op[]) => session.apply(ops).ok);
    const section = styleSection(session, "growth", () => ["growth-note"], run);
    document.body.append(section.body);
    const radios = () => [...section.body.querySelectorAll<HTMLInputElement>("input[data-style]")];
    const ids = radios().map((radio) => radio.dataset.style);
    expect(ids[0]).toBe("none");
    // Only styles for a text: the brand's quiet panel, and Depthcue's own that take one. The kicker is for captions.
    expect(ids).toContain("quiet-panel");
    expect(ids).toContain("callout");
    expect(ids).not.toContain("kicker");
    expect(radios().find((radio) => radio.checked)?.dataset.style).toBe("none");
    // Each is the block drawn by the player in it, No style as the block with none.
    expect(section.body.querySelectorAll(".ed-style-choice .ed-mini .dc-player")).toHaveLength(ids.length);
    const drawnIn = (id: string) =>
      section.body.querySelector<HTMLElement>(`.ed-style-choice:has([data-style='${id}']) .dc-block`);
    expect(drawnIn("quiet-panel")?.dataset.fill).toBe("surface");
    expect(drawnIn("none")?.dataset.fill).toBeUndefined();
    const panel = radios().find((radio) => radio.dataset.style === "quiet-panel") as HTMLInputElement;
    panel.checked = true;
    panel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(run).toHaveBeenCalledWith([
      { op: "block.set", scene: "growth", id: "growth-note", set: { style: "quiet-panel" } },
    ]);
    section.fill();
    expect(radios().find((radio) => radio.checked)?.dataset.style).toBe("quiet-panel");
  });

  it("styles several blocks at once, and says which it left as they were", () => {
    const session = createSession(harbor());
    const section = styleSection(
      session,
      "growth",
      () => ["growth-note", "growth-title"],
      (ops) => session.apply(ops).ok,
    );
    const panel = section.body.querySelector<HTMLInputElement>(
      "input[data-style='quiet-panel']",
    ) as HTMLInputElement;
    panel.checked = true;
    panel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(blockOf(sceneOf(session.doc, "growth"), "growth-note").style).toBe("quiet-panel");
    expect(blockOf(sceneOf(session.doc, "growth"), "growth-title").style).toBeUndefined();
    expect(section.body.querySelector("[role='status']")?.textContent).toMatch(
      /^Not styled, as Quiet panel is not for them: Heading/,
    );
  });

  it("says when no style is made for the block's kind", () => {
    const session = createSession(withBrand(harbor(), { hideBuiltIn: ["styles"] }));
    const section = styleSection(
      session,
      "growth",
      () => ["growth-chart"],
      () => true,
    );
    expect(section.body.querySelector("input")).toBeNull();
    expect(section.body.textContent).toContain("No style is made for a chart.");
  });
});
