import {
  type Block,
  type BlockChanges,
  type Op,
  type Scene,
  type SceneChanges,
  type Session,
  THEMES,
} from "@depthcue/core";
import { firstPartyManifests, h } from "@depthcue/player";
import { addedRow, CHART_ROWS_MAX, sortedRows } from "./chart.ts";
import { removeSource, swapped } from "./cleanup.ts";
import {
  actionButton,
  checkField,
  type Edits,
  fileButton,
  numberField,
  problemOf,
  selectField,
  textField,
} from "./fields.ts";
import { describeBlock, IMAGE_ACCEPT, IMAGE_FILE, idsInScene, uniqueId, VIDEO_FILE } from "./templates.ts";

const optional = (value: string) => (value === "" ? null : value);

/** What a panel needs from the toolbar that shows it. */
export interface PanelHost {
  readonly edits: Edits;
  scene(id: string): Scene | undefined;
  deck(): Session["doc"]["deck"];
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
  /** Opens where the scene's sources are added and edited. */
  openSources(): void;
}

/** What the toolbar and the scene bar each bring to their panels; the rest is read from the session. */
export function panelHost(
  session: Session,
  parts: Pick<PanelHost, "edits" | "upload" | "problem" | "close" | "openSources">,
): PanelHost {
  return {
    ...parts,
    scene: (id) => session.doc.scenes[id],
    deck: () => session.doc.deck,
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

const assetOptions = (host: PanelHost, pattern: RegExp) =>
  [...host.assets()]
    .filter((path) => pattern.test(path))
    .sort()
    .map((path) => ({ value: path, label: path.replace(/^assets\//, "") }));

/**
 * The popover body for a block's own properties. It is drawn from the document again after every change that did
 * not come from typing in it, and the control that had the keyboard is found again by its `data-field`.
 */
function form(exists: () => boolean, draw: () => Node[]) {
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
    focusNext(key: string) {
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

/** Takes a file, stores it in the deck, and points the image at it. */
function uploader(host: PanelHost, sceneId: string, id: string) {
  return async (file: File) => {
    host.problem(undefined);
    try {
      host.run([blockSet(sceneId, id, { asset: await host.upload(file) })]);
    } catch (error) {
      host.problem(error instanceof Error ? error.message : "The upload failed.");
    }
  };
}

/** An image's file, with a way to upload another, its alt text and its caption. */
export function imagePanel(host: PanelHost, sceneId: string, id: string): Panel {
  const image = () => {
    const block = blockOf(host, sceneId, id);
    return block?.type === "image" ? block : undefined;
  };
  const key = (name: string) => `image:${name}`;
  const replace = uploader(host, sceneId, id);

  const panel = form(
    () => image() !== undefined,
    () => [
      selectField(host.edits, {
        key: key("asset"),
        label: "Image file",
        options: assetOptions(host, IMAGE_FILE),
        read: () => image()?.asset ?? "",
        commit: (value) => blockSet(sceneId, id, { asset: value }),
      }),
      fileButton("Upload a new image", IMAGE_ACCEPT, key("upload"), (file) => void replace(file)),
      textField(host.edits, {
        key: key("alt"),
        label: "Alt text",
        hint: "What the image shows, for people who cannot see it.",
        read: () => image()?.alt ?? "",
        commit: (value) => blockSet(sceneId, id, { alt: value }),
      }),
      textField(host.edits, {
        key: key("caption"),
        label: "Caption",
        read: () => image()?.caption ?? "",
        commit: (value) => blockSet(sceneId, id, { caption: optional(value) }),
      }),
    ],
  );

  return {
    name: "edit",
    label: "Edit",
    title: "Image file, alt text and caption",
    body: panel.body,
    fill: panel.fill,
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
        commit: (value) => blockSet(sceneId, id, { source: value }),
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

  return {
    name: "edit",
    label: "Edit",
    title: "Clip file, poster and alt text",
    body: panel.body,
    fill: panel.fill,
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
          items: scene.blocks.map((block) => ({ id: block.id, label: describeBlock(block) })),
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

/** The most steps and sources a scene holds. The schema says so too; the core does not export them. */
const STEPS_MAX = 24;
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
  ]);

  const steps = form(exists, () => {
    const s = scene();
    if (!s) return [];
    const list = () => scene()?.steps ?? [];
    const revealable = [
      ...(s.summary ? [{ id: s.summary.id, label: `Claim: ${s.summary.text.slice(0, 30)}` }] : []),
      ...s.blocks.map((block) => ({ id: block.id, label: describeBlock(block) })),
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
  const body = h("div", { class: "ed-tb-form" }, title.body, stepsSection, sourcesSection);

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

const THEME_LABEL = { paper: "Paper (light)", ink: "Ink (dark)" } as const;

/** The deck's title, language, theme and what it asks of each module. */
export function deckPanel(host: PanelHost): Panel {
  const deck = () => host.deck();
  const setModules = (modules: Record<string, string>): Op => ({
    op: "deck.set",
    set: { modules: Object.keys(modules).length > 0 ? modules : null },
  });
  const modules = () => deck().modules ?? {};
  const without = (id: string) => Object.fromEntries(Object.entries(modules()).filter(([key]) => key !== id));
  const installed = new Set(firstPartyManifests.map((manifest) => manifest.id));

  const fields = form(
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
      selectField(host.edits, {
        key: "panel:deck:theme",
        label: "Theme",
        options: THEMES.map((value) => ({ value, label: THEME_LABEL[value] })),
        read: () => deck().theme,
        commit: (value) => ({ op: "deck.set", set: { theme: value as (typeof THEMES)[number] } }),
      }),
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
  return {
    name: "deck",
    label: "Deck",
    title: "Deck title, language, theme and modules",
    body: fields.body,
    fill: fields.fill,
  };
}
