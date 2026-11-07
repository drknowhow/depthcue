import type { Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import { popoverChip } from "./chip.ts";
import { actionButton, type Edits, fileButton } from "./fields.ts";
import { type Panel, panelHost } from "./panels.ts";
import { createScriptDrawer, type ScriptDrawer } from "./scriptdrawer.ts";
import { keyName } from "./shortcuts.ts";
import { BLOCK_KINDS, IMAGE_ACCEPT, type NewBlockKind } from "./templates.ts";

export interface QuickBarHooks {
  /** How the notes change the deck: `type` for a keystroke. */
  edits: Edits;
  /** Says why a change was refused, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Stores a file in the deck and answers with its path. Rejects with a message the person can read. */
  upload(file: File): Promise<string>;
  /** Adds a block of a kind where the chosen block is, or in the first free area. An image comes with its file. */
  add(kind: NewBlockKind, file?: File): void;
  /** The Image button or the I key was pressed: opens the image library and answers true when the deck has pictures. */
  library?(): boolean;
  /** Makes the voice-over audio of a scene; see `EditorStore.buildVoice`. */
  voice?: Parameters<typeof panelHost>[1]["voice"];
  /** The script drawer opened: another drawer over the same place should close. */
  scriptOpened?(): void;
  /** Gives the slide a claim. */
  claim(): void;
  /** Whether the deck has a video a clip could play. */
  hasVideo(): boolean;
  /** The Build order button was pressed: show the badges on the slide, or put them away. */
  build?(on: boolean): void;
  /** The Comment button was pressed: start the tool that comments on a block, or stop it. */
  comment?(): void;
  /** The ? button was pressed: show the list of keyboard shortcuts. */
  keys(): void;
  /** The Everything button was pressed: open the palette that finds anything to do. */
  palette(): void;
}

export interface QuickBar {
  readonly element: HTMLElement;
  /** The drawer with the notes and the voice-over, which sits in the stage beside the bar and is shown from it. */
  readonly drawer: HTMLElement;
  /** Puts the drawer away, as another drawer over the same place opens. */
  closeScript(): void;
  /** Opens the drawer, or closes it when it is open. */
  toggleScript(): void;
  /** Opens the file chooser that adds an image, as the Image button does. */
  pickImage(): void;
  /** Gives the keyboard back to the bar after the image library closes: to the Insert button. */
  focusImage(): void;
  /** Shows whether the Comment tool is on, which the M key and Escape change without the button. */
  setCommenting(on: boolean): void;
  /** Brings the bar up to date with the scene being edited. `typing` is true while a keystroke in the notes is applied. */
  render(sceneId: string, typing?: boolean): void;
  destroy(): void;
}

/** The order the bar lists the kinds in. A kind that is not here comes last, so a new one still gets a button. */
const ORDER: readonly NewBlockKind[] = ["text", "chart", "table", "image", "clip"];
const rank = (kind: NewBlockKind) => {
  const at = ORDER.indexOf(kind);
  return at < 0 ? ORDER.length : at;
};

/** The key that adds a kind, written on its button. The shortcut itself is in `shortcuts.ts`. */
const KEYS: Partial<Record<NewBlockKind, string>> = { text: "T", chart: "C", image: "I" };

/** Writes a key on a button for the eye. Assistive technology gets it from `aria-keyshortcuts` instead. */
const withKey = <T extends HTMLElement>(
  control: T,
  key: string | undefined,
  target: HTMLElement = control,
): T => {
  if (key === undefined) return control;
  target.setAttribute("aria-keyshortcuts", key);
  control.append(h("kbd", { class: "ed-kbd", "aria-hidden": "true" }, key));
  return control;
};

/**
 * The bar that floats at the foot of the stage: one Insert menu with a block of each kind and the claim, then the
 * scene's notes and the ways of looking at the slide. Where a new block goes is the adder's business, so the menu and
 * the empty places on the slide agree. T, C and I still add without opening the menu.
 */
export function createQuickBar(session: Session, hooks: QuickBarHooks): QuickBar {
  let current = session.doc.deck.scenes[0] as string;
  const scene = () => session.doc.scenes[current];

  const clip = actionButton("Clip", () => hooks.add("clip"), { "data-quick": "clip" });
  const claim = actionButton("Claim", () => hooks.claim(), { "data-quick": "claim" });

  let imageInput: HTMLInputElement | undefined;
  const adders = [...BLOCK_KINDS]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(({ kind, label }) => {
      if (kind === "clip") return clip;
      if (kind === "image") {
        const picker = fileButton(label, IMAGE_ACCEPT, "quick:image", (file) => hooks.add("image", file));
        const input = picker.querySelector("input") as HTMLInputElement;
        imageInput = input;
        // A deck with pictures opens the library first; one without goes straight to the file chooser.
        input.addEventListener("click", (event) => {
          if (hooks.library?.()) event.preventDefault();
        });
        // The key goes on the input, which is what the keyboard reaches, and is drawn beside the label.
        return withKey(picker, KEYS.image, input);
      }
      return withKey(
        actionButton(label, () => hooks.add(kind), { "data-quick": kind }),
        KEYS[kind],
      );
    });

  // The kinds of block are one menu, so the bar stays one short row in any window. It opens upward, over the stage.
  const insertBody = h("div", { class: "ed-insert" }, ...adders, claim);
  const insertPanel: Panel = {
    name: "insert",
    label: "Insert",
    title: "Insert a block on this slide",
    body: insertBody,
    fill() {},
  };
  const insert = popoverChip(insertPanel, true);
  insert.chip.button.setAttribute("data-quick", "insert");
  insert.chip.button.setAttribute("aria-haspopup", "true");
  insert.chip.pop.classList.add("ed-insert-pop");
  // Choosing a kind puts the menu away: the new block takes the keyboard, or the file chooser does.
  insertBody.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button:not(:disabled), label"))
      insert.close();
  });

  const host = panelHost(session, {
    edits: hooks.edits,
    upload: hooks.upload,
    problem: hooks.problem,
    close: () => drawer?.close(),
    openSources: () => {},
    ...(hooks.voice ? { voice: hooks.voice } : {}),
  });
  // The words that go with the slide open in a drawer beside it, from this button.
  let drawer: ScriptDrawer | undefined;
  const badge = h("span", { class: "ed-tb-n" });
  const scriptButton = h(
    "button",
    {
      type: "button",
      class: "ed-tb-chip",
      "data-tb": "notes",
      "aria-label": "Script: speaker notes, reading version and voice-over",
      "aria-expanded": "false",
      "aria-controls": "ed-script",
    },
    "Script",
    badge,
  );
  scriptButton.addEventListener("click", () => drawer?.toggle());
  drawer = createScriptDrawer(host, () => current, {
    opened() {
      scriptButton.setAttribute("aria-expanded", "true");
      hooks.scriptOpened?.();
    },
    closed(giveBack) {
      scriptButton.setAttribute("aria-expanded", "false");
      if (giveBack) scriptButton.focus({ preventScroll: true });
    },
  });

  // Build order is a view of the slide and not an addition to it, so it sits apart from the row of things to add.
  const order = actionButton(
    "Build order",
    () => {
      const on = order.getAttribute("aria-pressed") !== "true";
      order.setAttribute("aria-pressed", String(on));
      hooks.build?.(on);
    },
    { "data-quick": "build", "aria-pressed": "false", class: "ed-quick-build" },
  );

  // Comments are about the slide and not on it, so the tool sits with the other ways of looking at it.
  const comment = withKey(
    actionButton("Comment", () => hooks.comment?.(), {
      "data-quick": "comment",
      "aria-pressed": "false",
      title: "Comment on a block: click it and write",
    }),
    "M",
  );

  // Everything and the keys sit at the far end: ways to find things, and not things to add.
  const everything = actionButton("Everything", () => hooks.palette(), {
    "data-quick": "palette",
    "aria-keyshortcuts": "Control+K Meta+K",
    title: `Find anything to do (${keyName("Mod")} K)`,
  });
  const keys = actionButton("?", () => hooks.keys(), {
    "data-quick": "keys",
    "aria-label": "Keyboard shortcuts",
    "aria-keyshortcuts": "?",
    title: "Keyboard shortcuts",
  });

  const element = h(
    "div",
    { class: "ed-quick", role: "group", "aria-label": "Add to this slide" },
    insert.chip.wrap,
    h("span", { class: "ed-quick-rule", "aria-hidden": "true" }),
    scriptButton,
    order,
    comment,
    everything,
    keys,
  );

  return {
    element,
    pickImage: () => imageInput?.click(),
    focusImage: () => insert.chip.button.focus({ preventScroll: true }),
    setCommenting: (on) => comment.setAttribute("aria-pressed", String(on)),
    drawer: drawer.element,
    closeScript: () => drawer?.close(),
    toggleScript: () => drawer?.toggle(),
    destroy() {
      insert.destroy();
    },
    render(sceneId, typing = false) {
      current = sceneId;
      const live = scene();
      if (!live) return;
      drawer?.fill(live, typing);
      const state = drawer?.state(live);
      badge.textContent = state?.badge ?? "";
      scriptButton.setAttribute("aria-label", state?.title ?? "Script");
      const hasVideo = hooks.hasVideo();
      clip.disabled = !hasVideo;
      clip.title = hasVideo ? "" : "Put an .mp4 or .webm file in the deck's assets folder first.";
      claim.disabled = live.summary !== undefined;
      claim.title = live.summary ? "This scene already has a claim." : "";
    },
  };
}
