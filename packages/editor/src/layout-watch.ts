import type { Found } from "./ribbon.ts";
import type { EditorStore } from "./store.ts";

export interface LayoutWatchHooks {
  /** The scene on show, which is checked before the others. */
  scene(): string;
  /** An answer came in that changes what `of` returns. */
  changed(): void;
}

export interface LayoutWatchOptions {
  /** Milliseconds the deck stays saved and unchanged before a scene is sent to be rendered. */
  quietMs?: number;
  /** Milliseconds to wait before asking again after the server could not render. */
  retryMs?: number;
}

export interface LayoutWatch {
  /** What a render found wrong with a scene when it was last checked, or nothing before the first answer. */
  of(sceneId: string): readonly Found[];
  destroy(): void;
}

/** Where in a scene a diagnostic is, as `blocks/2`, is turned into the id of the block it names. */
const blockAt = (at: string): number | undefined => {
  const index = /\/blocks\/(\d+)(?:\/|$)/.exec(at)?.[1];
  return index === undefined ? undefined : Number(index);
};

/**
 * Asks the server what a render of each scene shows is wrong with it, once the deck is saved and quiet, the scene on
 * show first. The server renders the files on disk, so an unsaved edit is not in the answer; the answer stays until
 * the next one replaces it, so a problem does not blink out and back in while someone types. A scene is asked about
 * again only when its own text, or the deck's settings, changed since the answer it has.
 */
export function createLayoutWatch(
  store: EditorStore,
  hooks: LayoutWatchHooks,
  options: LayoutWatchOptions = {},
): LayoutWatch {
  const quiet = options.quietMs ?? 800;
  const retry = options.retryMs ?? 30_000;
  const { session } = store;
  const found = new Map<string, readonly Found[]>();
  /** For each scene, the text that was on disk when its answer was asked for. */
  const asked = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let destroyed = false;
  let waitUntil = 0;

  const keyOf = (sceneId: string): string | undefined => {
    const scene = session.doc.scenes[sceneId];
    return scene === undefined ? undefined : JSON.stringify([{ ...session.doc.deck, scenes: [] }, scene]);
  };
  const due = (): string[] => {
    const shown = hooks.scene();
    const order = [shown, ...session.doc.deck.scenes.filter((id) => id !== shown)];
    return order.filter((id) => session.doc.scenes[id] !== undefined && asked.get(id) !== keyOf(id));
  };
  /** Only a saved deck is what the server would render. */
  const settled = () => store.status.save === "saved";

  function wake() {
    if (destroyed) return;
    clearTimeout(timer);
    timer = undefined;
    if (running || !settled() || due().length === 0) return;
    timer = setTimeout(() => void pump(), Math.max(quiet, waitUntil - Date.now()));
  }

  async function pump() {
    timer = undefined;
    if (running || destroyed) return;
    running = true;
    try {
      while (!destroyed && settled()) {
        const id = due()[0];
        if (id === undefined) return;
        const key = keyOf(id);
        const answer = await store.layoutApi.loadLayout(id);
        if (destroyed) return;
        if (!answer.available) {
          waitUntil = Date.now() + retry;
          return;
        }
        // An edit since the question was sent means the answer is about text that is no longer there.
        if (keyOf(id) !== key || !settled()) continue;
        const scene = session.doc.scenes[id];
        found.set(
          id,
          answer.diagnostics.map((diagnostic) => {
            const at = blockAt(diagnostic.at);
            return {
              code: diagnostic.code,
              message: diagnostic.message,
              block: at === undefined ? undefined : scene?.blocks[at]?.id,
            };
          }),
        );
        if (key !== undefined) asked.set(id, key);
        hooks.changed();
      }
    } finally {
      running = false;
      wake();
    }
  }

  const stop = store.subscribe(wake);
  wake();
  return {
    of: (sceneId) => found.get(sceneId) ?? [],
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      stop();
    },
  };
}
