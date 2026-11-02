// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DownloadIO,
  type ExportReport,
  fileNameOf,
  openDownload,
  PPTX_CALL,
  reportOf,
  SHORTENED,
} from "../src/pptxdownload.ts";
import type { EditorStatus } from "../src/store.ts";

/*
 * Download PowerPoint, on its own: the call it makes to the live server's export, the progress while the file is made,
 * the file it saves, the report it shows after, and what it says when something goes wrong.
 */

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const flush = () => new Promise((done) => setTimeout(done, 0));

interface Sent {
  url: string;
  init: RequestInit;
  answer(response: Response): void;
  fail(): void;
}

let root: HTMLElement;
let opener: HTMLButtonElement;
let sent: Sent[];
let saved: Array<{ file: Blob; name: string }>;
let status: EditorStatus;
let saves: number;
let io: DownloadIO;

const store = {
  get status() {
    return status;
  },
  async save() {
    saves += 1;
    if (status.save === "dirty") status = { ...status, save: "saved" };
  },
};

beforeEach(() => {
  root = document.createElement("div");
  opener = document.createElement("button");
  opener.textContent = "Deck";
  document.body.replaceChildren(opener, root);
  opener.focus();
  sent = [];
  saved = [];
  saves = 0;
  status = { save: "saved", message: undefined, conflict: undefined, draft: undefined };
  io = {
    token: "the-token",
    save: (file, name) => saved.push({ file, name }),
    send: (url, init = {}) =>
      new Promise<Response>((answer, no) => {
        const fail = () => no(new TypeError("Failed to fetch"));
        init.signal?.addEventListener("abort", () =>
          no(new DOMException("The call was stopped.", "AbortError")),
        );
        sent.push({ url: String(url), init, answer, fail });
      }),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const dialog = () => root.querySelector<HTMLDialogElement>("dialog[data-dialog='pptx']");
const inDialog = <T extends HTMLElement>(selector: string) => dialog()?.querySelector<T>(selector) as T;
const press = (action: string) => inDialog<HTMLButtonElement>(`[data-dialog-action='${action}']`).click();
const box = (name: string) => inDialog<HTMLInputElement>(`input[name='${name}']`);
const problem = () => inDialog<HTMLElement>(".ed-problem");

const FILE = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
const fileAnswer = (headers: Record<string, string> = {}) =>
  new Response(new Blob([FILE]), {
    status: 200,
    headers: {
      "Content-Type": PPTX,
      "Content-Disposition": `attachment; filename="it_s _a_ deck.pptx"; filename*=UTF-8''it%27s%20%28a%29%20deck.pptx`,
      ...headers,
    },
  });
const jsonAnswer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const REPORT: ExportReport = {
  fonts: [
    { family: "Harbor Sans", roles: ["text"], as: "Space Grotesk", embedded: ["Regular", "Bold"], notes: [] },
    {
      family: "IBM Plex Mono",
      roles: ["data"],
      embedded: [],
      notes: ["SemiBold: the file is not that face."],
    },
  ],
  slides: [
    { scene: "welcome", title: "Where the harbor grew", left: [] },
    {
      scene: "growth",
      title: "Growth",
      left: ['"growth-chart": the chart explorer has no PowerPoint form.'],
    },
    {
      scene: "growth",
      title: "Growth",
      step: 2,
      left: ['"growth-table" is 195 px past the bottom of the slide.'],
    },
  ],
  deck: ["Scene changes: the slides change with no transition."],
  warnings: [{ message: "The slot body of findings is empty." }],
};

describe("Download PowerPoint", () => {
  it("asks the live server for the file with the token and the options, and saves it under the server's name", async () => {
    openDownload(root, store, io);
    expect(dialog()?.open).toBe(true);
    expect(document.activeElement).toBe(inDialog("[data-dialog-action='download']"));
    expect(box("pictures").checked).toBe(false);
    expect(box("notes").checked).toBe(true);
    box("pictures").click();
    press("download");
    await flush();
    expect(sent).toHaveLength(1);
    const [call] = sent as [Sent];
    expect(call.url).toBe(PPTX_CALL);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Depthcue-Token": "the-token",
    });
    expect(JSON.parse(String(call.init.body))).toEqual({ notes: true, pictures: true });
    call.answer(fileAnswer());
    await flush();
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe("it's (a) deck.pptx");
    expect(new Uint8Array(await (saved[0] as { file: Blob }).file.arrayBuffer())).toEqual(FILE);
    expect(inDialog(".ed-pptx-saved").textContent).toBe(
      "Saved it's (a) deck.pptx, 1 KB, among your browser's downloads. ",
    );
    expect(document.activeElement).toBe(inDialog(".ed-pptx-saved"));
    expect(inDialog("[data-dialog-action='cancel']").textContent).toBe("Close");
    // The person can save it again, without making it again.
    press("save-again");
    expect(saved).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it("shows that the file is being made, and how long it has taken, with Download off until it is in", async () => {
    vi.useFakeTimers();
    openDownload(root, store, io);
    press("download");
    await vi.advanceTimersByTimeAsync(0);
    const making = inDialog<HTMLElement>(".ed-pptx-progress");
    expect(making.hidden).toBe(false);
    expect(making.querySelector("progress")).not.toBeNull();
    expect(inDialog<HTMLButtonElement>("[data-dialog-action='download']").disabled).toBe(true);
    expect(inDialog("[data-dialog-action='download']").getAttribute("aria-busy")).toBe("true");
    expect(box("pictures").disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(making.textContent).toContain("3 s");
    // A second press while it is made sends nothing more.
    press("download");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    (sent[0] as Sent).answer(fileAnswer());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(making.hidden).toBe(true);
    expect(inDialog<HTMLButtonElement>("[data-dialog-action='download']").disabled).toBe(false);
    expect(inDialog("[data-dialog-action='download']").hasAttribute("aria-busy")).toBe(false);
  });

  it("saves the edits not saved yet first, since the file is made from the deck on disk", async () => {
    status = { ...status, save: "dirty" };
    openDownload(root, store, io);
    press("download");
    await flush();
    expect(saves).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when the edits could not be saved, or the files on disk changed, and says why", async () => {
    status = { ...status, save: "error", message: "The disk is full." };
    openDownload(root, store, io);
    press("download");
    await flush();
    expect(sent).toHaveLength(0);
    expect(problem().textContent).toBe(
      "The deck could not be saved, so the file would leave your latest changes out. The disk is full.",
    );
    expect(inDialog<HTMLButtonElement>("[data-dialog-action='download']").disabled).toBe(false);

    status = { ...status, save: "dirty", message: undefined, conflict: { diskRev: "r2" } };
    press("download");
    await flush();
    expect(sent).toHaveLength(0);
    expect(problem().textContent).toBe(
      "The files on disk changed while you were editing. Choose which version to keep, then download again.",
    );
  });

  it("shows the export's report after the download: what has no PowerPoint form, the fonts and the warnings", async () => {
    openDownload(root, store, io);
    press("download");
    await flush();
    (sent[0] as Sent).answer(fileAnswer({ "X-Depthcue-Report": encodeURIComponent(JSON.stringify(REPORT)) }));
    await flush();
    await flush();
    const report = inDialog<HTMLElement>(".ed-pptx-report");
    const headings = [...report.querySelectorAll("h3")].map((node) => node.textContent);
    expect(headings).toEqual([
      "What has no PowerPoint form",
      "Fonts in the file",
      "Fonts a viewer needs installed",
      "Warnings",
    ]);
    const items = [...report.children]
      .filter((node) => node.tagName === "UL")
      .flatMap((list) => [...list.children].map((node) => node.textContent));
    expect(items).toEqual([
      '2 Growth"growth-chart": the chart explorer has no PowerPoint form.',
      '3 Growth, step 2"growth-table" is 195 px past the bottom of the slide.',
      "Every slide: Scene changes: the slides change with no transition.",
      "Harbor Sans (as Space Grotesk): Regular, Bold",
      "IBM Plex MonoSemiBold: the file is not that face.",
      "The slot body of findings is empty.",
    ]);
    // The first slide has everything, so it is not listed.
    expect(report.textContent).not.toContain("Where the harbor grew");
  });

  it("says so when a deck has nothing without a PowerPoint form, and when the server sent no report", async () => {
    openDownload(root, store, io);
    press("download");
    await flush();
    const plain: ExportReport = {
      fonts: [],
      slides: [{ scene: "a", title: "A", left: [] }],
      deck: [],
      warnings: [],
    };
    (sent[0] as Sent).answer(fileAnswer({ "X-Depthcue-Report": encodeURIComponent(JSON.stringify(plain)) }));
    await flush();
    await flush();
    expect(inDialog(".ed-pptx-report").textContent).toBe(
      "What has no PowerPoint formNothing: everything on every slide is in the file.",
    );

    press("download");
    await flush();
    (sent[1] as Sent).answer(fileAnswer());
    await flush();
    await flush();
    expect(inDialog(".ed-pptx-report").textContent).toBe(
      "This server sent no report with the file. depthcue export with --format pptx prints one.",
    );
  });

  it("says when the report was shortened to fit, over the lines that came", async () => {
    openDownload(root, store, io);
    press("download");
    await flush();
    const short = {
      ...REPORT,
      shortened: true,
      slides: REPORT.slides.slice(0, 2),
      deck: [],
      fonts: [],
      warnings: [],
    };
    (sent[0] as Sent).answer(fileAnswer({ "X-Depthcue-Report": encodeURIComponent(JSON.stringify(short)) }));
    await flush();
    await flush();
    const report = inDialog<HTMLElement>(".ed-pptx-report");
    expect(report.firstElementChild?.textContent).toBe(SHORTENED);
    expect(SHORTENED).toBe("The full report is longer; run depthcue export --json to see all of it.");
    expect(report.textContent).toContain('"growth-chart": the chart explorer has no PowerPoint form.');
    expect(report.textContent).not.toContain("growth-table");
  });

  it("says in plain words what went wrong, and keeps the dialog open to try again", async () => {
    openDownload(root, store, io);
    const attempt = async (answer: (call: Sent) => void) => {
      press("download");
      await flush();
      answer(sent.at(-1) as Sent);
      await flush();
      await flush();
      return problem();
    };
    expect((await attempt((call) => call.fail())).textContent).toBe(
      "The editor could not reach the server. Check that depthcue edit is still running, then try again.",
    );
    expect(
      (await attempt((call) => call.answer(new Response("Not found.", { status: 404 })))).textContent,
    ).toBe(
      "This depthcue edit cannot make PowerPoint files. Update Depthcue, start depthcue edit again, then try again.",
    );
    const invalid = await attempt((call) =>
      call.answer(
        jsonAnswer(422, {
          error: "deck-invalid",
          message: "The deck has errors, so there is no file. Fix them and export again.",
          diagnostics: [
            {
              code: "x",
              at: "scenes/growth.json /blocks/0",
              severity: "error",
              message: "The chart has no data.",
            },
            { code: "y", at: "deck.json", severity: "warning", message: "Not a reason." },
          ],
        }),
      ),
    );
    expect(invalid.querySelector("span")?.textContent).toBe(
      "The deck has errors, so there is no file. Fix them and export again.",
    );
    expect([...invalid.querySelectorAll("li")].map((node) => node.textContent)).toEqual([
      "scenes/growth.json /blocks/0: The chart has no data.",
    ]);
    expect(
      (
        await attempt((call) =>
          call.answer(jsonAnswer(503, { error: "no-browser", message: "No Chrome or Edge was found." })),
        )
      ).textContent,
    ).toBe("No Chrome or Edge was found.");
    expect((await attempt((call) => call.answer(new Response("", { status: 500 })))).textContent).toBe(
      "The server could not make the file (it answered 500).",
    );
    expect(saved).toHaveLength(0);
    expect(dialog()?.open).toBe(true);
    // A try that works clears what the last one said.
    await attempt((call) => call.answer(fileAnswer()));
    expect(problem().textContent).toBe("");
    expect(saved).toHaveLength(1);
  });

  it("stops waiting when it is cancelled while the file is made, saves nothing, and gives the keyboard back", async () => {
    openDownload(root, store, io);
    press("download");
    await flush();
    const signal = (sent[0] as Sent).init.signal as AbortSignal;
    press("cancel");
    expect(signal.aborted).toBe(true);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    (sent[0] as Sent).answer(fileAnswer());
    await flush();
    await flush();
    expect(saved).toHaveLength(0);
    expect(root.querySelector(".ed-problem")).toBeNull();
  });

  it("closes with Escape, keeps the editor's keys out, and puts the keyboard in a dialog that is open already", () => {
    openDownload(root, store, io);
    const heard = vi.fn();
    root.addEventListener("keydown", heard);
    box("notes").focus();
    openDownload(root, store, io);
    expect(root.querySelectorAll("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(inDialog("[data-dialog-action='download']"));
    inDialog("[data-dialog-action='download']").dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", bubbles: true }),
    );
    expect(heard).not.toHaveBeenCalled();
    inDialog("[data-dialog-action='download']").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("names its options and says what each does", () => {
    openDownload(root, store, io);
    for (const name of ["pictures", "notes"]) {
      const about = document.getElementById(box(name).getAttribute("aria-describedby") as string);
      expect(about?.textContent).not.toBe("");
      expect(box(name).closest("label")?.textContent).toContain(about?.textContent);
    }
    expect(dialog()?.getAttribute("aria-labelledby")).toBe(inDialog("h2").id);
    expect(inDialog("h2").textContent).toBe("Download PowerPoint");
  });
});

describe("the file name and the report the server sends", () => {
  it("takes the RFC 8187 name, then the plain one, then a name of its own", () => {
    expect(fileNameOf(`attachment; filename="a_b.pptx"; filename*=UTF-8''a%C3%A9b.pptx`)).toBe("aéb.pptx");
    expect(fileNameOf(`attachment; filename="a_b.pptx"; filename*=UTF-8''%E0%A4.pptx`)).toBe("a_b.pptx");
    expect(fileNameOf(`attachment; filename="plain.pptx"`)).toBe("plain.pptx");
    expect(fileNameOf(null)).toBe("deck.pptx");
  });

  it("reads a report only when it has its four lists", () => {
    expect(reportOf(encodeURIComponent(JSON.stringify(REPORT)))).toEqual(REPORT);
    expect(reportOf(null)).toBeUndefined();
    expect(reportOf("%")).toBeUndefined();
    expect(reportOf(encodeURIComponent(JSON.stringify({ ...REPORT, fonts: "none" })))).toBeUndefined();
  });
});
