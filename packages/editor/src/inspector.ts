import {
  type ApplyOptions,
  type BlockChanges,
  LEADS,
  type Op,
  type Scene,
  type SceneChanges,
  type Session,
  TEXT_ROLES,
  THEMES,
} from "@depthcue/core";
import { firstPartyManifests, h } from "@depthcue/player";
import { afterWhenMoving, removeBlock, removeClaim, removeSource, swapped } from "./cleanup.ts";
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
import { sortable } from "./sortable.ts";
import {
  BLOCK_KINDS,
  describeBlock,
  IMAGE_ACCEPT,
  IMAGE_FILE,
  idsInScene,
  LAYOUT_CHOICES,
  type Layout,
  LEAD_LABEL,
  type NewBlockKind,
  newBlock,
  ROLE_LABEL,
  uniqueId,
  VIDEO_FILE,
} from "./templates.ts";

export interface InspectorHost {
  session: Session;
  edits: Edits;
  /** The scene being edited. */
  scene(): string;
  /** The selected block of that scene, if any. */
  block(): string | undefined;
  selectBlock(id: string | undefined): void;
  selectScene(id: string): void;
  /** Stores an image in the deck and answers with its path. Rejects with a message the person can read. */
  upload(file: File): Promise<string>;
}

export interface Inspector {
  readonly element: HTMLElement;
  render(): void;
}

const THEME_LABEL = { paper: "Paper (light)", ink: "Ink (dark)" } as const;
type Source = NonNullable<Scene["sources"]>[number];
type Step = NonNullable<Scene["steps"]>[number];

const optional = (value: string) => (value === "" ? null : value);

/**
 * The column of forms beside the canvas: every property a deck, scene or block has, each applied through the
 * same core operations as typing on the slide. A change the core refuses is shown under the field it came from
 * and never kept, so the forms cannot put the deck in a state that would not save.
 */
export function createInspector(host: InspectorHost): Inspector {
  const { session, edits } = host;
  const problem = h("p", { class: "ed-problem ed-inspector-problem", role: "alert", hidden: true });
  const body = h("div", { class: "ed-inspector-body" });
  const element = h("aside", { class: "ed-inspector", "aria-label": "Properties" }, problem, body);
  // What the person chose for each section. A section they never touched follows its default, so it can open
  // by itself when the scene has something in it, such as a claim.
  const open = new Map<string, boolean>();
  const drawn = new Map<string, boolean>();
  let lastBlock: string | undefined;

  const doc = () => session.doc;
  const scene = () => doc().scenes[host.scene()] as Scene;

  const report = (text: string | undefined) => {
    problem.hidden = text === undefined;
    problem.textContent = text ?? "";
  };

  /** A click or a choice: applied, and a refusal shown at the top of the column. */
  const run = (ops: readonly Op[], options?: ApplyOptions) => {
    const result = edits.act(ops, options);
    report(result.ok ? undefined : problemOf(result));
    return result;
  };

  const sceneSet = (set: SceneChanges): Op => ({ op: "scene.set", id: host.scene(), set });
  const blockSet = (id: string, set: BlockChanges): Op => ({ op: "block.set", scene: host.scene(), id, set });

  const assets = (pattern?: RegExp) =>
    [...doc().assets]
      .filter((path) => !pattern || pattern.test(path))
      .sort()
      .map((path) => ({ value: path, label: path.replace(/^assets\//, "") }));

  async function withUpload(file: File, then: (asset: string) => void) {
    report(undefined);
    try {
      then(await host.upload(file));
    } catch (error) {
      report(error instanceof Error ? error.message : "The upload failed.");
    }
  }

  function section(
    name: string,
    title: string,
    defaultOpen: boolean,
    ...children: Array<Node | false | undefined>
  ) {
    const details = h(
      "details",
      { class: "ed-section", "data-section": name },
      h("summary", {}, title),
      h("div", { class: "ed-section-body" }, ...children),
    );
    details.open = open.get(name) ?? defaultOpen;
    drawn.set(name, details.open);
    return details;
  }

  function note(text: string) {
    return h("p", { class: "ed-hint-text" }, text);
  }

  function row(...children: Array<Node | false | undefined>) {
    return h("div", { class: "ed-row" }, ...children);
  }

  // Deck

  function deckSection() {
    const deck = () => doc().deck;
    return section(
      "deck",
      "Deck",
      false,
      textField(edits, {
        key: "deck:title",
        label: "Title",
        read: () => deck().title,
        commit: (value) => ({ op: "deck.set", set: { title: value } }),
      }),
      textField(edits, {
        key: "deck:language",
        label: "Language",
        hint: "A language tag such as en or pt-BR.",
        read: () => deck().language,
        commit: (value) => ({ op: "deck.set", set: { language: value } }),
      }),
      selectField(edits, {
        key: "deck:theme",
        label: "Theme",
        options: THEMES.map((value) => ({ value, label: THEME_LABEL[value] })),
        read: () => deck().theme,
        commit: (value) => ({ op: "deck.set", set: { theme: value as (typeof THEMES)[number] } }),
      }),
      ...moduleFields(),
    );
  }

  /** What the deck asks of each module: nothing (automatic), off, or at least the installed version. */
  function moduleFields() {
    const settings = () => doc().deck.modules ?? {};
    const setModules = (modules: Record<string, string>): Op => ({
      op: "deck.set",
      set: { modules: Object.keys(modules).length > 0 ? modules : null },
    });
    const without = (id: string) =>
      Object.fromEntries(Object.entries(settings()).filter(([key]) => key !== id));
    const installed = new Set(firstPartyManifests.map((manifest) => manifest.id));
    const unknown = Object.keys(settings()).filter((id) => !installed.has(id));
    return [
      ...firstPartyManifests.map((manifest) =>
        selectField(edits, {
          key: `deck:module:${manifest.id}`,
          label: manifest.title,
          empty: "Automatic",
          options: [
            { value: "off", label: `Off: show it as ${manifest.fallback}` },
            { value: manifest.version, label: `Needs version ${manifest.version} or newer` },
          ],
          read: () => settings()[manifest.id] ?? "",
          commit: (value) =>
            setModules(value === "" ? without(manifest.id) : { ...settings(), [manifest.id]: value }),
        }),
      ),
      ...unknown.map((id) =>
        h(
          "div",
          { class: "ed-field", "data-module": id },
          h(
            "p",
            { class: "ed-hint-text" },
            `${id} (${settings()[id]}) is not installed here, so the player ignores it.`,
          ),
          actionButton("Remove", () => run([setModules(without(id))]), {
            "data-field": `deck:module:${id}:remove`,
            "aria-label": `Remove the setting for ${id}`,
          }),
        ),
      ),
    ];
  }

  // Scene

  function sceneSection() {
    const id = host.scene();
    const order = doc().deck.scenes;
    const up = afterWhenMoving(order, id, -1);
    const down = afterWhenMoving(order, id, 1);
    const remove = () => {
      const at = order.indexOf(id);
      const neighbour = order[at + 1] ?? order[at - 1];
      const result = run([{ op: "scene.remove", id }]);
      if (result.ok && neighbour) host.selectScene(neighbour);
    };
    return section(
      "scene",
      "Scene",
      true,
      textField(edits, {
        key: "scene:title",
        label: "Title",
        read: () => scene().title,
        commit: (value) => sceneSet({ title: value }),
      }),
      selectField(edits, {
        key: "scene:layout",
        label: "Layout",
        options: LAYOUT_CHOICES,
        read: () => scene().layout,
        commit: (value) => sceneSet({ layout: value as Layout }),
      }),
      selectField(edits, {
        key: "scene:lead",
        label: "Who leads",
        empty: "Not set (human)",
        options: LEADS.map((value) => ({ value, label: LEAD_LABEL[value] })),
        read: () => scene().lead ?? "",
        commit: (value) => sceneSet({ lead: value === "" ? null : (value as (typeof LEADS)[number]) }),
      }),
      textField(edits, {
        key: "scene:notes",
        label: "Speaker notes",
        multiline: true,
        read: () => scene().notes ?? "",
        commit: (value) => sceneSet({ notes: optional(value) }),
      }),
      textField(edits, {
        key: "scene:reading",
        label: "Reading version",
        hint: "What a screen reader and the plain-text view say for this scene.",
        multiline: true,
        read: () => scene().reading?.text ?? "",
        commit: (value) => sceneSet({ reading: value === "" ? null : { text: value } }),
      }),
      row(
        actionButton("Move up", () => up !== undefined && run([{ op: "scene.move", id, after: up }]), {
          disabled: up === undefined,
          "data-field": "scene:up",
        }),
        actionButton("Move down", () => down !== undefined && run([{ op: "scene.move", id, after: down }]), {
          disabled: down === undefined,
          "data-field": "scene:down",
        }),
        actionButton("Remove scene", remove, {
          disabled: order.length < 2,
          class: "ed-danger",
          "data-field": "scene:remove",
        }),
      ),
    );
  }

  // Claim

  function claimSection(s: Scene) {
    const summary = s.summary;
    if (!summary) {
      return section(
        "claim",
        "Claim",
        s.layout === "claim-evidence",
        note("This scene has no claim yet."),
        actionButton(
          "Add a claim",
          () =>
            run([
              sceneSet({
                summary: {
                  id: uniqueId(`${s.id}-claim`, idsInScene(scene())),
                  text: "State the claim here.",
                  evidenceIds: [],
                },
              }),
            ]),
          { "data-field": "claim:add" },
        ),
      );
    }
    const live = () => scene().summary ?? summary;
    return section(
      "claim",
      "Claim",
      true,
      textField(edits, {
        key: "claim:text",
        label: "Claim",
        multiline: true,
        read: () => live().text,
        commit: (value) => sceneSet({ summary: { ...live(), text: value } }),
      }),
      checkField(edits, {
        key: "claim:evidence",
        label: "Evidence",
        items: s.blocks.map((block) => ({ id: block.id, label: describeBlock(block) })),
        none: "Add a block to use as evidence.",
        read: () => live().evidenceIds,
        commit: (ids) => sceneSet({ summary: { ...live(), evidenceIds: ids } }),
      }),
      actionButton("Remove claim", () => run(removeClaim(scene())), {
        class: "ed-danger",
        "data-field": "claim:remove",
      }),
    );
  }

  // Blocks

  function addBlock(sceneId: string, kind: NewBlockKind, asset?: string) {
    const target = doc().scenes[sceneId];
    if (!target) return;
    const block = newBlock(target, kind, asset);
    const anchor = host.block();
    const after =
      anchor !== undefined && target.blocks.some((candidate) => candidate.id === anchor) ? anchor : undefined;
    const result = run([
      { op: "block.add", scene: sceneId, block, ...(after === undefined ? {} : { after }) },
    ]);
    if (result.ok) host.selectBlock(block.id);
  }

  function blocksSection(s: Scene) {
    const ids = s.blocks.map((block) => block.id);
    const items = new Map<string, HTMLElement>();
    const list = h("ol", { class: "ed-block-list" });
    for (const block of s.blocks) {
      const up = afterWhenMoving(ids, block.id, -1);
      const down = afterWhenMoving(ids, block.id, 1);
      const label = describeBlock(block);
      const item = h(
        "li",
        { class: "ed-block-item" },
        actionButton(label, () => host.selectBlock(block.id), {
          class: "ed-pick",
          "aria-pressed": String(block.id === host.block()),
          "data-field": `pick:${block.id}`,
        }),
        actionButton(
          "Up",
          () => up !== undefined && run([{ op: "block.move", scene: s.id, id: block.id, after: up }]),
          { disabled: up === undefined, "aria-label": `Move ${label} up`, "data-field": `up:${block.id}` },
        ),
        actionButton(
          "Down",
          () => down !== undefined && run([{ op: "block.move", scene: s.id, id: block.id, after: down }]),
          {
            disabled: down === undefined,
            "aria-label": `Move ${label} down`,
            "data-field": `down:${block.id}`,
          },
        ),
        actionButton("Remove", () => run(removeBlock(scene(), block.id)), {
          class: "ed-danger",
          "aria-label": `Remove ${label}`,
          "data-field": `remove:${block.id}`,
        }),
      );
      items.set(block.id, item);
      list.append(item);
    }
    sortable(list, items, {
      ids: () => scene().blocks.map((block) => block.id),
      move: (id, after) => void run([{ op: "block.move", scene: host.scene(), id, after }]),
    });

    const videos = assets(VIDEO_FILE);
    const adders = h(
      "div",
      { class: "ed-row ed-adders" },
      ...BLOCK_KINDS.map(({ kind, label }) => {
        if (kind === "image") {
          return fileButton(
            `Add ${label.toLowerCase()}`,
            IMAGE_ACCEPT,
            "add:image",
            (file) => void withUpload(file, (asset) => addBlock(s.id, "image", asset)),
          );
        }
        if (kind === "clip") {
          const first = videos[0];
          return actionButton(
            `Add ${label.toLowerCase()}`,
            () => first && addBlock(s.id, "clip", first.value),
            {
              disabled: first === undefined,
              title: first ? undefined : "Put an .mp4 or .webm file in the deck's assets folder first.",
              "data-field": "add:clip",
            },
          );
        }
        return actionButton(`Add ${label.toLowerCase()}`, () => addBlock(s.id, kind), {
          "data-field": `add:${kind}`,
        });
      }),
    );
    return section("blocks", "Blocks", true, list, adders);
  }

  // One block's properties

  function blockSection(s: Scene) {
    const block = s.blocks.find((candidate) => candidate.id === host.block());
    if (!block) return undefined;
    const id = block.id;
    const key = (name: string) => `block:${id}:${name}`;
    const live = () => scene().blocks.find((candidate) => candidate.id === id);
    const prop = <T>(name: string, fallback: T): T =>
      ((live() as Record<string, unknown> | undefined)?.[name] as T | undefined) ?? fallback;
    const text = (
      name: string,
      label: string,
      required: boolean,
      extra: { multiline?: boolean; hint?: string } = {},
    ) =>
      textField(edits, {
        key: key(name),
        label,
        ...extra,
        read: () => prop<string>(name, ""),
        commit: (value) => blockSet(id, { [name]: required ? value : optional(value) }),
      });

    const fields: HTMLElement[] = [];
    switch (block.type) {
      case "text":
        fields.push(
          selectField(edits, {
            key: key("role"),
            label: "Role",
            options: TEXT_ROLES.map((value) => ({ value, label: ROLE_LABEL[value] })),
            read: () => prop<string>("role", "body"),
            commit: (value) => blockSet(id, { role: value }),
          }),
          text("text", "Text", true, { multiline: true }),
        );
        break;
      case "image":
        fields.push(
          selectField(edits, {
            key: key("asset"),
            label: "Image file",
            options: assets(IMAGE_FILE),
            read: () => prop<string>("asset", ""),
            commit: (value) => blockSet(id, { asset: value }),
          }),
          fileButton(
            "Upload a new image",
            IMAGE_ACCEPT,
            key("upload"),
            (file) => void withUpload(file, (asset) => void run([blockSet(id, { asset })])),
          ),
          text("alt", "Alt text", true, { hint: "What the image shows, for people who cannot see it." }),
          text("caption", "Caption", false),
        );
        break;
      case "bar-chart":
        fields.push(
          text("title", "Chart title", false),
          text("unit", "Unit", false, { hint: "Short, such as % or ms." }),
          chartRows(id, key),
        );
        break;
      case "clip":
        fields.push(
          selectField(edits, {
            key: key("source"),
            label: "Video file",
            options: assets(VIDEO_FILE),
            read: () => prop<string>("source", ""),
            commit: (value) => blockSet(id, { source: value }),
          }),
          selectField(edits, {
            key: key("poster"),
            label: "Poster image",
            empty: "No poster",
            options: assets(IMAGE_FILE),
            read: () => prop<string>("poster", ""),
            commit: (value) => blockSet(id, { poster: optional(value) }),
          }),
          text("alt", "Alt text", true, { hint: "What the clip shows, for people who cannot see it." }),
        );
        break;
    }
    fields.push(
      checkField(edits, {
        key: key("sources"),
        label: "Cites",
        items: (s.sources ?? []).map((source) => ({ id: source.id, label: source.title })),
        none: "Add a source in the Sources section first.",
        read: () => prop<string[]>("sourceIds", []),
        commit: (ids) => blockSet(id, { sourceIds: ids.length > 0 ? ids : null }),
      }),
    );
    return section("block", describeBlock(block, 28), true, ...fields);
  }

  function chartRows(id: string, key: (name: string) => string) {
    type Row = { label: string; value: number };
    const rows = () => {
      const found = scene().blocks.find((candidate) => candidate.id === id);
      return found?.type === "bar-chart" ? (found.data as Row[]) : [];
    };
    const setRows = (next: Row[]): Op => blockSet(id, { data: next });
    const current = rows();
    const table = h("div", { class: "ed-rows", role: "group", "aria-label": "Chart data" });
    current.forEach((_, index) => {
      table.append(
        h(
          "div",
          { class: "ed-chart-row" },
          textField(edits, {
            key: key(`row${index}:label`),
            label: `Row ${index + 1} label`,
            bare: true,
            read: () => rows()[index]?.label ?? "",
            commit: (value) =>
              setRows(rows().map((row, at) => (at === index ? { ...row, label: value } : row))),
          }),
          numberField(edits, {
            key: key(`row${index}:value`),
            label: `Row ${index + 1} value`,
            bare: true,
            read: () => rows()[index]?.value ?? 0,
            commit: (value) => setRows(rows().map((row, at) => (at === index ? { ...row, value } : row))),
          }),
          actionButton("Remove", () => run([setRows(rows().filter((_row, at) => at !== index))]), {
            disabled: current.length < 2,
            "aria-label": `Remove row ${index + 1}`,
            "data-field": key(`row${index}:remove`),
          }),
        ),
      );
    });
    return h(
      "div",
      { class: "ed-chart" },
      h("span", { class: "ed-label" }, "Data"),
      table,
      actionButton(
        "Add a row",
        () => run([setRows([...rows(), { label: `Item ${rows().length + 1}`, value: 0 }])]),
        { "data-field": key("addrow") },
      ),
    );
  }

  // Steps

  function stepsSection(s: Scene) {
    const steps = () => scene().steps ?? [];
    const revealable = [
      ...(s.summary ? [{ id: s.summary.id, label: `Claim: ${s.summary.text.slice(0, 30)}` }] : []),
      ...s.blocks.map((block) => ({ id: block.id, label: describeBlock(block) })),
    ];
    const setSteps = (next: Step[]): Op => sceneSet({ steps: next.length > 0 ? next : null });
    const current = steps();
    const rows = current.map((step, index) => {
      const earlier = swapped(current, index, -1);
      const later = swapped(current, index, 1);
      return h(
        "div",
        { class: "ed-step" },
        checkField(edits, {
          key: `step:${step.id}`,
          label: `Step ${index + 1} reveals`,
          items: revealable,
          read: () => steps().find((candidate) => candidate.id === step.id)?.reveal ?? [],
          commit: (ids) =>
            setSteps(steps().map((other) => (other.id === step.id ? { ...other, reveal: ids } : other))),
        }),
        row(
          actionButton("Up", () => earlier && run([setSteps(earlier)]), {
            disabled: earlier === undefined,
            "aria-label": `Move step ${index + 1} up`,
            "data-field": `step-up:${step.id}`,
          }),
          actionButton("Down", () => later && run([setSteps(later)]), {
            disabled: later === undefined,
            "aria-label": `Move step ${index + 1} down`,
            "data-field": `step-down:${step.id}`,
          }),
          actionButton("Remove", () => run([setSteps(steps().filter((other) => other.id !== step.id))]), {
            class: "ed-danger",
            "aria-label": `Remove step ${index + 1}`,
            "data-field": `step-remove:${step.id}`,
          }),
        ),
      );
    });
    const addStep = () => {
      const used = new Set(steps().flatMap((step) => step.reveal));
      const target = revealable.find((candidate) => !used.has(candidate.id)) ?? revealable[0];
      if (!target) return;
      const step: Step = { id: uniqueId(`${s.id}-step`, idsInScene(scene())), reveal: [target.id] };
      run([setSteps([...steps(), step])]);
    };
    return section(
      "steps",
      "Steps",
      false,
      note("Each press in the presentation reveals one step. What no step names is there from the start."),
      ...rows,
      actionButton("Add a step", addStep, {
        disabled: revealable.length === 0,
        "data-field": "step:add",
      }),
    );
  }

  // Sources

  function sourcesSection(s: Scene) {
    const sources = () => scene().sources ?? [];
    const update = (id: string, change: (source: Source) => Source): Op =>
      sceneSet({ sources: sources().map((source) => (source.id === id ? change(source) : source)) });
    const rows = (s.sources ?? []).map((source) => {
      const live = () => sources().find((candidate) => candidate.id === source.id) ?? source;
      return h(
        "div",
        { class: "ed-source" },
        textField(edits, {
          key: `source:${source.id}:title`,
          label: "Source title",
          read: () => live().title,
          commit: (value) => update(source.id, (current) => ({ ...current, title: value })),
        }),
        textField(edits, {
          key: `source:${source.id}:url`,
          label: "Link",
          hint: "Starts with http:// or https://.",
          read: () => live().url ?? "",
          commit: (value) =>
            update(source.id, ({ url: _url, ...rest }) => (value === "" ? rest : { ...rest, url: value })),
        }),
        selectField(edits, {
          key: `source:${source.id}:asset`,
          label: "File in the deck",
          empty: "No file",
          options: assets(),
          read: () => live().asset ?? "",
          commit: (value) =>
            update(source.id, ({ asset: _asset, ...rest }) =>
              value === "" ? rest : { ...rest, asset: value },
            ),
        }),
        actionButton("Remove source", () => run(removeSource(scene(), source.id)), {
          class: "ed-danger",
          "data-field": `source-remove:${source.id}`,
        }),
      );
    });
    const addSource = () => {
      const source: Source = { id: uniqueId(`${s.id}-source`, idsInScene(scene())), title: "New source" };
      run([sceneSet({ sources: [...sources(), source] })]);
    };
    return section(
      "sources",
      "Sources",
      false,
      ...rows,
      actionButton("Add a source", addSource, { "data-field": "source:add" }),
    );
  }

  /** Redrawn from the document; the control that had focus is found again by its key. */
  function render() {
    const active = document.activeElement;
    const focusKey =
      active instanceof HTMLElement && element.contains(active) ? active.dataset.field : undefined;

    // Read the open state from the page itself: the `toggle` event arrives a moment after a click, and a redraw
    // that comes first would close the section that was just opened.
    for (const details of body.querySelectorAll<HTMLDetailsElement>("details[data-section]")) {
      const name = details.dataset.section as string;
      if (details.open !== drawn.get(name)) open.set(name, details.open);
    }
    report(undefined);
    const current = doc().scenes[host.scene()];
    if (!current) {
      body.replaceChildren();
      return;
    }
    if (host.block() !== lastBlock) {
      lastBlock = host.block();
      if (lastBlock !== undefined) open.set("block", true);
    }
    body.replaceChildren(
      ...[
        sceneSection(),
        claimSection(current),
        blocksSection(current),
        blockSection(current),
        stepsSection(current),
        sourcesSection(current),
        deckSection(),
      ].filter((part): part is HTMLDetailsElement => part !== undefined),
    );

    if (focusKey !== undefined) {
      const again = [...body.querySelectorAll<HTMLElement>("[data-field]")].find(
        (node) => node.dataset.field === focusKey,
      );
      again?.focus();
    }
  }

  return { element, render };
}
