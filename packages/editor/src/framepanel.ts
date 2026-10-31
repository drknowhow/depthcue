import type { Frame, Op } from "@depthcue/core";
import { h } from "@depthcue/player";
import { actionButton, numberField } from "./fields.ts";
import { form, type Panel, type PanelHost } from "./panels.ts";
import { ALIGNS, type Align, aligned } from "./pin.ts";

const AXES = [
  ["x", "Left"],
  ["y", "Top"],
  ["w", "Width"],
  ["h", "Height"],
] as const;

const ALIGN_LABEL: Record<Align, string> = { left: "Left", center: "Center", right: "Right" };

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Where a pinned block sits, as four numbers and three alignments. It is the way to place a block exactly and the
 * way to place one without a pointer. The chip is there only while the block is pinned; the Layout and Free
 * buttons of the toolbar are what pin and unpin.
 */
export function framePanel(host: PanelHost, sceneId: string, id: string): Panel {
  const frame = () => host.scene(sceneId)?.blocks.find((block) => block.id === id)?.frame;
  const place = (next: Frame): Op => ({ op: "block.frame", scene: sceneId, id, frame: next });

  const view = form(
    () => frame() !== undefined,
    () => {
      const current = frame();
      if (!current) return [];
      return [
        h(
          "p",
          { class: "ed-hint-text" },
          "Percent of the slide. With the block chosen, the arrow keys move it, and Shift moves it further.",
        ),
        h(
          "div",
          { class: "ed-frame-grid" },
          ...AXES.map(([key, label]) =>
            numberField(host.edits, {
              key: `frame:${key}`,
              label: `${label} %`,
              read: () => frame()?.[key] ?? 0,
              commit: (value) => place({ ...(frame() as Frame), [key]: value }),
            }),
          ),
        ),
        h(
          "div",
          { class: "ed-frame-align", role: "group", "aria-label": "Align on the slide" },
          ...ALIGNS.map((how) =>
            actionButton(
              ALIGN_LABEL[how],
              () => {
                const live = frame();
                if (live) host.run([place(aligned(live, how))]);
              },
              { "data-tb": `align-${how}` },
            ),
          ),
        ),
      ];
    },
  );

  return {
    name: "frame",
    label: "Pinned",
    title: "Position and size of the pinned block",
    body: view.body,
    fill: (scene, typing) => view.fill(scene, typing),
    visible: (scene) => scene.blocks.find((block) => block.id === id)?.frame !== undefined,
    state(scene) {
      const at = scene.blocks.find((block) => block.id === id)?.frame;
      return {
        badge: "",
        title: at
          ? `Pinned at ${round(at.x)}% across and ${round(at.y)}% down, ${round(at.w)}% wide and ${round(at.h)}% tall`
          : "Position and size of the pinned block",
      };
    },
  };
}
