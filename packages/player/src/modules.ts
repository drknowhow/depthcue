import type { Block, BlockType, Deck, Scene } from "@depthcue/core";

/**
 * What a module tells the player before any of its code loads. The player reads it to decide which blocks to
 * watch, whether the deck allows the module, and what it may cost.
 */
export interface ModuleManifest {
  /** The key a deck uses in `deck.modules`. */
  id: string;
  /** What a person sees in the editor: a few words naming what it adds. */
  title: string;
  /** Major and minor, such as "1.0". A deck that needs a newer minor or another major leaves it off. */
  version: string;
  /** The block types the module makes interactive. Their static form stays on the page until it hydrates. */
  blocks: readonly BlockType[];
  /** `visible` waits until the block scrolls into view; `idle` uses spare time after the scene shows. */
  activation: "visible" | "idle";
  /** Brotli bytes of script the module may cost. `budgets.json` checks it, so there is no silent exemption. */
  budgetBytes: number;
  /** What an export keeps. Only the static form exists today. */
  export: "static";
  /** Actions a person or an agent holding the lease may run, each with a line saying what it takes. */
  commands: Readonly<Record<string, string>>;
}

export interface HydrateContext {
  block: Block;
  /** The block's static element, already in the page. Hydrating adds to it; it is never the only copy. */
  node: HTMLElement;
  scene: Scene;
  deck: Deck;
  assetBase: string;
  reducedMotion: boolean;
  /** Says something to screen readers through the player's polite live region. */
  announce(message: string): void;
}

/** What hydrating returns: the module's commands and how to put the page back. */
export interface ModuleInstance {
  commands?: Readonly<Record<string, (args: unknown) => void>>;
  dispose?(): void;
}

/** The part of a module that loads late. */
export interface ModuleCode {
  /**
   * Makes the block interactive. If it throws, the player puts the static element back, so a failing module
   * must still clean up anything it added outside `node`, such as listeners on the document.
   */
  hydrate(context: HydrateContext): ModuleInstance | undefined | Promise<ModuleInstance | undefined>;
}

export interface ModuleEntry {
  manifest: ModuleManifest;
  load(): Promise<ModuleCode>;
}

export type ModuleRegistry = readonly ModuleEntry[];

export type ModuleState = "pending" | "hydrated" | "failed" | "off" | "incompatible";

export interface ModuleEvent {
  type: ModuleState;
  module: string;
  block: string;
  error?: unknown;
}

export interface ModuleHost {
  /** Starts the modules the scene's blocks call for, after disposing whatever was attached before. */
  attach(root: HTMLElement, scene: Scene): void;
  /** Disposes every attached module. The static elements stay as they are. */
  detach(): void;
  /** Runs a command on a block's module. False when there is no such module or command, or it threw. */
  invoke(blockId: string, command: string, args?: unknown): boolean;
  /** Resolves when no module of the attached scene is still waiting to hydrate. */
  settled(): Promise<void>;
  states(): Readonly<Record<string, ModuleState>>;
}

export interface ModuleHostOptions {
  registry: ModuleRegistry;
  deck(): Deck;
  assetBase(): string;
  reducedMotion(): boolean;
  announce(message: string): void;
  onEvent?(event: ModuleEvent): void;
}

/** How long `settled` waits for blocks to be reported on before it stops waiting for them. */
export const SETTLE_LIMIT_MS = 2000;

const parseVersion = (text: string) => {
  const [major = "", minor] = text.split(".");
  return { major: Number(major), minor: minor === undefined ? undefined : Number(minor) };
};

/**
 * Whether a module at `installed` satisfies what a deck asks for. The major must match. A minor is a floor:
 * "1.2" accepts 1.2 and 1.5 but not 1.1. A patch is ignored. Version 0 gets no special treatment.
 */
export function satisfies(installed: string, needed: string): boolean {
  const have = parseVersion(installed);
  const want = parseVersion(needed);
  return have.major === want.major && (want.minor === undefined || (have.minor ?? 0) >= want.minor);
}

/** How a deck treats a module: absent means on, `off` means off, a version must be met. */
export function settingFor(deck: Deck, manifest: ModuleManifest): "on" | "off" | "incompatible" {
  const wanted = deck.modules?.[manifest.id];
  if (wanted === undefined) return "on";
  if (wanted === "off") return "off";
  return satisfies(manifest.version, wanted) ? "on" : "incompatible";
}

export function createModuleHost(options: ModuleHostOptions): ModuleHost {
  const code = new Map<string, Promise<ModuleCode>>();
  const instances = new Map<string, ModuleInstance>();
  const states = new Map<string, ModuleState>();
  const inflight = new Set<Promise<void>>();
  /** Blocks whose activation has not yet said whether it will start: not yet reported on, or not yet idle. */
  const deciding = new Set<Promise<void>>();
  let cleanups: Array<() => void> = [];
  let generation = 0;

  const loadCode = (entry: ModuleEntry) => {
    let loading = code.get(entry.manifest.id);
    if (!loading) {
      loading = entry.load();
      // A failed load is not kept, so the next scene gets another try.
      loading.catch(() => code.delete(entry.manifest.id));
      code.set(entry.manifest.id, loading);
    }
    return loading;
  };

  function mark(node: HTMLElement, entry: ModuleEntry, block: Block, state: ModuleState, error?: unknown) {
    states.set(block.id, state);
    node.dataset.moduleState = state;
    options.onEvent?.({
      type: state,
      module: entry.manifest.id,
      block: block.id,
      ...(error ? { error } : {}),
    });
  }

  function dispose(instance: ModuleInstance | undefined, name: string) {
    try {
      instance?.dispose?.();
    } catch (error) {
      console.warn(`Depthcue module "${name}" threw while closing.`, error);
    }
  }

  async function hydrate(entry: ModuleEntry, scene: Scene, block: Block, node: HTMLElement, mine: number) {
    const name = entry.manifest.id;
    const snapshot = node.cloneNode(true) as HTMLElement;
    try {
      const module = await loadCode(entry);
      if (mine !== generation) return;
      const instance = await module.hydrate({
        block,
        node,
        scene,
        deck: options.deck(),
        assetBase: options.assetBase(),
        reducedMotion: options.reducedMotion(),
        announce: options.announce,
      });
      if (mine !== generation) return dispose(instance, name);
      instances.set(block.id, instance ?? {});
      mark(node, entry, block, "hydrated");
    } catch (error) {
      if (mine !== generation) return;
      console.warn(
        `Depthcue module "${name}" failed on block "${block.id}"; showing it as plain content.`,
        error,
      );
      // The snapshot was taken before hydrating started, so it is the static form.
      if (node.isConnected) node.replaceWith(snapshot);
      mark(snapshot, entry, block, "failed", error);
    }
  }

  /**
   * Calls `go` once, when the manifest's activation says so. `settled` waits on `deciding` until the activation
   * has answered: the observer's first report (in view or not), or the idle callback or timer having run.
   */
  function schedule(entry: ModuleEntry, node: HTMLElement, go: () => void) {
    const { activation } = entry.manifest;
    let decided: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      decided = resolve;
    });
    deciding.add(waiting);
    const start = () => {
      decided();
      go();
    };
    if (activation === "visible" && typeof IntersectionObserver === "function") {
      const observer = new IntersectionObserver((seen) => {
        decided();
        if (!seen.some((item) => item.isIntersecting)) return;
        observer.disconnect();
        go();
      });
      observer.observe(node);
      cleanups.push(() => {
        observer.disconnect();
        decided();
      });
    } else if (activation === "idle" && typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(start);
      cleanups.push(() => {
        cancelIdleCallback(handle);
        decided();
      });
    } else {
      const handle = setTimeout(start, 0);
      cleanups.push(() => {
        clearTimeout(handle);
        decided();
      });
    }
  }

  const host: ModuleHost = {
    attach(root, scene) {
      host.detach();
      const mine = generation;
      for (const block of scene.blocks) {
        const entry = options.registry.find((candidate) => candidate.manifest.blocks.includes(block.type));
        const node = entry && root.querySelector<HTMLElement>(`[data-id="${block.id}"]`);
        if (!entry || !node) continue;
        node.dataset.module = entry.manifest.id;
        const setting = settingFor(options.deck(), entry.manifest);
        if (setting !== "on") {
          mark(node, entry, block, setting);
          continue;
        }
        mark(node, entry, block, "pending");
        schedule(entry, node, () => {
          const run: Promise<void> = hydrate(entry, scene, block, node, mine).finally(() =>
            inflight.delete(run),
          );
          inflight.add(run);
        });
      }
    },
    detach() {
      generation += 1;
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      deciding.clear();
      for (const instance of instances.values()) dispose(instance, "");
      instances.clear();
      states.clear();
    },
    invoke(blockId, command, args) {
      const commands = instances.get(blockId)?.commands;
      // Own properties only: a command name is data from an agent, and "constructor" is not one of ours.
      const run = commands && Object.hasOwn(commands, command) ? commands[command] : undefined;
      if (!run) return false;
      try {
        run(args);
        return true;
      } catch (error) {
        console.warn(`Depthcue command "${command}" failed on block "${blockId}".`, error);
        return false;
      }
    },
    async settled() {
      // Wait for each block's activation to answer, rather than guessing how many frames an observer takes to
      // report on a busy machine. A page nobody is looking at never reports, so the wait has an end.
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((resolve) => {
        giveUp = setTimeout(resolve, SETTLE_LIMIT_MS);
      });
      await Promise.race([Promise.all([...deciding]), limit]);
      clearTimeout(giveUp);
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
    states: () => Object.fromEntries(states),
  };
  return host;
}
