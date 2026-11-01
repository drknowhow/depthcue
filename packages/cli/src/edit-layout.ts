import type { Diagnostic } from "@depthcue/core";
import type { Renderer } from "./render.ts";

/** What the editor is told about one scene. `available: false` means no render could be made, and says why. */
export type LayoutAnswer =
  | { available: true; diagnostics: Diagnostic[] }
  | { available: false; message: string };

export interface LayoutChecker {
  /** The layout problems of one scene as `depthcue render` finds them, from the files on disk. */
  check(scene: string): Promise<LayoutAnswer>;
  close(): Promise<void>;
}

export interface LayoutCheckerOptions {
  /** Starts the browser and the private player. Tests give a stand-in. */
  open?: (folder: string) => Promise<Renderer>;
  /** Milliseconds with nothing to check before the browser is closed. */
  idleMs?: number;
  /** Milliseconds to leave a machine with no browser alone before trying again. */
  retryMs?: number;
}

/** `render.ts` starts a server of its own, so it is loaded when first needed instead of when this file is. */
const openRendererLater = async (folder: string): Promise<Renderer> =>
  (await import("./render.ts")).openRenderer(folder);

/**
 * Renders a scene from the files on disk, with the same browser and the same rules as `depthcue render`, so the editor
 * says what the audience would see and nothing else. The browser is started by the first question, answers one at a
 * time, and is closed after a quiet spell, so an editor nobody is changing holds no browser.
 */
export function createLayoutChecker(folder: string, options: LayoutCheckerOptions = {}): LayoutChecker {
  const open = options.open ?? openRendererLater;
  const idleMs = options.idleMs ?? 30_000;
  const retryMs = options.retryMs ?? 60_000;
  let renderer: Promise<Renderer> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let noBrowser: { message: string; until: number } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  async function shutDown() {
    const held = renderer;
    renderer = undefined;
    if (held) await held.then((browser) => browser.close()).catch(() => undefined);
  }

  const rest = () => {
    clearTimeout(idle);
    if (closed) return;
    idle = setTimeout(() => void shutDown(), idleMs);
    idle.unref();
  };

  async function run(scene: string): Promise<LayoutAnswer> {
    if (closed) return { available: false, message: "The editor is shutting down." };
    if (noBrowser && Date.now() < noBrowser.until) return { available: false, message: noBrowser.message };
    clearTimeout(idle);
    try {
      let browser: Renderer;
      try {
        renderer ??= open(folder);
        browser = await renderer;
      } catch (error) {
        renderer = undefined;
        noBrowser = { message: (error as Error).message, until: Date.now() + retryMs };
        return { available: false, message: noBrowser.message };
      }
      try {
        const render = await browser.render(scene, { screenshot: false });
        return { available: true, diagnostics: render.diagnostics };
      } catch (error) {
        // The browser may be the thing that failed, so the next question starts a fresh one.
        await shutDown();
        return { available: false, message: (error as Error).message };
      }
    } finally {
      rest();
    }
  }

  return {
    check(scene) {
      const answer = queue.then(() => run(scene));
      queue = answer.catch(() => undefined);
      return answer;
    },
    async close() {
      closed = true;
      clearTimeout(idle);
      await queue;
      await shutDown();
    },
  };
}
