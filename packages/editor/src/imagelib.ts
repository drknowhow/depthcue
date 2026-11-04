import { assetRefs, type Doc, deckAssetRefs } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { ListedAsset } from "./api.ts";
import { fileButton } from "./fields.ts";
import { IMAGE_ACCEPT } from "./templates.ts";

/**
 * The image library: a popover that lists the deck's pictures so one can be added, put in place of another, or deleted
 * when nothing uses it. A part of its own, fetched the first time it is opened. Choosing is the editor's business and
 * goes through the same operations as the quick bar and the Edit popover, so Undo takes it back; this part lists, asks
 * before it deletes, and gives the keyboard back.
 */
export interface LibraryHost {
  /** Add puts the picture on the slide as a new block; replace puts it in place of the chosen image. */
  mode: "add" | "replace";
  /** The document being edited, with the changes not saved yet. */
  doc(): Doc;
  /** The pictures on the server, with where the saved deck names each. Rejects with a message to read. */
  list(): Promise<ListedAsset[]>;
  /** Deletes a picture the saved deck does not name. Rejects with the server's message. */
  remove(asset: string): Promise<void>;
  /** A picture was chosen. */
  choose(asset: string): void;
  /** A file was chosen to upload, as the quick bar and the Edit popover take one. */
  upload(file: File): void;
  /** Puts the keyboard back where it was when the library was opened. */
  back(): void;
}

/** Where the document names each picture: the slides, and whether the deck itself does, as a link does. */
function namedIn(doc: Doc) {
  const slides = new Map<string, Set<string>>();
  for (const id of doc.deck.scenes) {
    for (const { asset } of assetRefs(doc.scenes[id] as Doc["scenes"][string])) {
      slides.set(asset, (slides.get(asset) ?? new Set()).add(id));
    }
  }
  return { slides, deck: new Set(deckAssetRefs(doc.deck).map((ref) => ref.asset)) };
}

const sizeOf = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function openLibrary(root: HTMLElement, host: LibraryHost): void {
  const present = root.querySelector<HTMLElement>(".ed-lib");
  if (present) {
    present.focus();
    return;
  }
  const add = host.mode === "add";
  const note = h("p", { class: "ed-lib-note", role: "status", "aria-live": "polite" });
  const list = h("ul", { class: "ed-lib-list", "aria-label": "Images in this deck" });
  const close = h("button", { type: "button", class: "ed-lib-close" }, "Close");
  const dialog = h(
    "div",
    {
      class: "ed-lib",
      role: "dialog",
      "aria-labelledby": "ed-lib-title",
      tabindex: "-1",
      "data-library": host.mode,
    },
    h("h2", { id: "ed-lib-title", class: "ed-lib-title" }, add ? "Add an image" : "Choose an image"),
    note,
    list,
    h(
      "div",
      { class: "ed-lib-foot" },
      fileButton("Upload an image", IMAGE_ACCEPT, "library:upload", (file) => {
        shut(false);
        host.upload(file);
      }),
      close,
    ),
  );

  const picks = () => [...list.querySelectorAll<HTMLElement>(".ed-lib-pick")];
  function shut(giveBack: boolean) {
    document.removeEventListener("pointerdown", outside);
    dialog.remove();
    if (giveBack) host.back();
  }
  const outside = (event: PointerEvent) => {
    if (!(event.target instanceof Node && dialog.contains(event.target))) shut(false);
  };
  close.addEventListener("click", () => shut(true));
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      shut(true);
      return;
    }
    const all = picks();
    const at = all.indexOf(event.target as HTMLElement);
    if (at < 0 || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? all.length - 1
          : at + (event.key === "ArrowDown" ? 1 : -1);
    all[Math.max(0, Math.min(all.length - 1, to))]?.focus();
  });

  /** One row asks before it deletes. Escape or Keep puts the row back with the keyboard on its Delete button. */
  function confirmRow(row: HTMLElement, item: ListedAsset, name: string, draw: () => void) {
    const keep = h("button", { type: "button" }, "Keep");
    const del = h(
      "button",
      { type: "button", class: "ed-lib-danger", "aria-label": `Delete ${name} for good` },
      "Delete",
    );
    row.replaceChildren(
      h("span", { class: "ed-lib-ask" }, `Delete ${name}? It cannot be brought back.`),
      del,
      keep,
    );
    keep.focus();
    row.onkeydown = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      draw();
      row.querySelector<HTMLElement>(".ed-lib-del")?.focus();
    };
    keep.addEventListener("click", () => {
      draw();
      row.querySelector<HTMLElement>(".ed-lib-del")?.focus();
    });
    del.addEventListener("click", () => {
      del.disabled = true;
      host.remove(item.asset).then(
        async () => {
          note.textContent = `Deleted ${name}.`;
          const at = picks().findIndex((pick) => row.contains(pick));
          await refresh();
          (picks()[Math.min(at, picks().length - 1)] ?? close).focus();
        },
        (error) => {
          note.textContent = error instanceof Error ? error.message : `${name} was not deleted.`;
          draw();
          row.querySelector<HTMLElement>(".ed-lib-del")?.focus();
        },
      );
    });
  }

  function show(items: ListedAsset[]) {
    const named = namedIn(host.doc());
    list.replaceChildren(
      ...items.map((item) => {
        const name = item.asset.replace(/^assets\//, "");
        const slides = new Set([
          ...item.usedBy.flatMap((use) => (use.scene === null ? [] : [use.scene])),
          ...(named.slides.get(item.asset) ?? []),
        ]);
        const byDeck = named.deck.has(item.asset) || item.usedBy.some((use) => use.scene === null);
        const used =
          slides.size > 0
            ? `Used on ${plural(slides.size, "slide")}`
            : byDeck
              ? "Used by a link"
              : "Not used";
        const dimensions =
          item.width && item.height ? `${item.width} by ${item.height} pixels` : "size unknown";
        const meta = `${dimensions}, ${sizeOf(item.bytes)}, ${used}`;
        const row = h("li", { class: "ed-lib-row", "data-asset": item.asset });
        const draw = () => {
          row.onkeydown = null;
          const pick = h(
            "button",
            { type: "button", class: "ed-lib-pick", "aria-label": `${add ? "Add" : "Use"} ${name}: ${meta}` },
            h("img", { src: item.asset, alt: "", loading: "lazy", decoding: "async", class: "ed-lib-thumb" }),
            h("span", { class: "ed-lib-name" }, name),
            h("span", { class: "ed-lib-meta" }, meta),
          );
          pick.addEventListener("click", () => {
            shut(false);
            host.choose(item.asset);
          });
          row.replaceChildren(pick);
          // Only a file that neither the saved deck nor this document names can go.
          if (slides.size === 0 && !byDeck) {
            const del = h(
              "button",
              { type: "button", class: "ed-lib-del", "aria-label": `Delete ${name}` },
              "Delete",
            );
            del.addEventListener("click", () => confirmRow(row, item, name, draw));
            row.append(del);
          }
        };
        draw();
        return row;
      }),
    );
    if (items.length === 0) note.textContent = "There are no images yet. Upload one to start.";
  }

  async function refresh() {
    try {
      show(await host.list());
    } catch (error) {
      note.textContent = error instanceof Error ? error.message : "The images could not be listed.";
    }
  }

  root.append(dialog);
  document.addEventListener("pointerdown", outside);
  note.textContent = "Loading images";
  dialog.focus({ preventScroll: true });
  void refresh().then(() => {
    if (!dialog.isConnected) return;
    if (picks().length > 0) note.textContent = "";
    if (document.activeElement === dialog) (picks()[0] ?? close).focus({ preventScroll: true });
  });
}
