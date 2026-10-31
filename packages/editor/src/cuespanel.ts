import { type Cue, cueMapPath, isMarker, MAX_CUE_ID, nextMarkerId } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { ClipSize } from "./api.ts";
import { type CueBook, clock } from "./cues.ts";
import { actionButton } from "./fields.ts";
import { form, type Panel, type PanelHost } from "./panels.ts";

/** What the Cues popover needs from the slide: the book of cues, and the video that is on it. */
export interface CueTools {
  book: CueBook;
  /** Where the clip on the slide is, in seconds, or undefined when the slide has no video to ask. */
  playhead(id: string): number | undefined;
  /** What the clip measures, or undefined when that cannot be read. */
  measure(id: string): Promise<ClipSize | undefined>;
  /** Moves the clip on the slide to `seconds`. */
  seek(id: string, seconds: number): void;
}

/**
 * The places to jump to in a clip. The ones the scene made are shown and can be jumped to, but only the markers
 * a person added are edited here: the video is the source of truth for the rest, and `depthcue clip build` keeps
 * markers when it rebuilds.
 */
export function cuesPanel(host: PanelHost, tools: CueTools, sceneId: string, id: string): Panel {
  const clip = () => {
    const block = host.scene(sceneId)?.blocks.find((candidate) => candidate.id === id);
    return block?.type === "clip" ? block : undefined;
  };
  const entryOf = () => {
    const block = clip();
    return block ? tools.book.entry(block.source) : undefined;
  };
  const key = (name: string) => `cue:${name}`;

  const panel = form(
    () => clip() !== undefined,
    () => {
      const block = clip();
      if (!block) return [];
      const { source } = block;
      const entry = tools.book.entry(source);
      const ready = entry.phase === "ready";
      const open = ready && entry.state !== "broken";

      async function add() {
        const at = tools.playhead(id);
        if (at === undefined) return host.problem("There is no video on the slide to read the time from.");
        const before = tools.book.entry(source);
        const size = before.state === "none" ? await tools.measure(id) : undefined;
        if (before.state === "none" && !size) {
          return host.problem("The length of the video could not be read. Press play on it, then try again.");
        }
        // The marker is named for what the book will call it, so the keyboard can go to its name afterwards.
        panel.focusNext(key(`name:${nextMarkerId(before.cues)}`));
        if (!(await tools.book.addMarker(source, at, size))) panel.focusNext(undefined);
      }

      const status = (() => {
        if (entry.phase === "loading") return h("p", { class: "ed-hint-text" }, "Reading the cues…");
        if (entry.phase === "failed") {
          return h(
            "p",
            { class: "ed-hint-text" },
            "The cues could not be read. ",
            actionButton("Try again", () => tools.book.reload(source), { "data-tb": "cue-retry" }),
          );
        }
        if (entry.state === "broken") {
          return h(
            "p",
            { class: "ed-hint-text", "data-cue-state": "broken" },
            `${cueMapPath(source)} is not a cue file the editor can read, so it is left alone. Fix or remove that file to add markers.`,
          );
        }
        return h(
          "p",
          { class: "ed-hint-text", "data-cue-state": entry.state },
          entry.state === "none"
            ? "This clip has no cue map yet. The first marker starts one."
            : "Markers are yours to edit and survive a rebuild. The other cues come from the scene.",
        );
      })();

      const list = h("ul", { class: "ed-cue-list" });
      for (const cue of entry.cues) list.append(row(cue));

      function row(cue: Cue) {
        const go = actionButton(clock(cue.in), () => tools.seek(id, cue.in), {
          class: "ed-cue-go",
          "aria-label": `Go to ${cue.id}, at ${clock(cue.in)}`,
          "data-tb": "cue-go",
        });
        go.setAttribute("data-field", key(`go:${cue.id}`));
        if (!isMarker(cue)) {
          return h(
            "li",
            { class: "ed-cue-row", "data-cue": cue.id },
            go,
            h("span", { class: "ed-cue-name" }, cue.id),
            h("span", { class: "ed-cue-type" }, cue.type),
          );
        }
        const name = h("input", {
          type: "text",
          class: "ed-cue-name",
          maxlength: MAX_CUE_ID,
          "aria-label": `Name of marker ${cue.id}`,
          "data-field": key(`name:${cue.id}`),
        });
        name.value = cue.id;
        name.addEventListener("change", () => {
          void tools.book.renameMarker(source, cue.id, name.value).then((ok) => {
            if (!ok) name.value = cue.id;
          });
        });
        const time = h("input", {
          type: "number",
          class: "ed-cue-time",
          step: "0.1",
          min: "0",
          inputmode: "decimal",
          "aria-label": `Time of ${cue.id}, in seconds`,
          "data-field": key(`time:${cue.id}`),
        });
        time.value = String(cue.in);
        time.addEventListener("change", () => {
          const seconds = time.value.trim() === "" ? Number.NaN : Number(time.value);
          if (!Number.isFinite(seconds)) {
            host.problem("Enter a time in seconds.");
            time.value = String(cue.in);
            return;
          }
          void tools.book.moveMarker(source, cue.id, seconds).then((ok) => {
            if (!ok) time.value = String(cue.in);
          });
        });
        const here = actionButton(
          "Here",
          () => {
            const at = tools.playhead(id);
            if (at === undefined) host.problem("There is no video on the slide to read the time from.");
            else void tools.book.moveMarker(source, cue.id, at);
          },
          { class: "ed-cue-here", "aria-label": `Move ${cue.id} to the playhead`, "data-tb": "cue-here" },
        );
        const remove = actionButton("", () => void tools.book.removeMarker(source, cue.id), {
          class: "ed-tb-remove ed-cue-remove",
          "aria-label": `Remove marker ${cue.id}`,
          title: "Remove",
          "data-tb": "cue-remove",
        });
        return h(
          "li",
          { class: "ed-cue-row", "data-cue": cue.id, "data-marker": "" },
          go,
          name,
          time,
          here,
          remove,
        );
      }

      return [
        status,
        actionButton("Add marker at the playhead", () => void add(), {
          class: "ed-button",
          "data-tb": "cue-add",
          disabled: !open,
          title: "Play the video on the slide, pause where you want the marker, then add it",
        }),
        list,
        actionButton("Undo marker change", () => void tools.book.undo(source), {
          class: "ed-button",
          "data-tb": "cue-undo",
          disabled: entry.undoable === 0,
          title:
            "Cue changes are saved to the cue file as they are made, so they are not part of Undo in the top bar",
        }),
      ];
    },
  );

  return {
    name: "cues",
    label: "Cues",
    title: "Places to jump to in this clip",
    body: panel.body,
    fill: panel.fill,
    state() {
      const entry = entryOf();
      const count = entry?.phase === "ready" ? entry.cues.length : 0;
      return {
        badge: count > 0 ? String(count) : "",
        title: count > 0 ? `Cues, ${count} to jump to` : "Places to jump to in this clip",
      };
    },
  };
}
