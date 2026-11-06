// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { openController } from "../src/controllerdialog.ts";
import type { DownloadIO } from "../src/pptxdownload.ts";

/* Settings: the model and effort of the controller session, and the two things the dialog asks the server to do. */

const flush = () => new Promise((done) => setTimeout(done, 0));
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Sent {
  url: string;
  method: string;
  body: unknown;
  token: string | undefined;
}

let root: HTMLElement;
let sent: Sent[];
let state: Record<string, unknown>;
let refuseStart: string | undefined;
let io: DownloadIO;

const base = () => ({
  settings: {},
  efforts: ["low", "medium", "high", "xhigh", "max"],
  canStart: true,
  command: "claude --mcp-config c.json --dangerously-load-development-channels server:depthcue",
});

beforeEach(() => {
  root = document.createElement("div");
  document.body.replaceChildren(root);
  sent = [];
  state = base();
  refuseStart = undefined;
  io = {
    token: "the-token",
    save: () => undefined,
    send: async (url, init = {}) => {
      const path = String(url);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      sent.push({
        url: path,
        method: init.method ?? "GET",
        body,
        token: (init.headers as Record<string, string>)["X-Depthcue-Token"],
      });
      if (path.endsWith("/controller/start")) {
        return refuseStart ? reply(500, { message: refuseStart }) : reply(200, { ok: true });
      }
      if (init.method === "POST") {
        state = {
          ...state,
          settings: body,
          command: `${state.command} --model ${body.model}`,
        };
      }
      return reply(200, state);
    },
  };
});

const dialog = () => root.querySelector<HTMLDialogElement>("dialog[data-dialog='controller']");
const model = () => dialog()?.querySelector<HTMLInputElement>("input[name='model']") as HTMLInputElement;
const effort = () => dialog()?.querySelector<HTMLSelectElement>("select[name='effort']") as HTMLSelectElement;
const press = (action: string) =>
  dialog()?.querySelector<HTMLButtonElement>(`[data-dialog-action='${action}']`)?.click();
const text = (selector: string) => dialog()?.querySelector(selector)?.textContent ?? "";

describe("Settings", () => {
  it("reads how the session starts, with the token, and shows the command and the efforts", async () => {
    openController(root, io);
    await flush();
    expect(sent[0]).toMatchObject({ url: "/_depthcue/api/controller", method: "GET", token: "the-token" });
    expect(dialog()?.open).toBe(true);
    expect([...effort().options].map((option) => option.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(text("[data-command]")).toContain("server:depthcue");
    expect(model().value).toBe("");
  });

  it("shows the saved model and effort", async () => {
    state = { ...base(), settings: { model: "opus", effort: "high" } };
    openController(root, io);
    await flush();
    expect(model().value).toBe("opus");
    expect(effort().value).toBe("high");
  });

  it("saves what is in the form, and shows the command the server gives back", async () => {
    openController(root, io);
    await flush();
    model().value = "sonnet";
    effort().value = "low";
    press("save");
    await flush();
    expect(sent[1]).toMatchObject({
      url: "/_depthcue/api/controller",
      method: "POST",
      body: { model: "sonnet", effort: "low" },
    });
    expect(text("[data-command]")).toContain("--model sonnet");
    expect(text("[role='status']")).toContain("Saved");
  });

  it("saves, then starts the session", async () => {
    openController(root, io);
    await flush();
    model().value = "opus";
    press("start");
    await flush();
    await flush();
    expect(sent.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /_depthcue/api/controller",
      "POST /_depthcue/api/controller",
      "POST /_depthcue/api/controller/start",
    ]);
    expect(text("[role='status']")).toContain("terminal is opening");
  });

  it("says why the session did not start", async () => {
    refuseStart = "The MCP server is not built.";
    openController(root, io);
    await flush();
    press("start");
    await flush();
    await flush();
    expect(text("[role='alert']")).toContain("not built");
  });

  it("starts nothing when the settings are refused", async () => {
    io.send = async (url, init = {}) => {
      sent.push({ url: String(url), method: init.method ?? "GET", body: undefined, token: undefined });
      return init.method === "POST"
        ? reply(422, { message: "The effort is one of low." })
        : reply(200, state);
    };
    openController(root, io);
    await flush();
    press("start");
    await flush();
    await flush();
    expect(sent.some((call) => call.url.endsWith("/start"))).toBe(false);
    expect(text("[role='alert']")).toContain("The effort is one of");
  });

  it("cannot start where no terminal can be opened, and says to copy the command", async () => {
    state = { ...base(), canStart: false };
    openController(root, io);
    await flush();
    expect(dialog()?.querySelector<HTMLButtonElement>("[data-dialog-action='start']")?.disabled).toBe(true);
    expect(dialog()?.textContent).toContain("Copy the command");
  });

  it("says so when the server cannot be reached", async () => {
    io.send = async () => {
      throw new TypeError("Failed to fetch");
    };
    openController(root, io);
    await flush();
    expect(text("[role='alert']")).toContain("could not reach the server");
  });

  it("opens once, closes with Close or Escape, and gives the keyboard back", async () => {
    const opener = document.createElement("button");
    root.append(opener);
    opener.focus();
    openController(root, io);
    openController(root, io);
    await flush();
    expect(root.querySelectorAll("dialog[data-dialog='controller']")).toHaveLength(1);
    press("cancel");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    openController(root, io);
    dialog()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog()).toBeNull();
  });
});
