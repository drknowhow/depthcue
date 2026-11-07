import { h } from "@depthcue/player";

/** Where the choice to show or hide the inspector is kept, for this browser only. */
const KEY = "depthcue.editor.inspector";

export interface Inspector {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  /** Shows or hides the inspector, and remembers the choice. */
  toggle(): void;
  /** Says what the inspector is showing: the slide, or a kind of block. */
  title(text: string): void;
  destroy(): void;
}

const remembered = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(KEY) !== "closed";
  } catch {
    return true;
  }
};

export interface InspectorHooks {
  /** Runs while the popovers are still docked, just before the inspector is shown or hidden: put them away. */
  leaving(): void;
  /** Runs once it is shown or hidden: dock again what belongs in it. */
  changed(): void;
}

/**
 * The column on the right of a wide window that shows the properties of what is chosen: the slide's when nothing on it
 * is, a block's when one is. It holds no form of its own. The popovers of the scene chip and of the block's toolbar
 * are drawn in it by the stylesheet while it is open, and they stay where they are in the page, next to their chips,
 * so the keyboard and a screen reader meet them in the same order as before. `\` hides it and shows it again.
 */
export function createInspector(root: HTMLElement, hooks: InspectorHooks): Inspector {
  let open = remembered();
  const heading = h("h2", { class: "ed-inspector-title", id: "ed-inspector-title" }, "Slide");
  const hide = h("button", {
    type: "button",
    class: "ed-icon-button ed-icon-panel",
    "data-action": "inspector",
    "aria-controls": "ed-inspector",
  });
  hide.addEventListener("click", () => toggle());
  const element = h(
    "aside",
    { class: "ed-inspector", id: "ed-inspector", "aria-labelledby": "ed-inspector-title" },
    h("div", { class: "ed-inspector-head" }, heading, hide),
  );

  // The docked popovers are fixed to the window, so they are told where the inspector's body begins and ends.
  function measure() {
    const box = element.getBoundingClientRect();
    const head = element.firstElementChild?.getBoundingClientRect();
    root.style.setProperty("--ed-inspector-top", `${Math.round(head?.bottom ?? box.top)}px`);
    root.style.setProperty(
      "--ed-inspector-bottom",
      `${Math.max(0, Math.round(document.documentElement.clientHeight - box.bottom))}px`,
    );
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
  observer?.observe(element);
  observer?.observe(root);

  function paint() {
    root.dataset.inspector = open ? "open" : "closed";
    const words = open ? "Hide the inspector (\\)" : "Show the inspector (\\)";
    hide.setAttribute("aria-label", words);
    hide.title = words;
    hide.setAttribute("aria-expanded", String(open));
    measure();
  }

  function toggle() {
    hooks.leaving();
    open = !open;
    try {
      globalThis.localStorage?.setItem(KEY, open ? "open" : "closed");
    } catch {
      // A browser that keeps nothing still shows and hides it; it only forgets the choice.
    }
    paint();
    hooks.changed();
  }

  paint();
  return {
    element,
    get isOpen() {
      return open;
    },
    toggle,
    title(text) {
      if (heading.textContent !== text) heading.textContent = text;
    },
    destroy() {
      observer?.disconnect();
    },
  };
}
