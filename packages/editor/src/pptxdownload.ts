import { h } from "@depthcue/player";
import type { EditorStore } from "./store.ts";

/**
 * Download PowerPoint: the deck as a PowerPoint file, from the live server's export call (step 6), which sends the file
 * and writes nothing. A part of its own, fetched the first time it is opened. The file is made from the deck on disk,
 * so unsaved edits are saved first. While it is made the dialog shows how long it has taken; once it is in, the browser
 * saves it as `<deck folder>.pptx`, and the dialog stays open with what the export said about it.
 */

/** The live server's call. */
export const PPTX_CALL = "/_depthcue/api/export.pptx";

/**
 * What the export says about the file, as the call's `X-Depthcue-Report` header sends it: the summary of
 * `depthcue export --format pptx --json` without the path. One too long for a header is `shortened`: the lines that fit.
 */
export interface ExportReport {
  fonts: Array<{ family: string; roles: string[]; as?: string; embedded: string[]; notes: string[] }>;
  slides: Array<{ scene: string; title: string; step?: number; left: string[] }>;
  deck: string[];
  warnings: Array<{ message: string }>;
  shortened?: boolean;
}

/** What the dialog says over a shortened report. */
export const SHORTENED = "The full report is longer; run depthcue export --json to see all of it.";

/** Where the file comes from and goes to. A test stands in for both. */
export interface DownloadIO {
  send: typeof fetch;
  /** Hands the file to the browser, which saves it among its downloads. */
  save(file: Blob, name: string): void;
  token: string;
}

export const browserIO = (): DownloadIO => ({
  send: (...args) => fetch(...args),
  save(file, name) {
    const href = URL.createObjectURL(file);
    const link = h("a", { href, download: name, hidden: true });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  },
  token: document.querySelector<HTMLMetaElement>('meta[name="depthcue-token"]')?.content ?? "",
});

/** The name the server gives the file: its RFC 8187 `filename*` when there is one. */
export function fileNameOf(disposition: string | null): string {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "")?.[1];
  if (star) {
    try {
      return decodeURIComponent(star);
    } catch {
      // A name that does not decode falls back to the plain one.
    }
  }
  return /filename="([^"]+)"/i.exec(disposition ?? "")?.[1] ?? "deck.pptx";
}

/** The report the server sent with the file, or undefined when it sent none or one that cannot be read. */
export function reportOf(header: string | null): ExportReport | undefined {
  if (!header) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(header)) as Partial<ExportReport>;
    const lists = [parsed.fonts, parsed.slides, parsed.deck, parsed.warnings];
    return lists.every(Array.isArray) ? (parsed as ExportReport) : undefined;
  } catch {
    return undefined;
  }
}

export const sizeOf = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const NO_SERVER =
  "The editor could not reach the server. Check that depthcue edit is still running, then try again.";

/** Why the server made no file, in plain words: its own message, and the deck's first errors when that is the cause. */
export async function refusalOf(response: Response): Promise<string[]> {
  if (response.status === 404) {
    return [
      "This depthcue edit cannot make PowerPoint files. Update Depthcue, start depthcue edit again, then try again.",
    ];
  }
  let answer: { message?: unknown; diagnostics?: unknown } = {};
  try {
    answer = (await response.json()) as typeof answer;
  } catch {
    // Not JSON: the status says enough.
  }
  const message =
    typeof answer.message === "string"
      ? answer.message
      : `The server could not make the file (it answered ${response.status}).`;
  const errors = Array.isArray(answer.diagnostics)
    ? (answer.diagnostics as Array<{ at?: string; message?: string; severity?: string }>)
        .filter((diagnostic) => diagnostic.severity !== "warning")
        .slice(0, 3)
        .map((diagnostic) => `${diagnostic.at ? `${diagnostic.at}: ` : ""}${diagnostic.message ?? ""}`)
    : [];
  return [message, ...errors];
}

/** The report, read after the download: what has no PowerPoint form, slide by slide, the fonts, and the warnings. */
export function reportView(report: ExportReport | undefined): HTMLElement[] {
  if (!report) {
    return [
      h(
        "p",
        { class: "ed-hint-text" },
        "This server sent no report with the file. depthcue export with --format pptx prints one.",
      ),
    ];
  }
  const list = (items: Array<string | HTMLElement>) => h("ul", {}, ...items.map((item) => h("li", {}, item)));
  const slides = report.slides
    .map((slide, at) => ({ slide, at }))
    .filter(({ slide }) => slide.left.length > 0);
  const out: HTMLElement[] = report.shortened ? [h("p", { class: "ed-hint-text" }, SHORTENED)] : [];
  out.push(h("h3", {}, "What has no PowerPoint form"));
  out.push(
    slides.length === 0 && report.deck.length === 0
      ? h("p", {}, "Nothing: everything on every slide is in the file.")
      : list([
          ...slides.map(({ slide, at }) =>
            h(
              "span",
              {},
              h(
                "strong",
                {},
                `${at + 1} ${slide.title}${slide.step === undefined ? "" : `, step ${slide.step}`}`,
              ),
              list(slide.left),
            ),
          ),
          ...report.deck.map((line) => `Every slide: ${line}`),
        ]),
  );
  const font = (entry: ExportReport["fonts"][number], embedded: boolean) =>
    h(
      "span",
      {},
      `${entry.family}${entry.as ? ` (as ${entry.as})` : ""}${embedded ? `: ${entry.embedded.join(", ")}` : ""}`,
      entry.notes.length > 0 && list(entry.notes),
    );
  const carried = report.fonts.filter((entry) => entry.embedded.length > 0);
  const missing = report.fonts.filter((entry) => entry.embedded.length === 0);
  if (carried.length > 0)
    out.push(h("h3", {}, "Fonts in the file"), list(carried.map((entry) => font(entry, true))));
  if (report.fonts.length > 0) {
    out.push(
      h("h3", {}, "Fonts a viewer needs installed"),
      missing.length === 0
        ? h("p", {}, "None besides the ones in the file.")
        : list(missing.map((entry) => font(entry, false))),
    );
  }
  if (report.warnings.length > 0) {
    out.push(h("h3", {}, "Warnings"), list(report.warnings.map((warning) => warning.message)));
  }
  return out;
}

let opened = 0;

/** Opens the dialog, or puts the keyboard in it when it is open already. */
export function openDownload(
  root: HTMLElement,
  store: Pick<EditorStore, "save" | "status">,
  io: DownloadIO = browserIO(),
): void {
  const open = root.querySelector<HTMLDialogElement>("dialog[data-dialog='pptx']");
  if (open) {
    open.querySelector<HTMLElement>("[data-dialog-action='download']")?.focus();
    return;
  }
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const id = `ed-pptx-${++opened}`;
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
  const pictures = option(
    "pictures",
    "Each slide as one picture",
    "The slides look exactly as they do here, but nothing on them can be edited in PowerPoint.",
    false,
  );
  const notes = option("notes", "Speaker notes", "Anyone with the file can read them.", true);
  const progress = h("progress", { "aria-label": "Making the file" });
  const elapsed = h("span", {}, "0 s");
  const making = h(
    "div",
    { class: "ed-pptx-progress", hidden: true },
    progress,
    h("span", {}, "Making the file. A browser draws each slide first, so it can take a minute. "),
    elapsed,
  );
  const status = h("div", { class: "ed-pptx-status", role: "status", "aria-live": "polite" });
  const report = h("div", { class: "ed-pptx-report" });
  const problem = h("div", { class: "ed-problem", role: "alert" });
  const cancel = h("button", { type: "button", "data-dialog-action": "cancel" }, "Cancel");
  const download = h(
    "button",
    { type: "button", class: "ed-primary", "data-dialog-action": "download" },
    "Download",
  );
  const element = h(
    "dialog",
    { class: "ed-dialog ed-dialog-pptx", "data-dialog": "pptx", "aria-labelledby": `${id}-title` },
    h("h2", { class: "ed-dialog-title", id: `${id}-title` }, "Download PowerPoint"),
    h(
      "div",
      { class: "ed-dialog-body" },
      h(
        "p",
        { class: "ed-hint-text" },
        "The deck as a PowerPoint file, made from what is saved. Its text, tables and charts can be edited there.",
      ),
      h("fieldset", { class: "ed-pptx-options" }, h("legend", {}, "In the file"), pictures.row, notes.row),
      making,
      status,
      report,
    ),
    h("div", { class: "ed-dialog-foot" }, problem, cancel, download),
  );

  let call: AbortController | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  const busy = (on: boolean) => {
    making.hidden = !on;
    download.disabled = on;
    for (const input of [pictures.input, notes.input]) input.disabled = on;
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
    problem.replaceChildren();
    status.replaceChildren();
    report.replaceChildren();
    busy(true);
    // The file is made from the deck on disk, so the edits not saved yet go there first.
    if (store.status.save !== "saved") await store.save();
    if (!element.isConnected) return;
    if (store.status.conflict) {
      return refuse([
        "The files on disk changed while you were editing. Choose which version to keep, then download again.",
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
    let file: Blob;
    let response: Response;
    try {
      response = await io.send(PPTX_CALL, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Depthcue-Token": io.token },
        body: JSON.stringify({ notes: notes.input.checked, pictures: pictures.input.checked }),
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
  // While it is open the editor's own keys stay off, so a key pressed in it does only what the dialog says.
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
