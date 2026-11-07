import {
  type Block,
  type BlockChanges,
  FONT_PAIRS,
  type FontPair,
  LINK_LIMITS,
  type Op,
  PALETTE_COLORS,
  type PaletteColor,
  parseTarget,
  type Scene,
  type SceneChanges,
  type Session,
  STEPS_MAX,
  splitMarks,
  styleOf,
  TARGET_RULE,
  THEMES,
  VOICE_MARK,
  voiceKey,
} from "@depthcue/core";
import { firstPartyManifests, h } from "@depthcue/player";
import { checkBrandLock } from "../../core/src/brand.ts";
import type { VoiceAnswer } from "./api.ts";
import { addedRow, CHART_ROWS_MAX, sortedRows } from "./chart.ts";
import { removeSource, swapped } from "./cleanup.ts";
import {
  actionButton,
  checkField,
  choiceField,
  colorField,
  type Edits,
  fileButton,
  numberField,
  problemOf,
  selectField,
  textField,
} from "./fields.ts";
import {
  describeBlock,
  IMAGE_ACCEPT,
  IMAGE_FILE,
  idsInScene,
  needsAlt,
  placeholderAlt,
  uniqueId,
  VIDEO_FILE,
} from "./templates.ts";

const optional = (value: string) => (value === "" ? null : value);

/** What a panel needs from the toolbar that shows it. */
export interface PanelHost {
  readonly edits: Edits;
  scene(id: string): Scene | undefined;
  deck(): Session["doc"]["deck"];
  /** The deck's brand, when it has one. */
  brand?(): Session["doc"]["brand"];
  /** A click or a choice: applied, and a refusal said where the person is looking. True when it was applied. */
  run(ops: readonly Op[]): boolean;
  /** The files in the deck. */
  assets(): readonly string[];
  /** Stores a file in the deck and answers with its path. Rejects with a message the person can read. */
  upload(file: File): Promise<string>;
  /** Says what went wrong, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Closes the popover this panel is in. */
  close(): void;
  /** Makes the voice-over audio of a scene. Left out where the editor cannot. */
  voice?(scene: string, voice: string | undefined): Promise<VoiceAnswer>;
  /** Opens where the scene's sources are added and edited. */
  openSources(): void;
  /** Opens the image library to choose a file for an image; `choose` gets its path. Left out where there is none. */
  library?(choose: (asset: string) => void): void;
  /** Runs `then` with the picture tools, once they are in. Left out where a panel has no use for them. */
  picture?: ((then: (module: typeof import("./picture.ts")) => void) => void) | undefined;
}

/** What the toolbar and the scene bar each bring to their panels; the rest is read from the session. */
export function panelHost(
  session: Session,
  parts: Pick<
    PanelHost,
    "edits" | "upload" | "problem" | "close" | "openSources" | "library" | "picture" | "voice"
  >,
): PanelHost {
  return {
    ...parts,
    scene: (id) => session.doc.scenes[id],
    deck: () => session.doc.deck,
    brand: () => session.doc.brand,
    run(ops) {
      const result = parts.edits.act(ops);
      parts.problem(result.ok ? undefined : problemOf(result));
      return result.ok;
    },
    assets: () => [...session.doc.assets],
  };
}

/** One popover of the toolbar: a chip that opens it, and what is in it. */
export interface Panel {
  /** Names the chip's `data-tb`, so the chip can be found by tests and by the keyboard. */
  name: string;
  /** What the chip says. */
  label: string;
  /** What a screen reader says for the chip and the popover. It starts with the label. */
  title: string;
  body: HTMLElement;
  /** Brings the popover up to date. `typing` is true while a keystroke inside it is being applied: leave it be. */
  fill(scene: Scene, typing: boolean): void;
  /** A count to show on the chip, and the title to say for it. */
  state?(scene: Scene): { badge: string; title: string };
  /** False while the chip has nothing to open, such as the position of a block that is not pinned. */
  visible?(scene: Scene): boolean;
}

type Chart = Extract<Block, { type: "bar-chart" }>;

const blockOf = (host: PanelHost, sceneId: string, id: string) =>
  host.scene(sceneId)?.blocks.find((block) => block.id === id);

const sceneSet = (id: string, set: SceneChanges): Op => ({ op: "scene.set", id, set });

const blockSet = (sceneId: string, id: string, set: BlockChanges): Op => ({
  op: "block.set",
  scene: sceneId,
  id,
  set,
});

export const assetOptions = (host: PanelHost, pattern: RegExp) =>
  [...host.assets()]
    .filter((path) => pattern.test(path))
    .sort()
    .map((path) => ({ value: path, label: path.replace(/^assets\//, "") }));

/**
 * The popover body for a block's own properties. It is drawn from the document again after every change that did
 * not come from typing in it, and the control that had the keyboard is found again by its `data-field`.
 */
export function form(exists: () => boolean, draw: () => Node[]) {
  const body = h("div", { class: "ed-tb-form" });
  let want: string | undefined;
  const rebuild = () => {
    if (!exists()) return;
    const active = document.activeElement;
    const key =
      want ?? (active instanceof HTMLElement && body.contains(active) ? active.dataset.field : undefined);
    want = undefined;
    body.replaceChildren(...draw());
    if (key === undefined) return;
    for (const node of body.querySelectorAll<HTMLElement>("[data-field]")) {
      if (node.dataset.field === key) node.focus();
    }
  };
  rebuild();
  return {
    body,
    /** The control to put the keyboard on after the next redraw, such as the row that was just added. */
    focusNext(key: string | undefined) {
      want = key;
    },
    fill(_scene: Scene, typing: boolean) {
      if (!typing) rebuild();
    },
  };
}

/** The sources a block cites, as a list of checkboxes. Every kind of block can cite. */
export function citePanel(host: PanelHost, sceneId: string, id: string): Panel {
  const list = h("div", { class: "ed-tb-sources" });
  let listKey = "";

  const cited = (scene: Scene) => {
    const block = scene.blocks.find((candidate) => candidate.id === id);
    return new Set(block?.sourceIds ?? []);
  };

  function sync(scene: Scene) {
    const sources = scene.sources ?? [];
    const key = JSON.stringify(sources.map((source) => [source.id, source.title]));
    // Rebuilt only when the scene's sources change, so a click keeps its focus.
    if (key !== listKey) {
      listKey = key;
      if (sources.length === 0) {
        const open = h("button", { type: "button", "data-tb": "open-sources" }, "Add one in Scene");
        open.addEventListener("click", () => {
          host.close();
          host.openSources();
        });
        list.replaceChildren(h("p", {}, "This scene has no sources yet."), open);
      } else {
        list.replaceChildren(
          ...sources.map((source) => {
            const box = h("input", { type: "checkbox", value: source.id, "data-tb": "source" });
            box.addEventListener("change", () => {
              const live = host.scene(sceneId);
              const ids = (live?.sources ?? [])
                .map((candidate) => candidate.id)
                .filter((candidate) =>
                  candidate === source.id
                    ? box.checked
                    : (list.querySelector<HTMLInputElement>(`input[value="${candidate}"]`)?.checked ?? false),
                );
              const done = host.run([blockSet(sceneId, id, { sourceIds: ids.length > 0 ? ids : null })]);
              if (!done) box.checked = !box.checked;
            });
            return h("label", { class: "ed-tb-source" }, box, h("span", {}, source.title));
          }),
        );
      }
    }
    const chosen = cited(scene);
    for (const box of list.querySelectorAll<HTMLInputElement>("input[data-tb='source']")) {
      box.checked = chosen.has(box.value);
    }
  }

  return {
    name: "cite",
    label: "Cite",
    title: "Cite a source",
    body: list,
    fill: (scene) => sync(scene),
    state(scene) {
      const n = cited(scene).size;
      return { badge: n > 0 ? String(n) : "", title: n > 0 ? `Cite a source, ${n} cited` : "Cite a source" };
    },
  };
}

/** The deck's saved links as choices, each with where it goes. */
const linkOptions = (host: PanelHost) =>
  (host.deck().links ?? []).map((entry) => ({ value: entry.id, label: `${entry.title} (${entry.target})` }));

/**
 * The link a block follows when it is clicked or read: one of the deck's saved links. The saved links themselves are
 * made and changed in the Deck panel, so changing one there changes every block that follows it.
 */
export function linkPanel(host: PanelHost, sceneId: string, id: string): Panel {
  const followed = (scene: Scene) => scene.blocks.find((candidate) => candidate.id === id)?.link;
  const panel = form(
    () => blockOf(host, sceneId, id) !== undefined,
    () => [
      ...((host.deck().links ?? []).length === 0
        ? [h("p", { class: "ed-hint-text" }, "This deck has no saved links yet. Add them in the Deck panel.")]
        : []),
      selectField(host.edits, {
        key: "link:block",
        label: "Link to",
        empty: "No link",
        options: linkOptions(host),
        read: () => blockOf(host, sceneId, id)?.link ?? "",
        commit: (value) => blockSet(sceneId, id, { link: optional(value) }),
      }),
    ],
  );
  return {
    name: "link",
    label: "Link",
    title: "Link this block to a saved link",
    body: panel.body,
    fill: panel.fill,
    state(scene) {
      const on = followed(scene);
      return {
        badge: on ? "1" : "",
        title: on ? `Link this block, linked to ${on}` : "Link this block to a saved link",
      };
    },
  };
}

/** A bar chart's title, unit and rows: add, remove, reorder and sort them, and edit each label and value. */
export function chartPanel(host: PanelHost, sceneId: string, id: string): Panel {
  type Row = Chart["data"][number];
  const chart = () => {
    const block = blockOf(host, sceneId, id);
    return block?.type === "bar-chart" ? block : undefined;
  };
  const rows = (): Row[] => chart()?.data ?? [];
  const setRows = (next: Row[]) => blockSet(sceneId, id, { data: next });
  const key = (name: string) => `chart:${name}`;

  const panel = form(
    () => chart() !== undefined,
    () => {
      const current = rows();
      const table = h("div", { class: "ed-rows", role: "group", "aria-label": "Chart data" });
      current.forEach((_row, index) => {
        const earlier = swapped(current, index, -1);
        const later = swapped(current, index, 1);
        const tool = (mark: string, what: string, onClick: () => void, off: boolean, name: string) =>
          actionButton(mark, onClick, {
            class: "ed-tb-mini",
            disabled: off,
            "aria-label": `${what} row ${index + 1}`,
            "data-field": key(`row${index}:${name}`),
          });
        table.append(
          h(
            "div",
            { class: "ed-chart-row" },
            textField(host.edits, {
              key: key(`row${index}:label`),
              label: `Row ${index + 1} label`,
              bare: true,
              read: () => rows()[index]?.label ?? "",
              commit: (value) =>
                setRows(rows().map((row, at) => (at === index ? { ...row, label: value } : row))),
            }),
            numberField(host.edits, {
              key: key(`row${index}:value`),
              label: `Row ${index + 1} value`,
              bare: true,
              read: () => rows()[index]?.value ?? 0,
              commit: (value) => setRows(rows().map((row, at) => (at === index ? { ...row, value } : row))),
            }),
            h(
              "div",
              { class: "ed-tb-rowtools" },
              tool(
                "↑",
                "Move up",
                () => earlier && host.run([setRows(earlier)]),
                earlier === undefined,
                "up",
              ),
              tool("↓", "Move down", () => later && host.run([setRows(later)]), later === undefined, "down"),
              tool(
                "×",
                "Remove",
                () => host.run([setRows(rows().filter((_row, at) => at !== index))]),
                current.length < 2,
                "remove",
              ),
            ),
          ),
        );
      });

      const addRow = () => {
        const at = rows().length;
        panel.focusNext(key(`row${at}:label`));
        host.run([setRows(addedRow(rows()))]);
      };
      const sortRows = () => host.run([setRows(sortedRows(rows()))]);

      return [
        textField(host.edits, {
          key: key("title"),
          label: "Title",
          read: () => chart()?.title ?? "",
          commit: (value) => blockSet(sceneId, id, { title: optional(value) }),
        }),
        textField(host.edits, {
          key: key("unit"),
          label: "Unit",
          hint: "Short, such as % or ms.",
          read: () => chart()?.unit ?? "",
          commit: (value) => blockSet(sceneId, id, { unit: optional(value) }),
        }),
        table,
        h(
          "div",
          { class: "ed-row" },
          actionButton("Add a row", addRow, {
            disabled: current.length >= CHART_ROWS_MAX,
            title:
              current.length >= CHART_ROWS_MAX ? `A chart holds at most ${CHART_ROWS_MAX} rows.` : undefined,
            "data-field": key("addrow"),
          }),
          actionButton("Sort by value", sortRows, {
            disabled: current.length < 2,
            "data-field": key("sort"),
          }),
        ),
      ];
    },
  );

  return { name: "data", label: "Data", title: "Chart data", body: panel.body, fill: panel.fill };
}

/**
 * Points an image at another file. The alt text described the old picture, so it starts over as the new file's
 * name, which the slide flags until somebody describes the picture. Both change as one undo step.
 */
const imageFile = (sceneId: string, id: string, asset: string): Op =>
  blockSet(sceneId, id, { asset, alt: placeholderAlt(asset) });

/** Stores a file in the deck and points the image at it. True when the image was replaced. */
export async function replaceImage(
  host: PanelHost,
  sceneId: string,
  id: string,
  file: File,
): Promise<boolean> {
  host.problem(undefined);
  try {
    return host.run([imageFile(sceneId, id, await host.upload(file))]);
  } catch (error) {
    host.problem(error instanceof Error ? error.message : "The upload failed.");
    return false;
  }
}

/** The chip's mark for a block whose alt text still is the name of its file. */
function altState(scene: Scene, id: string, title: string) {
  const block = scene.blocks.find((candidate) => candidate.id === id);
  const missing = block !== undefined && needsAlt(block);
  return { badge: missing ? "!" : "", title: missing ? `${title}. Alt text is missing` : title };
}

export interface ImagePanel extends Panel {
  /** Puts the keyboard on the alt text with its words selected, so the first thing typed replaces them. */
  promptAlt(): void;
}

export const hasAltPrompt = (panel: Panel): panel is ImagePanel => "promptAlt" in panel;

/** An image's file, with a way to upload another, its alt text and its caption. */
export function imagePanel(host: PanelHost, sceneId: string, id: string): ImagePanel {
  const image = () => {
    const block = blockOf(host, sceneId, id);
    return block?.type === "image" ? block : undefined;
  };
  const key = (name: string) => `image:${name}`;
  const title = "Image file, alt text and caption";

  const panel = form(
    () => image() !== undefined,
    () => {
      // A decorative picture needs no alt text, so that field waits; what was written in it stays.
      const alt = textField(host.edits, {
        key: key("alt"),
        label: "Alt text",
        hint: "What the image shows, for people who cannot see it.",
        read: () => image()?.alt ?? "",
        commit: (value) => blockSet(sceneId, id, { alt: value }),
      });
      if (image()?.decorative) alt.querySelector("input")?.setAttribute("disabled", "");
      return [
        selectField(host.edits, {
          key: key("asset"),
          label: "Image file",
          options: assetOptions(host, IMAGE_FILE),
          read: () => image()?.asset ?? "",
          commit: (value) => imageFile(sceneId, id, value),
        }),
        ...(host.library
          ? [
              actionButton(
                "Choose from library",
                () => host.library?.((asset) => void host.run([imageFile(sceneId, id, asset)])),
                { "data-field": key("library"), title: "Pictures already in this deck" },
              ),
            ]
          : []),
        fileButton(
          "Upload a new image",
          IMAGE_ACCEPT,
          key("upload"),
          (file) => void replaceImage(host, sceneId, id, file),
        ),
        alt,
        checkField(host.edits, {
          key: "image",
          label: "Decorative",
          items: [{ id: "decorative", label: "No alt text needed" }],
          read: () => (image()?.decorative ? ["decorative"] : []),
          // Without the mark the schema wants alt text, so an empty one starts as the file's name, to be written over.
          commit: (ids) =>
            blockSet(
              sceneId,
              id,
              ids.length > 0
                ? { decorative: true }
                : { decorative: null, alt: image()?.alt || placeholderAlt(image()?.asset ?? "") },
            ),
        }),
        textField(host.edits, {
          key: key("caption"),
          label: "Caption",
          read: () => image()?.caption ?? "",
          commit: (value) => blockSet(sceneId, id, { caption: optional(value) }),
        }),
      ];
    },
  );

  return {
    name: "edit",
    label: "Edit",
    title,
    body: panel.body,
    fill: panel.fill,
    state: (scene) => altState(scene, id, title),
    promptAlt() {
      const field = panel.body.querySelector<HTMLElement>(`[data-field="${key("alt")}"]`);
      field?.focus({ preventScroll: true });
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.select();
    },
  };
}

/** A clip's video file, its poster image and its alt text. */
export function clipPanel(host: PanelHost, sceneId: string, id: string): Panel {
  const clip = () => {
    const block = blockOf(host, sceneId, id);
    return block?.type === "clip" ? block : undefined;
  };
  const key = (name: string) => `clip:${name}`;

  const panel = form(
    () => clip() !== undefined,
    () => [
      selectField(host.edits, {
        key: key("source"),
        label: "Video file",
        options: assetOptions(host, VIDEO_FILE),
        read: () => clip()?.source ?? "",
        commit: (value) => blockSet(sceneId, id, { source: value, alt: placeholderAlt(value) }),
      }),
      selectField(host.edits, {
        key: key("poster"),
        label: "Poster image",
        empty: "No poster",
        options: assetOptions(host, IMAGE_FILE),
        read: () => clip()?.poster ?? "",
        commit: (value) => blockSet(sceneId, id, { poster: optional(value) }),
      }),
      textField(host.edits, {
        key: key("alt"),
        label: "Alt text",
        hint: "What the clip shows, for people who cannot see it.",
        read: () => clip()?.alt ?? "",
        commit: (value) => blockSet(sceneId, id, { alt: value }),
      }),
    ],
  );

  const title = "Clip file, poster and alt text";
  return {
    name: "edit",
    label: "Edit",
    title,
    body: panel.body,
    fill: panel.fill,
    state: (scene) => altState(scene, id, title),
  };
}

/** The blocks that are the evidence for the scene's claim. */
export function evidencePanel(host: PanelHost, sceneId: string): Panel {
  const live = () => host.scene(sceneId);
  const panel = form(
    () => live()?.summary !== undefined,
    () => {
      const scene = live();
      const summary = scene?.summary;
      if (!scene || !summary) return [];
      return [
        checkField(host.edits, {
          key: "panel:evidence",
          label: "Evidence",
          items: scene.blocks.map((block) => ({ id: block.id, label: describeBlock(block, 36, scene) })),
          none: "Add a block to use as evidence.",
          read: () => live()?.summary?.evidenceIds ?? [],
          commit: (ids) =>
            sceneSet(sceneId, { summary: { ...(live()?.summary ?? summary), evidenceIds: ids } }),
        }),
      ];
    },
  );
  return {
    name: "evidence",
    label: "Evidence",
    title: "Evidence for the claim",
    body: panel.body,
    fill: panel.fill,
    state(scene) {
      const n = scene.summary?.evidenceIds.length ?? 0;
      return {
        badge: n > 0 ? String(n) : "",
        title: n > 0 ? `Evidence for the claim, ${n} chosen` : "Evidence for the claim",
      };
    },
  };
}

type Step = NonNullable<Scene["steps"]>[number];
type Source = NonNullable<Scene["sources"]>[number];

/** The most sources a scene holds. The schema says so too; the core does not export it. */
const SOURCES_MAX = 32;

export interface ScenePanel extends Panel {
  /** Opens one of the sections and puts the keyboard in it. */
  reveal(section: "steps" | "sources"): void;
}

/**
 * The scene's own title, the steps that reveal its parts one press at a time, and the sources its blocks can cite.
 * The sections stay in place while their contents are drawn again, so one that was opened stays open.
 */
export function scenePanel(host: PanelHost, current: () => string): ScenePanel {
  const scene = () => host.scene(current());
  const set = (changes: SceneChanges): Op => sceneSet(current(), changes);
  const exists = () => scene() !== undefined;

  const title = form(exists, () => [
    textField(host.edits, {
      key: "panel:title",
      label: "Title",
      read: () => scene()?.title ?? "",
      commit: (value) => set({ title: value }),
    }),
    selectField(host.edits, {
      key: "panel:chrome",
      label: "Header and footer",
      empty: "As the template says",
      options: [
        { value: "full", label: "All of it" },
        { value: "minimal", label: "Logo only" },
        { value: "none", label: "None" },
      ],
      read: () => scene()?.chrome ?? "",
      commit: (value) => set({ chrome: value === "" ? null : (value as "full" | "minimal" | "none") }),
    }),
  ]);

  const steps = form(exists, () => {
    const s = scene();
    if (!s) return [];
    const list = () => scene()?.steps ?? [];
    const revealable = [
      ...(s.summary ? [{ id: s.summary.id, label: `Claim: ${s.summary.text.slice(0, 30)}` }] : []),
      ...s.blocks.map((block) => ({ id: block.id, label: describeBlock(block, 36, s) })),
    ];
    const setSteps = (next: Step[]): Op => set({ steps: next.length > 0 ? next : null });
    const now = list();
    const rows = now.map((step, index) => {
      const earlier = swapped(now, index, -1);
      const later = swapped(now, index, 1);
      const tool = (mark: string, what: string, onClick: () => void, off: boolean, name: string) =>
        actionButton(mark, onClick, {
          class: "ed-tb-mini",
          disabled: off,
          "aria-label": `${what} step ${index + 1}`,
          "data-field": `panel:step-${name}:${step.id}`,
        });
      return h(
        "div",
        { class: "ed-step" },
        checkField(host.edits, {
          key: `panel:step:${step.id}`,
          label: `Step ${index + 1} reveals`,
          items: revealable,
          read: () => list().find((other) => other.id === step.id)?.reveal ?? [],
          commit: (ids) =>
            setSteps(list().map((other) => (other.id === step.id ? { ...other, reveal: ids } : other))),
        }),
        h(
          "div",
          { class: "ed-row" },
          tool("↑", "Move up", () => earlier && host.run([setSteps(earlier)]), earlier === undefined, "up"),
          tool("↓", "Move down", () => later && host.run([setSteps(later)]), later === undefined, "down"),
          tool(
            "×",
            "Remove",
            () => host.run([setSteps(list().filter((other) => other.id !== step.id))]),
            false,
            "remove",
          ),
        ),
      );
    });
    const addStep = () => {
      const used = new Set(list().flatMap((step) => step.reveal));
      const target = revealable.find((candidate) => !used.has(candidate.id)) ?? revealable[0];
      const live = scene();
      if (!target || !live) return;
      const step: Step = { id: uniqueId(`${live.id}-step`, idsInScene(live)), reveal: [target.id] };
      steps.focusNext(`panel:step:${step.id}:${target.id}`);
      host.run([setSteps([...list(), step])]);
    };
    return [
      h(
        "p",
        { class: "ed-hint-text" },
        "Each press in the presentation reveals one step. What no step names is there from the start.",
      ),
      ...rows,
      actionButton("Add a step", addStep, {
        disabled: revealable.length === 0 || now.length >= STEPS_MAX,
        "data-field": "panel:step:add",
      }),
    ];
  });

  const sources = form(exists, () => {
    const s = scene();
    if (!s) return [];
    const list = () => scene()?.sources ?? [];
    const update = (id: string, change: (source: Source) => Source): Op =>
      set({ sources: list().map((source) => (source.id === id ? change(source) : source)) });
    const rows = list().map((source) => {
      const live = () => list().find((candidate) => candidate.id === source.id) ?? source;
      return h(
        "div",
        { class: "ed-source" },
        textField(host.edits, {
          key: `panel:source:${source.id}:title`,
          label: "Source title",
          read: () => live().title,
          commit: (value) => update(source.id, (other) => ({ ...other, title: value })),
        }),
        textField(host.edits, {
          key: `panel:source:${source.id}:url`,
          label: "Link",
          hint: "Starts with http:// or https://.",
          read: () => live().url ?? "",
          commit: (value) =>
            update(source.id, ({ url: _url, ...rest }) => (value === "" ? rest : { ...rest, url: value })),
        }),
        selectField(host.edits, {
          key: `panel:source:${source.id}:link`,
          label: "Saved link",
          empty: "No saved link",
          options: linkOptions(host),
          read: () => live().link ?? "",
          commit: (value) =>
            update(source.id, ({ link: _link, ...rest }) => (value === "" ? rest : { ...rest, link: value })),
        }),
        selectField(host.edits, {
          key: `panel:source:${source.id}:asset`,
          label: "File in the deck",
          empty: "No file",
          options: [...host.assets()]
            .sort()
            .map((path) => ({ value: path, label: path.replace(/^assets\//, "") })),
          read: () => live().asset ?? "",
          commit: (value) =>
            update(source.id, ({ asset: _asset, ...rest }) =>
              value === "" ? rest : { ...rest, asset: value },
            ),
        }),
        actionButton(
          "Remove source",
          () => {
            const now = scene();
            if (now) host.run(removeSource(now, source.id));
          },
          { class: "ed-danger", "data-field": `panel:source-remove:${source.id}` },
        ),
      );
    });
    const addSource = () => {
      const live = scene();
      if (!live) return;
      const source: Source = { id: uniqueId(`${live.id}-source`, idsInScene(live)), title: "New source" };
      sources.focusNext(`panel:source:${source.id}:title`);
      host.run([set({ sources: [...list(), source] })]);
    };
    return [
      ...rows,
      actionButton("Add a source", addSource, {
        disabled: list().length >= SOURCES_MAX,
        "data-field": "panel:source:add",
      }),
    ];
  });

  const stepsCount = h("span", { class: "ed-tb-n" });
  const sourcesCount = h("span", { class: "ed-tb-n" });
  const stepsSection = h(
    "details",
    { class: "ed-tb-section", "data-section": "steps" },
    h("summary", {}, "Steps", stepsCount),
    steps.body,
  );
  const sourcesSection = h(
    "details",
    { class: "ed-tb-section", "data-section": "sources" },
    h("summary", {}, "Sources", sourcesCount),
    sources.body,
  );
  // The picture behind the slide is a part of its own, drawn the first time the section is opened.
  let background: { fill(scene: Scene, typing: boolean): void } | undefined;
  const backgroundSection = h(
    "details",
    { class: "ed-tb-section", "data-section": "background" },
    h("summary", {}, "Background"),
  );
  backgroundSection.addEventListener("toggle", () => {
    if (!backgroundSection.open || background) return;
    host.picture?.((module) => {
      const section = module.backgroundSection(host, current);
      background = section;
      backgroundSection.append(section.body);
    });
  });
  const body = h(
    "div",
    { class: "ed-tb-form" },
    title.body,
    stepsSection,
    sourcesSection,
    host.picture && backgroundSection,
  );

  const count = (n: number) => (n > 0 ? String(n) : "");

  return {
    name: "scene",
    label: "Scene",
    title: "Scene title, steps and sources",
    body,
    fill(live, typing) {
      title.fill(live, typing);
      steps.fill(live, typing);
      sources.fill(live, typing);
      background?.fill(live, typing);
      stepsCount.textContent = count(live.steps?.length ?? 0);
      sourcesCount.textContent = count(live.sources?.length ?? 0);
    },
    reveal(section) {
      const details = section === "steps" ? stepsSection : sourcesSection;
      details.open = true;
      details.querySelector<HTMLElement>("[data-field]")?.focus();
    },
  };
}

/** What the presenter reads and what a screen reader says for the scene. Neither is drawn on the slide. */
export function notesPanel(host: PanelHost, current: () => string): Panel {
  const scene = () => host.scene(current());
  const set = (changes: SceneChanges): Op => sceneSet(current(), changes);
  const fields = form(
    () => scene() !== undefined,
    () => [
      textField(host.edits, {
        key: "panel:notes",
        label: "Speaker notes",
        hint: "For the presenter. They never appear on the slide.",
        multiline: true,
        read: () => scene()?.notes ?? "",
        commit: (value) => set({ notes: optional(value) }),
      }),
      textField(host.edits, {
        key: "panel:reading",
        label: "Reading version",
        hint: "What a screen reader and the plain-text view say for this scene.",
        multiline: true,
        read: () => scene()?.reading?.text ?? "",
        commit: (value) => set({ reading: value === "" ? null : { text: value } }),
      }),
    ],
  );
  const written = (live: Scene) => Number(Boolean(live.notes)) + Number(Boolean(live.reading?.text));
  return {
    name: "notes",
    label: "Notes",
    title: "Speaker notes and reading version",
    body: fields.body,
    fill: fields.fill,
    state(live) {
      const n = written(live);
      return {
        badge: n > 0 ? String(n) : "",
        title:
          n > 0 ? `Speaker notes and reading version, ${n} written` : "Speaker notes and reading version",
      };
    },
  };
}

/** The voice a scene is read in when it names none. Kokoro's own default, as `depthcue voice build` has it. */
const DEFAULT_VOICE = "af_heart";

/** Kokoro's American and British English voices, offered as suggestions. Any voice name Kokoro has is accepted. */
const VOICES = [
  "af_heart",
  "af_bella",
  "af_nicole",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_michael",
  "bf_emma",
  "bf_isabella",
  "bm_george",
  "bm_lewis",
] as const;

/** Where a scene's recording stands against what the scene says now. */
export type VoiceStanding = "none" | "missing" | "current" | "stale";

export function voiceStanding(live: Scene): VoiceStanding {
  const voiceover = live.voiceover;
  if (!voiceover) return "none";
  if (!voiceover.audio) return "missing";
  return voiceover.key === voiceKey(voiceover.text, voiceover.voice ?? DEFAULT_VOICE) ? "current" : "stale";
}

/** What is read aloud for a scene, and the recording of it that Kokoro makes, as `depthcue voice build` does. */
/** Offers the voices in `ed-voices` as suggestions in the field's input. */
const withList = (field: HTMLElement) => {
  field.querySelector("input")?.setAttribute("list", "ed-voices");
  return field;
};

export function voicePanel(host: PanelHost, current: () => string): Panel {
  const scene = () => host.scene(current());
  const set = (changes: SceneChanges): Op => sceneSet(current(), changes);
  let busy = false;
  let failure: string | undefined;
  let made: string | undefined;

  const text = () => scene()?.voiceover?.text ?? "";
  const status = h("p", {
    class: "ed-hint-text",
    role: "status",
    "aria-live": "polite",
    "data-voice": "status",
  });
  const problem = h("p", { class: "ed-problem", role: "alert", hidden: true, "data-voice": "problem" });
  const player = h("audio", { controls: true, preload: "none", "data-voice": "preview" });

  const markNote = h("span", { class: "ed-hint-text", "data-voice": "marks" });
  const paint = () => {
    const live = scene();
    const standing = live ? voiceStanding(live) : "none";
    const marks = splitMarks(text()).marks.length;
    const steps = live?.steps?.length ?? 0;
    markNote.textContent =
      steps === 0 ? "This scene has no steps to mark." : `${marks} of ${steps} steps marked`;
    mark.disabled = steps === 0 || marks >= steps;
    mark.title =
      steps === 0
        ? "This scene has no steps, so there is nothing for a mark to show. Add steps in the Scene panel."
        : marks >= steps
          ? "Every step already has a mark."
          : "Put the next step of the slide where the cursor is: it shows when the voice reaches this point.";
    make.disabled = busy || standing === "none" || !host.voice;
    make.textContent = busy
      ? "Making audio…"
      : standing === "current" || standing === "stale"
        ? "Make audio again"
        : "Make audio";
    remove.hidden = busy || !live?.voiceover?.audio;
    const audio = live?.voiceover?.audio;
    player.hidden = !audio || standing === "stale";
    if (audio) {
      const src = `${audio}?v=${live?.voiceover?.key?.slice(0, 8) ?? ""}`;
      if (player.getAttribute("src") !== src) player.setAttribute("src", src);
    } else player.removeAttribute("src");
    problem.hidden = failure === undefined;
    problem.textContent = failure ?? "";
    let line = "";
    if (busy) line = "Kokoro is reading the text. This can take a minute the first time.";
    else if (marks > steps)
      line = `There are ${marks} ${VOICE_MARK} marks but the scene has ${steps} steps, so the audio cannot be made.`;
    else if (made && standing === "current") line = made;
    else if (standing === "stale")
      line = "The text or voice changed since the audio was made. Make it again.";
    else if (standing === "missing") line = "No audio yet.";
    else if (standing === "current") line = "The audio matches the text.";
    status.textContent = line;
  };

  const run = async () => {
    const live = scene()?.voiceover;
    if (!live || busy || !host.voice) return;
    busy = true;
    failure = undefined;
    made = undefined;
    paint();
    const answer = await host.voice(current(), live.voice);
    busy = false;
    if (answer.ok)
      made = answer.built
        ? `Made ${answer.duration.toFixed(1)} s of audio in ${answer.seconds.toFixed(1)} s.`
        : "Already up to date.";
    else failure = answer.message;
    paint();
  };

  const unvoice = () => {
    const live = scene()?.voiceover;
    if (!live) return;
    failure = undefined;
    made = undefined;
    host.run([
      set({ voiceover: { text: live.text, ...(live.voice === undefined ? {} : { voice: live.voice }) } }),
    ]);
  };

  const insertMark = () => {
    const box = fields.body.querySelector<HTMLTextAreaElement>("[data-field='panel:voice-text']");
    if (!box) return;
    const at = box.selectionStart ?? box.value.length;
    const before = `${box.value.slice(0, at).replace(/\s+$/, "")} ${VOICE_MARK} `.trimStart();
    box.value = `${before}${box.value.slice(at).replace(/^\s+/, "")}`.trimEnd();
    box.setSelectionRange(before.length, before.length);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.focus();
  };
  const mark = actionButton(`Insert ${VOICE_MARK} mark`, insertMark, {
    "data-field": "voice:mark",
    title: "Put the next step of the slide where the cursor is: it shows when the voice reaches this point.",
  });
  const make = actionButton("Make audio", () => void run(), { "data-field": "voice:make" });
  const remove = actionButton("Remove audio", unvoice, { "data-field": "voice:remove" });

  const fields = form(
    () => scene() !== undefined,
    () => {
      paint();
      return [
        textField(host.edits, {
          key: "panel:voice-text",
          label: "Voice-over",
          hint: `What Kokoro reads aloud; it is not the speaker notes. Write ${VOICE_MARK} where the next step of the slide should show.`,
          multiline: true,
          read: text,
          commit(value) {
            if (value === "") return set({ voiceover: null });
            return set({ voiceover: { ...scene()?.voiceover, text: value } });
          },
        }),
        h("div", { class: "ed-row" }, mark, markNote),
        withList(
          textField(host.edits, {
            key: "panel:voice-name",
            label: "Voice",
            hint: `A Kokoro voice such as bf_emma. Left empty it is ${DEFAULT_VOICE}.`,
            placeholder: DEFAULT_VOICE,
            read: () => scene()?.voiceover?.voice ?? "",
            commit(value) {
              const live = scene()?.voiceover;
              if (!live) return "Write the voice-over first.";
              const { voice: _old, ...rest } = live;
              return set({ voiceover: value === "" ? rest : { ...rest, voice: value } });
            },
          }),
        ),
        h("div", { class: "ed-row" }, make, remove),
        h("datalist", { id: "ed-voices" }, ...VOICES.map((name) => h("option", { value: name }))),
        status,
        problem,
        player,
      ];
    },
  );
  return {
    name: "voice",
    label: "Voice",
    title: "Voice-over",
    body: fields.body,
    fill(live, typing) {
      fields.fill(live, typing);
      paint();
    },
    state(live) {
      const standing = voiceStanding(live);
      if (standing === "current") return { badge: "✓", title: "Voice-over, audio is up to date" };
      if (standing === "stale") return { badge: "!", title: "Voice-over, audio is out of date" };
      if (standing === "missing") return { badge: "·", title: "Voice-over, no audio yet" };
      return { badge: "", title: "Voice-over" };
    },
  };
}

const THEME_LABEL = { paper: "Paper (light)", ink: "Ink (dark)" } as const;

/** What each palette color is for, in a person's words. A color the schema adds is a type error here until it is named. */
export const COLOR_LABEL: Record<PaletteColor, string> = {
  bg: "Background",
  surface: "Panels and cards",
  line: "Lines and borders",
  text: "Text",
  muted: "Muted text",
  action: "Accent",
  evidence: "Evidence and links",
};

/** The four font pairs, by name and by the fonts they are made of. A pair the schema adds is a type error until it is named. */
export const FONT_LABEL: Record<FontPair, { label: string; detail: string }> = {
  editorial: { label: "Editorial", detail: "Instrument Serif and Space Grotesk" },
  modern: { label: "Modern", detail: "Inter" },
  classic: { label: "Classic", detail: "Depthcue Classic Serif and Depthcue Classic Sans" },
  technical: { label: "Technical", detail: "IBM Plex Sans" },
};

type Palette = Partial<Record<PaletteColor, string>>;

export interface DeckPanel extends Panel {
  /** Opens the Style section and puts the keyboard in it. */
  reveal(section: "style"): void;
}

/** The deck's title, language, style (the theme preset, the palette and the font pair) and what it asks of each module. */
export function deckPanel(host: PanelHost): DeckPanel {
  const deck = () => host.deck();
  const setModules = (modules: Record<string, string>): Op => ({
    op: "deck.set",
    set: { modules: Object.keys(modules).length > 0 ? modules : null },
  });
  const modules = () => deck().modules ?? {};
  const without = (id: string) => Object.fromEntries(Object.entries(modules()).filter(([key]) => key !== id));
  const installed = new Set(firstPartyManifests.map((manifest) => manifest.id));

  // The palette is replaced whole, and an empty one is taken out, so a deck without a palette stays without one.
  const palette = (): Palette => deck().palette ?? {};
  const setPalette = (next: Palette): Op => ({
    op: "deck.set",
    set: { palette: Object.keys(next).length > 0 ? next : null },
  });
  const unpainted = (color: PaletteColor): Palette =>
    Object.fromEntries(Object.entries(palette()).filter(([key]) => key !== color));

  const top = form(
    () => true,
    () => [
      textField(host.edits, {
        key: "panel:deck:title",
        label: "Title",
        read: () => deck().title,
        commit: (value) => ({ op: "deck.set", set: { title: value } }),
      }),
      textField(host.edits, {
        key: "panel:deck:language",
        label: "Language",
        hint: "A language tag such as en or pt-BR.",
        read: () => deck().language,
        commit: (value) => ({ op: "deck.set", set: { language: value } }),
      }),
    ],
  );

  // A brand that sets `lock` keeps its colors and fonts: the controls for them are off, with the refusal they would get.
  const locked = (set: HTMLElement, why: string | undefined) => {
    if (why) {
      set.setAttribute("disabled", "");
      set.append(h("p", { class: "ed-hint-text", "data-locked": "" }, why));
    }
    return set;
  };
  const style = form(
    () => true,
    () => {
      // The refusals `deck.set` would give a palette and a font pair, in that order, or none while the brand is open.
      const [colors, fonts] = checkBrandLock(
        { ...deck(), palette: {}, fonts: "modern" },
        host.brand?.(),
        "",
      ).map((diagnostic) => diagnostic.message);
      return [
        selectField(host.edits, {
          key: "panel:deck:theme",
          label: "Preset",
          options: THEMES.map((value) => ({ value, label: THEME_LABEL[value] })),
          read: () => deck().theme,
          commit: (value) => ({ op: "deck.set", set: { theme: value as (typeof THEMES)[number] } }),
        }),
        locked(
          h(
            "fieldset",
            { class: "ed-colors" },
            h("legend", { class: "ed-label" }, "Colors"),
            h(
              "p",
              { class: "ed-hint-text" },
              "A swatch changes one color of the preset. A color that would leave text hard to read is refused: to go dark, choose the Ink preset first.",
            ),
            ...PALETTE_COLORS.map((color) =>
              colorField(host.edits, {
                key: `panel:deck:palette:${color}`,
                label: COLOR_LABEL[color],
                read: () => styleOf(deck()).colors[color],
                commit: (value) => setPalette({ ...palette(), [color]: value }),
                changed: () => Object.hasOwn(palette(), color),
                reset: () => setPalette(unpainted(color)),
                problem: host.problem,
              }),
            ),
            actionButton(
              "Reset all colors",
              () => {
                if (Object.keys(palette()).length > 0) host.run([setPalette({})]);
              },
              { "data-field": "panel:deck:palette:reset" },
            ),
          ),
          colors,
        ),
        locked(
          choiceField(host.edits, {
            key: "panel:deck:fonts",
            label: "Fonts",
            choices: FONT_PAIRS.map((pair) => ({
              value: pair,
              label: FONT_LABEL[pair].label,
              detail: FONT_LABEL[pair].detail,
              attributes: { "data-fonts": pair },
            })),
            read: () => styleOf(deck()).fonts,
            commit: (value) => ({ op: "deck.set", set: { fonts: value as FontPair } }),
          }),
          fonts,
        ),
      ];
    },
  );

  // The date the header and footer show, and how slides are numbered: where the first starts, and which skip it.
  const numbering = () => deck().numbering ?? {};
  const setNumbering = (patch: { start?: number | null; skip?: string[] | null }): Op => {
    const next: { start?: number; skip?: string[] } = { ...numbering() };
    if (patch.start !== undefined) {
      if (patch.start === null || patch.start === 1) delete next.start;
      else next.start = patch.start;
    }
    if (patch.skip !== undefined) {
      if (patch.skip === null || patch.skip.length === 0) delete next.skip;
      else next.skip = patch.skip;
    }
    return { op: "deck.set", set: { numbering: Object.keys(next).length > 0 ? next : null } };
  };
  const footing = form(
    () => true,
    () => [
      textField(host.edits, {
        key: "panel:deck:date",
        label: "Date",
        hint: "What {date} shows in the header and footer, as written.",
        read: () => deck().date ?? "",
        commit: (value) => ({ op: "deck.set", set: { date: value === "" ? null : value } }),
      }),
      numberField(host.edits, {
        key: "panel:deck:numbering-start",
        label: "First slide is number",
        read: () => numbering().start ?? 1,
        commit: (value) => setNumbering({ start: value }),
      }),
      selectField(host.edits, {
        key: "panel:deck:numbering-skip",
        label: "No number on",
        options: [
          { value: "", label: "No slide" },
          { value: "title,section", label: "Title and section slides" },
        ],
        read: () => (numbering().skip ?? []).join(","),
        commit: (value) => setNumbering({ skip: value === "" ? null : value.split(",") }),
      }),
    ],
  );

  const links = form(
    () => true,
    () => {
      const list = () => deck().links ?? [];
      const change = (id: string, set: Record<string, string | null>): Op => ({ op: "link.set", id, set });
      const rows = list().map((entry) => {
        const live = () => list().find((candidate) => candidate.id === entry.id) ?? entry;
        const file = () => {
          const target = parseTarget(live().target);
          return target?.kind === "asset" ? target.asset : "";
        };
        return h(
          "div",
          { class: "ed-source", "data-link": entry.id },
          textField(host.edits, {
            key: `panel:link:${entry.id}:title`,
            label: "Link title",
            read: () => live().title,
            commit: (value) => change(entry.id, { title: value }),
          }),
          textField(host.edits, {
            key: `panel:link:${entry.id}:target`,
            label: "Goes to",
            hint: TARGET_RULE,
            read: () => live().target,
            commit: (value) => change(entry.id, { target: value }),
          }),
          selectField(host.edits, {
            key: `panel:link:${entry.id}:file`,
            label: "Or a file in the deck",
            empty: "Choose a file",
            options: [...host.assets()]
              .sort()
              .map((path) => ({ value: path, label: path.replace(/^assets\//, "") })),
            read: file,
            commit: (value) => change(entry.id, { target: value === "" ? live().target : value }),
          }),
          textField(host.edits, {
            key: `panel:link:${entry.id}:note`,
            label: "Note",
            read: () => live().note ?? "",
            commit: (value) => change(entry.id, { note: optional(value) }),
          }),
          actionButton("Remove link", () => host.run([{ op: "link.remove", id: entry.id }]), {
            class: "ed-danger",
            "data-field": `panel:link-remove:${entry.id}`,
          }),
        );
      });
      const addLink = () => {
        const taken = list().map((entry) => entry.id);
        const id = uniqueId("link", new Set(taken));
        links.focusNext(`panel:link:${id}:title`);
        host.run([{ op: "link.add", link: { id, title: "New link", target: "https://example.com" } }]);
      };
      return [
        h(
          "p",
          { class: "ed-hint-text" },
          "Saved links are used by blocks and sources. Change one here and every use follows.",
        ),
        ...rows,
        actionButton("Add a link", addLink, {
          disabled: list().length >= LINK_LIMITS.links,
          "data-field": "panel:link:add",
        }),
      ];
    },
  );

  const moduleSettings = form(
    () => true,
    () => [
      ...firstPartyManifests.map((manifest) =>
        selectField(host.edits, {
          key: `panel:deck:module:${manifest.id}`,
          label: manifest.title,
          empty: "Automatic",
          options: [
            { value: "off", label: `Off: show it as ${manifest.fallback}` },
            { value: manifest.version, label: `Needs version ${manifest.version} or newer` },
          ],
          read: () => modules()[manifest.id] ?? "",
          commit: (value) =>
            setModules(value === "" ? without(manifest.id) : { ...modules(), [manifest.id]: value }),
        }),
      ),
      // A setting for a module this editor does not have: the player ignores it, and it can be removed.
      ...Object.keys(modules())
        .filter((id) => !installed.has(id))
        .map((id) =>
          h(
            "div",
            { class: "ed-field", "data-module": id },
            h(
              "p",
              { class: "ed-hint-text" },
              `${id} (${modules()[id]}) is not installed here, so the player ignores it.`,
            ),
            actionButton("Remove", () => host.run([setModules(without(id))]), {
              "data-field": `panel:deck:module:${id}:remove`,
              "aria-label": `Remove the setting for ${id}`,
            }),
          ),
        ),
    ],
  );

  // The section stays in place while its contents are drawn again, so a person who opened it keeps it open.
  const styleSection = h(
    "details",
    { class: "ed-tb-section", "data-section": "style" },
    h("summary", {}, "Style"),
    style.body,
  );
  const footingSection = h(
    "details",
    { class: "ed-tb-section", "data-section": "footing" },
    h("summary", {}, "Date and numbers"),
    footing.body,
  );
  const linksCount = h("span", { class: "ed-tb-n" });
  const linksSection = h(
    "details",
    { class: "ed-tb-section", "data-section": "links" },
    h("summary", {}, "Links", linksCount),
    links.body,
  );
  const body = h(
    "div",
    { class: "ed-tb-form" },
    top.body,
    styleSection,
    footingSection,
    linksSection,
    moduleSettings.body,
  );
  return {
    name: "deck",
    label: "Deck",
    title: "Deck title, language, style and modules",
    body,
    fill(live, typing) {
      top.fill(live, typing);
      style.fill(live, typing);
      footing.fill(live, typing);
      links.fill(live, typing);
      linksCount.textContent = (deck().links ?? []).length > 0 ? String((deck().links ?? []).length) : "";
      moduleSettings.fill(live, typing);
    },
    reveal() {
      styleSection.open = true;
      styleSection.querySelector<HTMLElement>("[data-field]")?.focus();
    },
  };
}
