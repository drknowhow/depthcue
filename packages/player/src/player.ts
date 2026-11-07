import type { Scene } from "@depthcue/core";
import { h } from "./dom.ts";
import { type PlayerSource, readDeckJson } from "./load.ts";
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
import { type RenderContext, renderScene } from "./scene.ts";
import { applyLook } from "./style.ts";
import { createVoice, type VoiceState } from "./voice.ts";

export type Mode = "present" | "read";

/** How long a finished recording rests before the deck moves on to the next scene. */
const END_BEAT_MS = 900;

/** How long the controls stay after the pointer last moved, while a scene is presented. */
const REST_MS = 2000;

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
  /** The voice-over started, paused, ended, or had its captions or its lead switched. */
  onVoice?: (state: VoiceState) => void;
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
  /** What the voice-over of the scene on screen is doing. `available` is false for a scene with none. */
  voiceState(): VoiceState;
  /** Pauses or plays the recording, switches the captions, or switches whether the voice leads. No-op without one. */
  voiceControl(action: "pause" | "captions" | "auto"): void;
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
  let endTimer: number | undefined;
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
  const key = (letter: string) => h("kbd", { class: "dc-shortcut", "aria-hidden": "true" }, letter);
  const readButton = button("read", "Reading view", h("span", {}, "Reading view"), key("R"));
  const notesButton = button("notes", "Speaker notes", h("span", {}, "Speaker notes"), key("N"));
  const overviewButton = button("overview", "All scenes", h("span", {}, "All scenes"), key("G"));
  // One small group for the voice-over: play or pause, captions, and whether the voice leads the deck.
  const pauseButton = button(
    "voice-pause",
    "Pause voice-over",
    h("span", { class: "dc-vi", "aria-hidden": "true" }),
  );
  const captionsButton = button("voice-captions", "Captions", h("span", {}, "Captions"), key("C"));
  const autoButton = button("voice-auto", "Voice leads the deck", h("span", {}, "Voice leads"), key("A"));
  captionsButton.setAttribute("aria-pressed", "false");
  autoButton.setAttribute("aria-pressed", "false");
  autoButton.title = "Auto: the voice starts each scene, moves its steps and moves on when it ends";
  // Play and pause stay in the bar; the rest of the voice-over's switches are in the More menu.
  const voiceGroup = h(
    "div",
    { class: "dc-voice", role: "group", "aria-label": "Voice-over", hidden: true },
    pauseButton,
  );
  // The switches a person reaches for now and then sit behind one button, so the bar keeps to moving the deck.
  const moreButton = button("more", "More", h("span", {}, "More"));
  moreButton.setAttribute("aria-haspopup", "true");
  moreButton.setAttribute("aria-expanded", "false");
  moreButton.setAttribute("aria-controls", "dc-more");
  const more = h(
    "div",
    { class: "dc-more", id: "dc-more", role: "group", "aria-label": "More", hidden: true },
    overviewButton,
    readButton,
    notesButton,
    captionsButton,
    autoButton,
  );
  const moreWrap = h("div", { class: "dc-more-wrap" }, moreButton, more);
  readButton.setAttribute("aria-pressed", "false");
  notesButton.setAttribute("aria-pressed", "false");
  notesButton.setAttribute("aria-controls", "dc-notes");
  const count = h("span", { class: "dc-count" });
  const title = h("span", { class: "dc-title" });
  const lead = h("span", { class: "dc-lead" });
  // Who the scene was written to be led by is the plan; who holds the deck now is the lease's chip, marked Live.
  const plan = h(
    "span",
    { class: "dc-plan", title: "Planned: who this scene is written to be led by" },
    h("span", { class: "dc-k" }, "Planned"),
    lead,
  );
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
    plan,
    voiceGroup,
    moreWrap,
  );
  // G shows every scene at once, to jump to one.
  const overviewList = h("ol", { class: "dc-overview-grid" });
  const overview = h(
    "div",
    {
      class: "dc-overview",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "dc-overview-title",
      hidden: true,
    },
    h("h2", { class: "dc-overview-title", id: "dc-overview-title" }, "All scenes"),
    overviewList,
  );
  // The caption sits at the foot of the slide, over the picture, so it reads on any layout.
  const captionBox = h("p", { class: "dc-captions", hidden: true });
  const voice = createVoice({
    onChange: () => {
      updateVoiceButton();
      options.onVoice?.(voice.state());
    },
    onCaption: (text) => {
      captionBox.textContent = text ?? "";
      captionBox.hidden = !text || mode !== "present";
    },
    // The recording passed a mark: the scene shows that step.
    onMark: (step) => {
      const to = Math.min(step, stepCount(current()));
      if (mode === "present" && to !== position.step)
        show({
          position: { scene: position.scene, step: to },
          transition: false,
          focus: false,
          history: "replace",
        });
    },
    // The recording ended: after a beat the next scene shows, and its own recording starts.
    onEnd: () => {
      if (endTimer !== undefined) clearTimeout(endTimer);
      const scene = position.scene;
      endTimer = window.setTimeout(() => {
        endTimer = undefined;
        const state = voice.state();
        if (mode !== "present" || position.scene !== scene || !state.ended || !state.auto) return;
        if (scene + 1 < source.scenes.length)
          show({ position: { scene: scene + 1, step: 0 }, transition: true, focus: false, history: "push" });
      }, END_BEAT_MS);
    },
  });
  // Shown over the slide when the browser held the sound back until something is pressed.
  const voiceStart = h(
    "button",
    { type: "button", class: "dc-voice-start", "data-action": "voice-start", hidden: true },
    h("span", { class: "dc-voice-start-icon", "aria-hidden": "true" }),
    "Play voice-over",
  );
  const deckTitle = h("h1", { class: "dc-sr-only" });
  const root = h(
    "div",
    { class: "dc-player" },
    deckTitle,
    h("div", { class: "dc-stage" }, view, voiceStart, captionBox),
    notesPanel,
    bar,
    overview,
    live,
  );
  host.replaceChildren(root);

  const modules = createModuleHost({
    registry: options.modules ?? [],
    deck: () => source.deck,
    assetBase: () => source.assetBase,
    readJson: (path) => readDeckJson(source, path),
    reducedMotion,
    announce: (message) => {
      live.textContent = message;
    },
    ...(options.onModule ? { onEvent: options.onModule } : {}),
  });
  const context = (): RenderContext => ({
    assetBase: source.assetBase,
    language: source.deck.language,
    ...(source.look ? { look: source.look } : {}),
    number: position.scene + 1,
    ...(source.deck.links ? { links: source.deck.links } : {}),
    scenes: source.scenes,
  });
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

  function updateVoiceButton() {
    const now = voice.state();
    voiceGroup.hidden = !now.available || mode !== "present";
    captionsButton.hidden = voiceGroup.hidden;
    autoButton.hidden = voiceGroup.hidden;
    captionsButton.setAttribute("aria-pressed", String(now.captions));
    autoButton.setAttribute("aria-pressed", String(now.auto));
    pauseButton.dataset.state = now.playing ? "playing" : "paused";
    pauseButton.setAttribute(
      "aria-label",
      now.playing ? "Pause voice-over" : now.ended ? "Replay voice-over" : "Play voice-over",
    );
    voiceStart.hidden = !voice.blocked || mode !== "present";
  }

  function updateChrome() {
    const scene = current();
    const total = source.scenes.length;
    const steps = stepCount(scene);
    applyLook(root, source.look ?? source.deck, source.assetBase);
    root.dataset.mode = mode;
    root.dataset.notes = notes && mode === "present" ? "open" : "closed";
    deckTitle.textContent = source.deck.title;
    count.textContent =
      steps > 0
        ? `${position.scene + 1} of ${total} · reveal ${position.step} of ${steps}`
        : `${position.scene + 1} of ${total}`;
    title.textContent = scene.title;
    const who = scene.lead ?? "human";
    lead.textContent = LEAD_LABEL[who];
    lead.dataset.lead = who;
    plan.setAttribute("aria-label", `Planned: ${LEAD_LABEL[who]}`);
    fill.style.setProperty("--p", String(progress(source.scenes, position)));
    previousButton.setAttribute("aria-disabled", String(previousPosition(source.scenes, position) === null));
    nextButton.setAttribute("aria-disabled", String(nextPosition(source.scenes, position) === null));
    readButton.setAttribute("aria-pressed", String(mode === "read"));
    notesButton.setAttribute("aria-pressed", String(notes));
    notesButton.setAttribute("aria-expanded", String(notes && mode === "present"));
    notesPanel.hidden = !(notes && mode === "present");
    notesBody.textContent = scene.notes ?? "No notes for this scene.";
    notesBody.classList.toggle("dc-empty", scene.notes === undefined);
    updateVoiceButton();
  }

  function renderView(focus: boolean) {
    modules.detach();
    if (endTimer !== undefined) clearTimeout(endTimer);
    endTimer = undefined;
    // The recording belongs to the scene being presented; the reading view is silent.
    voice.attach(mode === "present" ? current() : undefined, source.assetBase, (path) =>
      readDeckJson(source, path),
    );
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
      const transition = document.startViewTransition(render);
      // A key pressed before the animation ends skips it, and the browser rejects `ready` with an AbortError. The
      // scene has changed either way. A failure in `render` still shows, because it rejects the other promises.
      transition.ready?.catch(() => {});
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

  // The More menu: opened from its button, put away by a choice in it, by Escape or by a press anywhere else.
  function openMore() {
    more.hidden = false;
    moreButton.setAttribute("aria-expanded", "true");
    more.querySelector<HTMLElement>("button:not([hidden])")?.focus({ preventScroll: true });
    wake();
  }
  function closeMore(giveBack: boolean) {
    if (more.hidden) return;
    more.hidden = true;
    moreButton.setAttribute("aria-expanded", "false");
    if (giveBack) moreButton.focus({ preventScroll: true });
    wake();
  }

  // The overview: a card for each scene, the one on show marked, with the keyboard on it.
  let overviewFrom: Element | null = null;
  const cards = () => [...overviewList.querySelectorAll<HTMLButtonElement>("button")];
  function openOverview() {
    closeMore(false);
    overviewFrom = document.activeElement;
    overviewList.replaceChildren(
      ...source.scenes.map((scene, index) => {
        const who = scene.lead ?? "human";
        const card = h(
          "button",
          {
            type: "button",
            class: "dc-overview-card",
            "data-action": "overview-go",
            "data-scene": String(index),
            "aria-label": `Scene ${index + 1}: ${scene.title}, ${LEAD_LABEL[who]}`,
          },
          h("span", { class: "dc-overview-n" }, String(index + 1)),
          h("span", { class: "dc-overview-name" }, scene.title),
          h("span", { class: "dc-lead", "data-lead": who }, LEAD_LABEL[who]),
        );
        if (index === position.scene) card.setAttribute("aria-current", "true");
        return h("li", {}, card);
      }),
    );
    overview.hidden = false;
    root.dataset.overview = "open";
    cards()[position.scene]?.focus({ preventScroll: true });
  }
  function closeOverview(giveBack: boolean) {
    if (overview.hidden) return;
    overview.hidden = true;
    delete root.dataset.overview;
    const back = overviewFrom instanceof HTMLElement && overviewFrom.isConnected ? overviewFrom : null;
    overviewFrom = null;
    if (giveBack && back) back.focus({ preventScroll: true });
  }
  /** Moves the keyboard along the cards: by one sideways, by a row up and down, as the grid is laid out. */
  function moveInOverview(key: string): boolean {
    const all = cards();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return false;
    const top = (card: Element | undefined) => card?.getBoundingClientRect().top ?? 0;
    const columns = Math.max(1, all.filter((card) => top(card) === top(all[0])).length);
    const by =
      key === "ArrowRight"
        ? 1
        : key === "ArrowLeft"
          ? -1
          : key === "ArrowDown"
            ? columns
            : key === "ArrowUp"
              ? -columns
              : key === "Home"
                ? -at
                : key === "End"
                  ? all.length - 1 - at
                  : undefined;
    if (by === undefined) return false;
    all[Math.min(all.length - 1, Math.max(0, at + by))]?.focus({ preventScroll: true });
    return true;
  }

  // While a scene is presented the controls rest out of sight: a pointer move brings them for two seconds, and they
  // stay while the pointer is over them, the keyboard is in them or the More menu is open.
  let restTimer: number | undefined;
  let overBar = false;
  function rest() {
    restTimer = undefined;
    if (overBar || !more.hidden || bar.contains(document.activeElement)) return;
    root.dataset.chrome = "rest";
  }
  function wake() {
    root.dataset.chrome = "shown";
    if (restTimer !== undefined) clearTimeout(restTimer);
    restTimer = window.setTimeout(rest, REST_MS);
  }
  const onPointerMove = () => wake();
  const onBarEnter = () => {
    overBar = true;
    wake();
  };
  const onBarLeave = () => {
    overBar = false;
    wake();
  };
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Node ? event.target : null;
    if (!more.hidden && !(target && moreWrap.contains(target))) closeMore(false);
    if (!overview.hidden && target && !overviewList.contains(target)) closeOverview(true);
    wake();
  };

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
    voiceState: () => voice.state(),
    voiceControl(action) {
      if (!voice.available) return;
      if (action === "pause") voice.togglePause();
      else if (action === "captions") voice.captions = !voice.captions;
      else voice.auto = !voice.auto;
    },
    invoke: (blockId, command, args) => modules.invoke(blockId, command, args),
    settled: () => modules.settled(),
    moduleStates: () => modules.states(),
    destroy() {
      modules.detach();
      voice.dispose();
      if (endTimer !== undefined) clearTimeout(endTimer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      bar.removeEventListener("pointerenter", onBarEnter);
      bar.removeEventListener("pointerleave", onBarLeave);
      bar.removeEventListener("focusout", wake);
      if (restTimer !== undefined) clearTimeout(restTimer);
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
    // Over the deck, the overview and the More menu answer their own keys first.
    if (!overview.hidden) {
      if (event.key === "Escape" || event.key === "g") closeOverview(true);
      else if (!moveInOverview(event.key)) return;
      event.preventDefault();
      return;
    }
    if (!more.hidden && event.key === "Escape") {
      closeMore(true);
      event.preventDefault();
      return;
    }
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
        case "g":
          openOverview();
          break;
        case "p":
        case "c":
        case "a":
          if (voice.available)
            api.voiceControl(event.key === "p" ? "pause" : event.key === "c" ? "captions" : "auto");
          else handled = false;
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
    // A choice in the More menu puts the menu away, and the keyboard goes back to its button.
    if (more.contains(control)) closeMore(true);
    switch (control.dataset.action) {
      case "more":
        if (more.hidden) openMore();
        else closeMore(true);
        break;
      case "overview":
        openOverview();
        break;
      case "overview-go":
        closeOverview(false);
        api.go({ scene: Number(control.dataset.scene), step: 0 });
        break;
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
      case "voice-auto":
        api.voiceControl("auto");
        break;
      case "voice-pause":
        api.voiceControl("pause");
        break;
      case "voice-captions":
        api.voiceControl("captions");
        break;
      case "voice-start":
        voice.start();
        break;
    }
  }

  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  bar.addEventListener("pointerenter", onBarEnter);
  bar.addEventListener("pointerleave", onBarLeave);
  // Once the keyboard leaves the bar, the controls rest again after the usual time.
  bar.addEventListener("focusout", wake);
  wake();
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
