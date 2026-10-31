import type { Scene } from "@depthcue/core";
import { h } from "./dom.ts";
import type { PlayerSource } from "./load.ts";
import {
  clampPosition,
  formatRoute,
  LEAD_LABEL,
  nextPosition,
  type Position,
  parseRoute,
  previousPosition,
  progress,
  revealedIds,
  samePosition,
  stepCount,
} from "./model.ts";
import { createModuleHost, type ModuleEvent, type ModuleRegistry, type ModuleState } from "./modules.ts";
import { renderReading } from "./reading.ts";
import { assetUrl } from "./safe.ts";
import { renderScene } from "./scene.ts";

export type Mode = "present" | "read";

export interface PlayerState {
  mode: Mode;
  position: Position;
  notes: boolean;
}

export interface PlayerOptions {
  /** Keep the address bar's hash in step with the scene, so a link opens at the same place. Default true. */
  hash?: boolean;
  /** Force reduced motion on or off. Default: follow the visitor's setting. */
  reducedMotion?: boolean;
  onChange?: (state: PlayerState) => void;
  /** Modules that may make blocks interactive once they show. Default none: every block stays static. */
  modules?: ModuleRegistry;
  onModule?: (event: ModuleEvent) => void;
}

export interface Player {
  readonly state: PlayerState;
  /** Shows the next step or scene. False when already at the end. */
  next(): boolean;
  previous(): boolean;
  go(position: Position): void;
  setMode(mode: Mode): void;
  toggleNotes(): void;
  /** Swaps in changed deck content and keeps the place by scene id. For live reload and the editor. */
  update(source: PlayerSource): void;
  /** Runs a command on a block's module, such as `highlight` on a chart. False when it did not run. */
  invoke(blockId: string, command: string, args?: unknown): boolean;
  /** Resolves once the modules that are in view have hydrated or failed. */
  settled(): Promise<void>;
  /** Where each block's module stands: pending, hydrated, failed, off or incompatible. */
  moduleStates(): Readonly<Record<string, ModuleState>>;
  destroy(): void;
}

function button(action: string, label: string, ...children: Array<Node | string>): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: "dc-btn", "data-action": action, "aria-label": label },
    ...children,
  );
}

const icon = (name: string) => h("span", { class: `dc-icon dc-icon-${name}`, "aria-hidden": "true" });

export function mountPlayer(host: HTMLElement, initial: PlayerSource, options: PlayerOptions = {}): Player {
  let source = initial;
  let mode: Mode = "present";
  let position: Position = { scene: 0, step: 0 };
  let notes = false;
  let idleHandle: number | undefined;
  const prefetched = new Set<string>();
  const motion =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
  const reducedMotion = () => options.reducedMotion ?? motion?.matches ?? false;

  const view = h("div", { class: "dc-view" });
  const notesBody = h("p", { class: "dc-notes-body" });
  const notesPanel = h(
    "aside",
    { class: "dc-notes", id: "dc-notes", "aria-label": "Speaker notes", hidden: true },
    h("p", { class: "dc-label" }, "Notes"),
    notesBody,
  );
  const live = h("div", { class: "dc-sr-only", "aria-live": "polite", "aria-atomic": "true" });
  const previousButton = button("previous", "Previous", icon("previous"));
  const nextButton = button("next", "Next", icon("next"));
  const readButton = button("read", "Reading view", h("span", {}, "Read"));
  const notesButton = button("notes", "Speaker notes", h("span", {}, "Notes"));
  readButton.setAttribute("aria-pressed", "false");
  notesButton.setAttribute("aria-pressed", "false");
  notesButton.setAttribute("aria-controls", "dc-notes");
  const count = h("span", { class: "dc-count" });
  const title = h("span", { class: "dc-title" });
  const lead = h("span", { class: "dc-lead" });
  const fill = h("span", { class: "dc-fill" });
  const bar = h(
    "nav",
    { class: "dc-controls", "aria-label": "Deck controls" },
    h("div", { class: "dc-meter", "aria-hidden": "true" }, fill),
    previousButton,
    count,
    nextButton,
    h("span", { class: "dc-cue", "aria-hidden": "true" }),
    title,
    lead,
    readButton,
    notesButton,
  );
  const deckTitle = h("h1", { class: "dc-sr-only" });
  const root = h(
    "div",
    { class: "dc-player" },
    deckTitle,
    h("div", { class: "dc-stage" }, view),
    notesPanel,
    bar,
    live,
  );
  host.replaceChildren(root);

  const modules = createModuleHost({
    registry: options.modules ?? [],
    deck: () => source.deck,
    assetBase: () => source.assetBase,
    reducedMotion,
    announce: (message) => {
      live.textContent = message;
    },
    ...(options.onModule ? { onEvent: options.onModule } : {}),
  });
  const context = () => ({ assetBase: source.assetBase });
  const current = (): Scene => source.scenes[position.scene] as Scene;

  function applySteps() {
    const shown = revealedIds(current(), position.step);
    for (const node of view.querySelectorAll<HTMLElement>("[data-gated]")) {
      node.dataset.revealed = shown.has(node.dataset.id ?? "") ? "true" : "false";
    }
  }

  function prefetchNext() {
    const upcoming = source.scenes[position.scene + 1];
    if (!upcoming) return;
    const urls = upcoming.blocks.flatMap((block) =>
      block.type === "image"
        ? [assetUrl(source.assetBase, block.asset)]
        : block.type === "clip" && block.poster
          ? [assetUrl(source.assetBase, block.poster)]
          : [],
    );
    const fetchAll = () => {
      for (const url of urls) {
        if (url && !prefetched.has(url)) {
          prefetched.add(url);
          new Image().src = url;
        }
      }
    };
    if (idleHandle !== undefined) clearTimeout(idleHandle);
    idleHandle = window.setTimeout(fetchAll, 250);
  }

  function updateChrome() {
    const scene = current();
    const total = source.scenes.length;
    const steps = stepCount(scene);
    root.dataset.theme = source.deck.theme;
    root.dataset.mode = mode;
    root.dataset.notes = notes && mode === "present" ? "open" : "closed";
    deckTitle.textContent = source.deck.title;
    count.textContent =
      steps > 0
        ? `${position.scene + 1} / ${total} · ${position.step}/${steps}`
        : `${position.scene + 1} / ${total}`;
    title.textContent = scene.title;
    const who = scene.lead ?? "human";
    lead.textContent = LEAD_LABEL[who];
    lead.dataset.lead = who;
    fill.style.setProperty("--p", String(progress(source.scenes, position)));
    previousButton.setAttribute("aria-disabled", String(previousPosition(source.scenes, position) === null));
    nextButton.setAttribute("aria-disabled", String(nextPosition(source.scenes, position) === null));
    readButton.setAttribute("aria-pressed", String(mode === "read"));
    notesButton.setAttribute("aria-pressed", String(notes));
    notesButton.setAttribute("aria-expanded", String(notes && mode === "present"));
    notesPanel.hidden = !(notes && mode === "present");
    notesBody.textContent = scene.notes ?? "No notes for this scene.";
    notesBody.classList.toggle("dc-empty", scene.notes === undefined);
  }

  function renderView(focus: boolean) {
    modules.detach();
    view.replaceChildren(
      mode === "read"
        ? renderReading(source.deck, source.scenes, context())
        : renderScene(current(), context()),
    );
    if (mode === "present") {
      applySteps();
      // The reading view is one long page of static content; only a scene being presented gets modules.
      modules.attach(view, current());
    }
    updateChrome();
    if (focus) {
      const target = view.firstElementChild as HTMLElement | null;
      const active = document.activeElement;
      if (target && (!active || active === document.body || view.contains(active)))
        target.focus({ preventScroll: true });
    }
    if (mode === "present") prefetchNext();
  }

  function swap(render: () => void, direction: number) {
    if (!reducedMotion() && typeof document.startViewTransition === "function") {
      document.documentElement.dataset.dcDirection = direction < 0 ? "back" : "forward";
      document.startViewTransition(render);
    } else {
      render();
    }
  }

  function announce() {
    const scene = current();
    const steps = stepCount(scene);
    live.textContent =
      mode === "read"
        ? "Reading view"
        : `Scene ${position.scene + 1} of ${source.scenes.length}: ${scene.title}${steps > 0 ? `, step ${position.step} of ${steps}` : ""}`;
  }

  function syncHash(push: boolean) {
    if (options.hash === false) return;
    const hash = formatRoute(source.scenes, mode === "read" ? { kind: "read" } : { kind: "scene", position });
    if (location.hash === hash) return;
    history[push ? "pushState" : "replaceState"](null, "", hash);
  }

  interface Show {
    position?: Position;
    mode?: Mode;
    transition: boolean;
    focus: boolean;
    history: "push" | "replace" | "none";
  }

  function show(change: Show) {
    const before = { position, mode };
    position = clampPosition(source.scenes, change.position ?? position);
    mode = change.mode ?? mode;
    const sceneChanged = position.scene !== before.position.scene || mode !== before.mode;
    const render = () => renderView(change.focus);
    if (sceneChanged) {
      if (change.transition) swap(render, position.scene - before.position.scene);
      else render();
    } else {
      applySteps();
      updateChrome();
    }
    announce();
    if (change.history !== "none") syncHash(change.history === "push" && sceneChanged);
    options.onChange?.(state());
  }

  const state = (): PlayerState => ({ mode, position: { ...position }, notes });

  const api: Player = {
    get state() {
      return state();
    },
    next() {
      const to = nextPosition(source.scenes, position);
      if (!to || mode !== "present") return false;
      show({ position: to, transition: true, focus: true, history: "push" });
      return true;
    },
    previous() {
      const to = previousPosition(source.scenes, position);
      if (!to || mode !== "present") return false;
      show({ position: to, transition: true, focus: true, history: "push" });
      return true;
    },
    go(to) {
      show({ position: to, mode: "present", transition: true, focus: true, history: "push" });
    },
    setMode(next) {
      if (next !== mode) show({ mode: next, transition: true, focus: true, history: "push" });
    },
    toggleNotes() {
      notes = !notes;
      updateChrome();
      options.onChange?.(state());
    },
    update(next) {
      const id = current().id;
      source = next;
      const found = next.scenes.findIndex((scene) => scene.id === id);
      position = clampPosition(next.scenes, {
        scene: found >= 0 ? found : position.scene,
        step: position.step,
      });
      renderView(false);
      options.onChange?.(state());
    },
    invoke: (blockId, command, args) => modules.invoke(blockId, command, args),
    settled: () => modules.settled(),
    moduleStates: () => modules.states(),
    destroy() {
      modules.detach();
      document.removeEventListener("keydown", onKey);
      removeEventListener("hashchange", onHash);
      removeEventListener("popstate", onHash);
      root.removeEventListener("click", onClick);
      if (idleHandle !== undefined) clearTimeout(idleHandle);
      host.replaceChildren();
    },
  };

  function onKey(event: KeyboardEvent) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    const onVideo = target?.tagName === "VIDEO";
    const onControl = Boolean(target?.closest("button, a, summary"));
    let handled = true;
    if (mode === "read") {
      if (event.key === "r" || event.key === "Escape") api.setMode("present");
      else if (event.key === "n") api.toggleNotes();
      else handled = false;
    } else {
      switch (event.key) {
        case "ArrowRight":
        case "PageDown":
          if (onVideo) handled = false;
          else api.next();
          break;
        case "ArrowLeft":
        case "PageUp":
          if (onVideo) handled = false;
          else api.previous();
          break;
        case " ":
        case "Enter":
          if (onControl || onVideo) handled = false;
          else if (event.shiftKey) api.previous();
          else api.next();
          break;
        case "Home":
          api.go({ scene: 0, step: 0 });
          break;
        case "End":
          api.go({ scene: source.scenes.length - 1, step: 0 });
          break;
        case "r":
          api.setMode("read");
          break;
        case "n":
          api.toggleNotes();
          break;
        default:
          handled = false;
      }
    }
    if (handled) event.preventDefault();
  }

  function onHash() {
    const route = parseRoute(source.scenes, location.hash);
    if (!route) return;
    if (route.kind === "read") {
      if (mode !== "read") show({ mode: "read", transition: true, focus: false, history: "none" });
    } else if (mode !== "present" || !samePosition(route.position, position)) {
      show({ position: route.position, mode: "present", transition: true, focus: false, history: "none" });
    }
  }

  function onClick(event: MouseEvent) {
    const control =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    if (!control || control.getAttribute("aria-disabled") === "true") return;
    switch (control.dataset.action) {
      case "next":
        api.next();
        break;
      case "previous":
        api.previous();
        break;
      case "read":
        api.setMode(mode === "read" ? "present" : "read");
        break;
      case "notes":
        api.toggleNotes();
        break;
    }
  }

  document.addEventListener("keydown", onKey);
  addEventListener("hashchange", onHash);
  addEventListener("popstate", onHash);
  root.addEventListener("click", onClick);

  const start = options.hash === false ? null : parseRoute(source.scenes, location.hash);
  if (start?.kind === "read") {
    mode = "read";
  } else if (start) {
    position = start.position;
  }
  renderView(false);
  announce();
  syncHash(false);
  return api;
}
