import { type Op, TEXT_ALIGNS, TEXT_SIZES, TONES } from "@depthcue/core";
import { selectField } from "./fields.ts";
import { form, type Panel, type PanelHost } from "./panels.ts";
import { ALIGN_LABEL, SIZE_LABEL, TONE_LABEL } from "./templates.ts";

/**
 * How a text block looks as a whole: its size, where it sits in its area, and its color. Medium and start are what a
 * block is without saying, so choosing them takes the property off the block instead of writing it. A scene below 0.3
 * is brought up to 0.3 by the first of these, which the core does when a block gets a part of 0.3.
 */
export function stylePanel(host: PanelHost, sceneId: string, id: string): Panel {
  const text = () => {
    const block = host.scene(sceneId)?.blocks.find((candidate) => candidate.id === id);
    return block?.type === "text" ? block : undefined;
  };
  const set = (key: "size" | "align" | "tone", value: string): Op => ({
    op: "block.set",
    scene: sceneId,
    id,
    set: { [key]: value === "" ? null : value },
  });
  const view = form(
    () => text() !== undefined,
    () => [
      selectField(host.edits, {
        key: "style:size",
        label: "Size",
        options: TEXT_SIZES.filter((size) => size !== "m").map((value) => ({
          value,
          label: SIZE_LABEL[value],
        })),
        empty: SIZE_LABEL.m,
        read: () => {
          const size = text()?.size;
          return size === undefined || size === "m" ? "" : size;
        },
        commit: (value) => set("size", value),
      }),
      selectField(host.edits, {
        key: "style:align",
        label: "Align",
        options: TEXT_ALIGNS.filter((align) => align !== "start").map((value) => ({
          value,
          label: ALIGN_LABEL[value],
        })),
        empty: ALIGN_LABEL.start,
        read: () => {
          const align = text()?.align;
          return align === undefined || align === "start" ? "" : align;
        },
        commit: (value) => set("align", value),
      }),
      selectField(host.edits, {
        key: "style:tone",
        label: "Color",
        options: TONES.map((value) => ({ value, label: TONE_LABEL[value] })),
        empty: "Default",
        read: () => text()?.tone ?? "",
        commit: (value) => set("tone", value),
      }),
    ],
  );

  return {
    name: "style",
    label: "Style",
    title: "Size, alignment and color of this text",
    body: view.body,
    fill: (scene, typing) => view.fill(scene, typing),
    state() {
      const block = text();
      const said = [
        block?.size && block.size !== "m" ? SIZE_LABEL[block.size].toLowerCase() : undefined,
        block?.align && block.align !== "start" ? ALIGN_LABEL[block.align].toLowerCase() : undefined,
        block?.tone ? TONE_LABEL[block.tone].toLowerCase() : undefined,
      ].filter((part) => part !== undefined);
      return {
        badge: "",
        title: said.length > 0 ? `Style: ${said.join(", ")}` : "Size, alignment and color of this text",
      };
    },
  };
}
