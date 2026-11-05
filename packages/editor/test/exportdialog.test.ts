// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { openExport } from "../src/exportdialog.ts";
import type { DownloadIO } from "../src/pptxdownload.ts";
import type { EditorStatus } from "../src/store.ts";

/* Export: the format and the notes and comments it asks the live server for, and what it does with the answer. */

const flush = () => new Promise((done) => setTimeout(done, 0));

interface Sent {
  url: string;
  init: RequestInit;
  answer(response: Response): void;
}

let root: HTMLElement;
let sent: Sent[];
let saved: Array<{ file: Blob; name: string }>;
let status: EditorStatus;
let io: DownloadIO;

const store = {
  get status() {
    return status;
  },
  async save() {
    if (status.save === "dirty") status = { ...status, save: "saved" };
  },
};

beforeEach(() => {
  root = document.createElement("div");
  document.body.replaceChildren(root);
  sent = [];
  saved = [];
  status = { save: "saved", message: undefined, conflict: undefined, draft: undefined };
  io = {
    token: "the-token",
    save: (file, name) => saved.push({ file, name }),
    send: (url, init = {}) =>
      new Promise<Response>((answer) => {
        sent.push({ url: String(url), init, answer });
      }),
  };
});

const dialog = () => root.querySelector<HTMLDialogElement>("dialog[data-dialog='export']");
const inDialog = <T extends HTMLElement>(selector: string) => dialog()?.querySelector<T>(selector) as T;
const box = (name: string) => inDialog<HTMLInputElement>(`input[name='${name}']`);
const format = (value: string) => inDialog<HTMLInputElement>(`input[name='format'][value='${value}']`);
const press = (action: string) => inDialog<HTMLButtonElement>(`[data-dialog-action='${action}']`).click();
const body = () => JSON.parse(String(sent[0]?.init.body));

describe("Export", () => {
  it("offers PowerPoint, PDF, HTML and video, with notes on and comments off to begin with", () => {
    openExport(root, store, io);
    expect(dialog()?.open).toBe(true);
    expect(root.querySelectorAll("input[name='format']")).toHaveLength(4);
    expect(format("pptx").checked).toBe(true);
    expect(box("notes").checked).toBe(true);
    expect(box("comments").checked).toBe(false);
  });

  it("asks for a PowerPoint file the way the PowerPoint download does when comments are left off", async () => {
    openExport(root, store, io);
    press("download");
    await flush();
    expect(sent[0]?.url).toBe("/_depthcue/api/export.pptx");
    expect(body()).toEqual({ notes: true, pictures: false });
  });

  it("asks for the PDF with the notes and comments chosen, and no picture option", async () => {
    openExport(root, store, io);
    format("pdf").click();
    format("pdf").dispatchEvent(new Event("change", { bubbles: true }));
    expect(box("pictures").closest("label")?.hidden).toBe(true);
    box("notes").click();
    box("comments").click();
    press("download");
    await flush();
    expect(sent[0]?.url).toBe("/_depthcue/api/export.pdf");
    expect(sent[0]?.init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Depthcue-Token": "the-token",
    });
    expect(body()).toEqual({ notes: false, comments: true });
  });

  it("asks for the HTML zip and saves it under the server's name", async () => {
    openExport(root, store, io);
    format("html").click();
    format("html").dispatchEvent(new Event("change", { bubbles: true }));
    press("download");
    await flush();
    expect(sent[0]?.url).toBe("/_depthcue/api/export.html");
    sent[0]?.answer(
      new Response(new Blob([new Uint8Array([80, 75])]), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="harbor-export.zip"; filename*=UTF-8''harbor-export.zip`,
        },
      }),
    );
    await flush();
    await flush();
    expect(saved.map((entry) => entry.name)).toEqual(["harbor-export.zip"]);
    expect(inDialog(".ed-pptx-saved").textContent).toContain("Saved harbor-export.zip");
  });

  it("says why when the server makes no file", async () => {
    openExport(root, store, io);
    press("download");
    await flush();
    sent[0]?.answer(
      new Response(JSON.stringify({ message: "No browser could be started." }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await flush();
    await flush();
    expect(inDialog(".ed-problem").textContent).toBe("No browser could be started.");
    expect(saved).toHaveLength(0);
  });
});
