import { adviceOf, type Diagnostic, type Op, type Scene, type Session, scenePath } from "@depthcue/core";
import { h } from "@depthcue/player";

/** One thing to look at on a slide, as the ribbon lists it. */
export interface Problem {
  /** The same from one draw to the next, so Next stays on the problem it was on while others come and go. */
  key: string;
  scene: string;
  /** The block it is about, which the slide can show. */
  block: string | undefined;
  /** What is wrong, as a sentence, as `depthcue check` words it. */
  text: string;
  /** The change that settles it, for the problems where that is the same every time. */
  fix: { label: string; ops: Op[] } | undefined;
}

/** A problem a render of the saved deck found on a scene, with the block it is about already named. */
export interface Found {
  code: string;
  message: string;
  block: string | undefined;
}

export interface RibbonHooks {
  /** The scene on show: a problem on another scene says which. */
  scene(): string;
  /** What a render found wrong with a scene when it was last checked. Without it the ribbon lists what the core finds. */
  found?(sceneId: string): readonly Found[];
  /** Takes the person to a problem: its scene, and its block chosen. `focus` also puts the keyboard in the block. */
  go(problem: Problem, focus: boolean): void;
  /** Applies the fix of a problem. */
  fix(problem: Problem): void;
}

export interface Ribbon {
  readonly element: HTMLElement;
  readonly problems: readonly Problem[];
  /** The problem on show, which Fix would settle if it has a fix. */
  readonly current: Problem | undefined;
  /** Brings the ribbon up to date with the deck and the scene on show. Changes text and visibility, never the controls. */
  render(): void;
  /** Takes the person to the next problem, or the one before it, as the buttons do. */
  step(by: 1 | -1): void;
  /** Applies the fix of the problem on show, if it has one. Returns false when it has none. */
  fixNext(): boolean;
  destroy(): void;
}

/**
 * The fixes that are the same every time, by the code of the problem. A problem with no entry here has no Fix button:
 * writing alt text or naming a source needs a person, and so does deciding whether a block belongs at the edge.
 * A frame that its content runs out of is put back in the template for the same reason a frame in the margin is.
 */
const BACK_TO_LAYOUT = {
  label: "Back to layout",
  ops: (scene: string, id: string): Op[] => [{ op: "block.unframe", scene, id }],
};
const FIXES: Record<string, { label: string; ops(scene: string, block: string): Op[] }> = {
  "frame-outside-safe-area": BACK_TO_LAYOUT,
  "frame-overflow": BACK_TO_LAYOUT,
};

/** What the checks say about a scene. A scene is replaced when it changes, so the answer is kept per scene object. */
const advice = new WeakMap<Scene, readonly Diagnostic[]>();
const adviceFor = (scene: Scene): readonly Diagnostic[] => {
  let found = advice.get(scene);
  if (found === undefined) {
    found = adviceOf(scene, scenePath(scene.id));
    advice.set(scene, found);
  }
  return found;
};

/**
 * Every problem in the deck, in the order of its scenes: what the core finds in the scene, then what a render found.
 * `found` is the render's answer for a scene, and a block it names that has since gone is not listed.
 */
export function problemsOf(session: Session, found?: (sceneId: string) => readonly Found[]): Problem[] {
  const out: Problem[] = [];
  const seen = new Map<string, number>();
  const add = (sceneId: string, code: string, block: string | undefined, text: string) => {
    const key = `${sceneId}/${block ?? ""}/${code}`;
    // Two problems of one kind on one block, such as a picture overlapped by two others, need names of their own.
    const again = seen.get(key) ?? 0;
    seen.set(key, again + 1);
    const fixer = block === undefined ? undefined : FIXES[code];
    out.push({
      key: again === 0 ? key : `${key}#${again}`,
      scene: sceneId,
      block,
      text,
      fix: fixer && block !== undefined ? { label: fixer.label, ops: fixer.ops(sceneId, block) } : undefined,
    });
  };
  for (const sceneId of session.doc.deck.scenes) {
    const scene = session.doc.scenes[sceneId];
    if (!scene) continue;
    for (const diagnostic of adviceFor(scene)) {
      const at = /^\/blocks\/(\d+)/.exec(diagnostic.path)?.[1];
      add(
        sceneId,
        diagnostic.code,
        at === undefined ? undefined : scene.blocks[Number(at)]?.id,
        diagnostic.message,
      );
    }
    for (const item of found?.(sceneId) ?? []) {
      if (item.block !== undefined && !scene.blocks.some((block) => block.id === item.block)) continue;
      add(sceneId, item.code, item.block, item.message);
    }
  }
  return out;
}

/** How many problems each scene has, from the list the ribbon walks. */
export function checksByScene(problems: readonly Problem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const problem of problems) counts.set(problem.scene, (counts.get(problem.scene) ?? 0) + 1);
  return counts;
}

const plural = (count: number) => (count === 1 ? "1 thing to check" : `${count} things to check`);

/** Writes only when the text changed, so a screen reader is not told the same thing twice. */
const setText = (node: HTMLElement, text: string) => {
  if (node.textContent !== text) node.textContent = text;
};

/**
 * The strip under the top bar that says what is wrong with the deck, one problem at a time, with Previous and Next to
 * walk them and a Fix button where one change settles it. It takes its rules from the core, which also gives them to
 * `depthcue check`, so it has none of its own. It is always there, so a problem that appears moves nothing.
 */
export function createRibbon(session: Session, hooks: RibbonHooks): Ribbon {
  const dot = h("span", { class: "ed-ribbon-dot", "aria-hidden": "true" });
  const count = h("b", { class: "ed-ribbon-count" });
  const place = h("span", { class: "ed-ribbon-place" });
  const previous = h(
    "button",
    { type: "button", "aria-label": "Previous problem", "data-ribbon": "previous" },
    "‹",
  );
  const next = h("button", { type: "button", "aria-label": "Next problem", "data-ribbon": "next" }, "›");
  const nav = h(
    "span",
    { class: "ed-ribbon-nav", role: "group", "aria-label": "Problems" },
    previous,
    place,
    next,
  );
  const show = h("button", { type: "button", class: "ed-ribbon-text", "data-ribbon": "show" });
  const fix = h("button", { type: "button", class: "ed-ribbon-fix", "data-ribbon": "fix" });
  // What a screen reader hears. The strip itself is not a live region, because its buttons are in it.
  const say = h("span", { class: "ed-sr-only", role: "status", "aria-live": "polite" });
  const element = h("div", { class: "ed-ribbon", "data-state": "clear" }, dot, count, nav, show, fix, say);

  let problems: Problem[] = [];
  let at = 0;

  const current = () => problems[at];

  function paint() {
    const problem = current();
    element.dataset.state = problem === undefined ? "clear" : "problems";
    setText(count, problem === undefined ? "All clear" : plural(problems.length));
    nav.hidden = problems.length < 2;
    previous.disabled = problems.length < 2;
    next.disabled = problems.length < 2;
    setText(place, problem === undefined ? "" : `${at + 1} of ${problems.length}`);
    show.hidden = problem === undefined;
    fix.hidden = problem?.fix === undefined;
    if (problem === undefined) {
      setText(show, "");
      show.title = "";
      setText(fix, "");
      setText(say, "All clear. Nothing to check on any slide.");
      return;
    }
    const title = session.doc.scenes[problem.scene]?.title;
    const where = problem.scene === hooks.scene() || title === undefined ? "" : `${title}: `;
    setText(show, `${where}${problem.text}`);
    // On a wide window the sentence is one line, cut short with an ellipsis when it is long, so the whole of it is here.
    show.title = show.textContent ?? "";
    if (problem.fix) setText(fix, problem.fix.label);
    setText(say, `${plural(problems.length)}. ${at + 1} of ${problems.length}. ${where}${problem.text}`);
  }

  function render() {
    const stayOn = current()?.key;
    problems = problemsOf(session, hooks.found);
    const same = stayOn === undefined ? -1 : problems.findIndex((problem) => problem.key === stayOn);
    at = same >= 0 ? same : Math.min(at, Math.max(problems.length - 1, 0));
    paint();
  }

  function step(by: 1 | -1) {
    if (problems.length < 2) return;
    at = (at + by + problems.length) % problems.length;
    paint();
    const problem = current();
    if (problem) hooks.go(problem, false);
  }

  function fixNext() {
    const problem = current();
    if (!problem?.fix) return false;
    hooks.fix(problem);
    return true;
  }

  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  show.addEventListener("click", () => {
    const problem = current();
    if (problem) hooks.go(problem, true);
  });
  fix.addEventListener("click", () => void fixNext());

  render();
  return {
    element,
    get problems() {
      return problems;
    },
    get current() {
      return problems[at];
    },
    render,
    step,
    fixNext,
    destroy() {
      element.remove();
    },
  };
}
