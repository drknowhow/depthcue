import { type Cue, cueMapPath, readCueMap } from "@depthcue/core";
import { h } from "../dom.ts";
import type { HydrateContext, ModuleInstance } from "../modules.ts";
import { assetUrl } from "../safe.ts";

/** 0:07, 12:30. Whole seconds are enough to tell cues apart on a clip a person will watch. */
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/**
 * Puts a row of cue chips under a clip that was built with `depthcue clip build`: each one jumps the video to
 * a layer or sound of the scene it was made from. The video is the source of truth. A clip with no cue map, or
 * a cue map that cannot be read, stays exactly as it was rendered.
 */
export async function hydrate({ block, node, assetBase, announce }: HydrateContext): Promise<ModuleInstance> {
  if (block.type !== "clip") throw new Error("The clip module only takes clip blocks.");
  const video = node.querySelector("video");
  const mapUrl = assetUrl(assetBase, cueMapPath(block.source));
  if (!video || !mapUrl) return {};

  const controller = new AbortController();
  const noCues = (): ModuleInstance => {
    // Releases the room that was kept for the chips while the cue map was on its way.
    node.dataset.cues = "none";
    return { dispose: () => delete node.dataset.cues };
  };

  let map: ReturnType<typeof readCueMap>;
  try {
    const response = await fetch(mapUrl);
    if (!response.ok) return noCues();
    map = readCueMap(await response.json());
  } catch {
    // No cue map, or one that is not JSON: the clip plays as it always did.
    return noCues();
  }
  if (!map || map.cues.length === 0) return noCues();
  const cues = map.cues;

  const on = { signal: controller.signal };
  const find = (id: unknown): Cue => {
    const cue = cues.find((candidate) => candidate.id === id);
    if (!cue)
      throw new Error(`There is no cue "${String(id)}". Cues are: ${cues.map((c) => c.id).join(", ")}.`);
    return cue;
  };
  const named = (args: unknown) => (args as { cue?: unknown } | null)?.cue;

  const chips = new Map<string, HTMLButtonElement>();
  for (const cue of cues) {
    const chip = h(
      "button",
      {
        type: "button",
        class: "dc-chip",
        "data-cue": cue.id,
        "aria-label": `${cue.id}, at ${clock(cue.in)}`,
      },
      cue.id,
      h("span", { class: "dc-cue-time" }, clock(cue.in)),
    );
    chips.set(cue.id, chip);
  }
  const row = h("div", { class: "dc-clip-cues", role: "group", "aria-label": "Jump to" }, ...chips.values());
  node.append(row);

  /** The cue that started most recently and has not ended: where the clip is now. */
  const current = (): Cue | undefined => {
    const at = video.currentTime;
    return cues.filter((cue) => cue.in <= at && at < cue.out).sort((a, b) => b.in - a.in)[0];
  };
  const mark = () => {
    const now = current()?.id;
    for (const [id, chip] of chips) {
      if (id === now) chip.setAttribute("aria-current", "true");
      else chip.removeAttribute("aria-current");
    }
  };
  const seek = (cue: Cue) => {
    video.currentTime = cue.in;
    mark();
  };
  const play = () => {
    // A browser may refuse to start playback; the person can still press the video's own button.
    void Promise.resolve(video.play()).catch(() => {});
  };

  row.addEventListener(
    "click",
    (event) => {
      const chip = (event.target as Element).closest<HTMLElement>("[data-cue]");
      const cue = chip && cues.find((candidate) => candidate.id === chip.dataset.cue);
      if (!cue) return;
      seek(cue);
      play();
      announce(`Playing from ${cue.id}.`);
    },
    on,
  );
  video.addEventListener("timeupdate", mark, on);
  video.addEventListener("seeked", mark, on);
  mark();

  return {
    commands: {
      seek: (args) => seek(find(named(args))),
      play: (args) => {
        const id = named(args);
        if (id !== undefined) seek(find(id));
        play();
      },
      pause: () => video.pause(),
    },
    dispose() {
      controller.abort();
      row.remove();
    },
  };
}
