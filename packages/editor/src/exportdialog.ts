import { h } from "@depthcue/player";
import {
  browserIO,
  type DownloadIO,
  fileNameOf,
  NO_SERVER,
  PPTX_CALL,
  refusalOf,
  reportOf,
  reportView,
  sizeOf,
} from "./pptxdownload.ts";
import type { EditorStore } from "./store.ts";

/**
 * Export: the deck as a PowerPoint file, a PDF or an HTML page, with the speaker notes and the comments in it or left
 * out. A part of its own, fetched the first time it is opened. Each file is made by the live server from the deck on
 * disk, so unsaved edits are saved first; the browser saves the file, and the dialog stays open with what the export
 * said about it.
 */

export type ExportFormat = "pptx" | "pdf" | "html" | "mp4";

interface FormatInfo {
  label: string;
  call: string;
  about: string;
  /** Said under the dialog while the file is made. */
  wait: string;
}

export const FORMATS: Record<ExportFormat, FormatInfo> = {
  pptx: {
    label: "PowerPoint",
    call: PPTX_CALL,
    about: "Text, tables and charts can be edited in PowerPoint.",
    wait: "A browser draws each slide first, so it can take a minute. ",
  },
  pdf: {
    label: "PDF",
    call: "/_depthcue/api/export.pdf",
    about: "One page for each scene as it looks here, with the notes and comments after the last one.",
    wait: "A browser draws each scene first, so it can take a minute. ",
  },
  html: {
    label: "HTML",
    call: "/_depthcue/api/export.html",
    about: "A zip of the page that opens by double-click, with no server and no network.",
    wait: "Making the page. ",
  },
  mp4: {
    label: "Video",
    call: "/_depthcue/api/export.mp4",
    about:
      "An MP4 with the voice-over: each scene is held for as long as its recording, and the {step} marks bring in the steps.",
    wait: "A browser draws each scene and ffmpeg joins them with the sound, so it can take a few minutes. ",
  },
};

let opened = 0;

/** Opens the dialog, or puts the keyboard in it when it is open already. */
export function openExport(
  root: HTMLElement,
  store: Pick<EditorStore, "save" | "status">,
  io: DownloadIO = browserIO(),
): void {
  const open = root.querySelector<HTMLDialogElement>("dialog[data-dialog='export']");
  if (open) {
    open.querySelector<HTMLElement>("[data-dialog-action='download']")?.focus();
    return;
  }
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const id = `ed-export-${++opened}`;

  const formats = (Object.keys(FORMATS) as ExportFormat[]).map((format, at) => {
    const input = h("input", {
      type: "radio",
      name: "format",
      value: format,
      checked: at === 0,
      "aria-describedby": `${id}-${format}`,
    });
    return {
      format,
      input,
      row: h(
        "label",
        { class: "ed-pptx-option" },
        input,
        h("span", {}, FORMATS[format].label),
        h("small", { id: `${id}-${format}` }, FORMATS[format].about),
      ),
    };
  });
  const option = (name: string, label: string, about: string, checked: boolean) => {
    const input = h("input", { type: "checkbox", name, checked, "aria-describedby": `${id}-${name}` });
    return {
      input,
      row: h(
        "label",
        { class: "ed-pptx-option" },
        input,
        h("span", {}, label),
        h("small", { id: `${id}-${name}` }, about),
      ),
    };
  };
  const notes = option("notes", "Speaker notes", "Anyone with the file can read them.", true);
  const comments = option(
    "comments",
    "Comments",
    "Open and resolved ones, with every reply. Anyone with the file can read them.",
    false,
  );
  const pictures = option(
    "pictures",
    "Each slide as one picture",
    "The slides look exactly as they do here, but nothing on them can be edited in PowerPoint.",
    false,
  );
  const captions = option(
    "captions",
    "Captions on the video",
    "The words of the voice-over, drawn over the slide as they are said.",
    false,
  );
  const formatNow = () => formats.find((entry) => entry.input.checked)?.format ?? "pptx";
  const progress = h("progress", { "aria-label": "Making the file" });
  const elapsed = h("span", {}, "0 s");
  const waiting = h("span", {}, FORMATS.pptx.wait);
  const making = h("div", { class: "ed-pptx-progress", hidden: true }, progress, waiting, elapsed);
  const status = h("div", { class: "ed-pptx-status", role: "status", "aria-live": "polite" });
  const report = h("div", { class: "ed-pptx-report" });
  const problem = h("div", { class: "ed-problem", role: "alert" });
  const cancel = h("button", { type: "button", "data-dialog-action": "cancel" }, "Cancel");
  const download = h(
    "button",
    { type: "button", class: "ed-primary", "data-dialog-action": "download" },
    "Export",
  );
  const element = h(
    "dialog",
    { class: "ed-dialog ed-dialog-pptx", "data-dialog": "export", "aria-labelledby": `${id}-title` },
    h("h2", { class: "ed-dialog-title", id: `${id}-title` }, "Export"),
    h(
      "div",
      { class: "ed-dialog-body" },
      h("p", { class: "ed-hint-text" }, "The deck as a file, made from what is saved."),
      h(
        "fieldset",
        { class: "ed-pptx-options" },
        h("legend", {}, "Format"),
        ...formats.map((entry) => entry.row),
      ),
      h(
        "fieldset",
        { class: "ed-pptx-options" },
        h("legend", {}, "In the file"),
        notes.row,
        comments.row,
        pictures.row,
        captions.row,
      ),
      making,
      status,
      report,
    ),
    h("div", { class: "ed-dialog-foot" }, problem, cancel, download),
  );

  const showFormat = () => {
    pictures.row.hidden = formatNow() !== "pptx";
    captions.row.hidden = formatNow() !== "mp4";
    waiting.textContent = FORMATS[formatNow()].wait;
  };
  for (const entry of formats) entry.input.addEventListener("change", showFormat);
  showFormat();

  let call: AbortController | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  const inputs = [
    ...formats.map((entry) => entry.input),
    notes.input,
    comments.input,
    pictures.input,
    captions.input,
  ];
  const busy = (on: boolean) => {
    making.hidden = !on;
    download.disabled = on;
    for (const input of inputs) input.disabled = on;
    if (on) download.setAttribute("aria-busy", "true");
    else download.removeAttribute("aria-busy");
    clearInterval(clock);
    if (!on) return;
    const start = Date.now();
    elapsed.textContent = "0 s";
    clock = setInterval(() => {
      elapsed.textContent = `${Math.round((Date.now() - start) / 1000)} s`;
    }, 1000);
  };
  const refuse = (lines: string[]) => {
    busy(false);
    const [first = "", ...rest] = lines;
    problem.replaceChildren(h("span", {}, first));
    if (rest.length > 0) problem.append(h("ul", {}, ...rest.map((line) => h("li", {}, line))));
  };
  const close = () => {
    if (!element.isConnected) return;
    call?.abort();
    clearInterval(clock);
    if (element.open && typeof element.close === "function") element.close();
    element.remove();
    back?.focus({ preventScroll: true });
  };

  const run = async () => {
    if (download.disabled) return;
    const format = formatNow();
    problem.replaceChildren();
    status.replaceChildren();
    report.replaceChildren();
    busy(true);
    if (store.status.save !== "saved") await store.save();
    if (!element.isConnected) return;
    if (store.status.conflict) {
      return refuse([
        "The files on disk changed while you were editing. Choose which version to keep, then export again.",
      ]);
    }
    if (store.status.save !== "saved") {
      return refuse([
        `The deck could not be saved, so the file would leave your latest changes out.${
          store.status.message ? ` ${store.status.message}` : ""
        }`,
      ]);
    }
    call = new AbortController();
    const { signal } = call;
    // The video takes only captions; the other options are for the files that hold notes and comments.
    const body =
      format === "mp4"
        ? { captions: captions.input.checked }
        : {
            notes: notes.input.checked,
            ...(format === "pptx" ? { pictures: pictures.input.checked } : {}),
            ...(comments.input.checked ? { comments: true } : {}),
          };
    let file: Blob;
    let response: Response;
    try {
      response = await io.send(FORMATS[format].call, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Depthcue-Token": io.token },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) return refuse(await refusalOf(response));
      file = await response.blob();
    } catch {
      return signal.aborted ? undefined : refuse([NO_SERVER]);
    }
    busy(false);
    const name = fileNameOf(response.headers.get("Content-Disposition"));
    io.save(file, name);
    const again = h("button", { type: "button", "data-dialog-action": "save-again" }, "Save it again");
    again.addEventListener("click", () => io.save(file, name));
    const saved = h(
      "p",
      { class: "ed-pptx-saved", tabindex: "-1" },
      `Saved ${name}, ${sizeOf(file.size)}, among your browser's downloads. `,
    );
    status.replaceChildren(saved, again);
    if (format === "pptx")
      report.replaceChildren(...reportView(reportOf(response.headers.get("X-Depthcue-Report"))));
    cancel.textContent = "Close";
    saved.focus({ preventScroll: true });
  };

  download.addEventListener("click", () => void run());
  cancel.addEventListener("click", close);
  element.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  element.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  root.append(element);
  if (typeof element.showModal === "function") element.showModal();
  else element.setAttribute("open", "");
  download.focus();
}
