import { h } from "@depthcue/player";
import { browserIO, type DownloadIO, NO_SERVER } from "./pptxdownload.ts";

/**
 * Settings: how the controller session starts for this deck. The controller is a Claude Code session that has the
 * deck's tools and hears what is done here (edits, comments, "ask an agent") as it happens. A part of its own, fetched
 * the first time it is opened. The model and the effort are kept beside the deck by the server; Start opens a terminal
 * on this computer, because Claude Code asks the person to confirm the channel there.
 */

interface ControllerState {
  settings: { model?: string; effort?: string };
  efforts: string[];
  canStart: boolean;
  command?: string;
  problem?: string;
}

const MODELS = ["opus", "sonnet", "haiku"];

let opened = 0;

/** Opens the dialog, or puts the keyboard in it when it is open already. */
export function openController(root: HTMLElement, io: DownloadIO = browserIO()): void {
  const open = root.querySelector<HTMLDialogElement>("dialog[data-dialog='controller']");
  if (open) {
    open.querySelector<HTMLElement>("[data-dialog-action='start']")?.focus();
    return;
  }
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const id = `ed-controller-${++opened}`;

  const model = h("input", {
    type: "text",
    name: "model",
    list: `${id}-models`,
    placeholder: "Claude Code's default",
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": `${id}-model-about`,
  }) as HTMLInputElement;
  const effort = h("select", {
    name: "effort",
    "aria-describedby": `${id}-effort-about`,
  }) as HTMLSelectElement;
  effort.append(h("option", { value: "" }, "Claude Code's default"));
  const command = h("code", { class: "ed-command", "data-command": "" });
  const status = h("div", { class: "ed-pptx-status", role: "status", "aria-live": "polite" });
  const problem = h("div", { class: "ed-problem", role: "alert" });
  const close = h("button", { type: "button", "data-dialog-action": "cancel" }, "Close");
  const save = h("button", { type: "button", "data-dialog-action": "save" }, "Save");
  const copy = h("button", { type: "button", "data-dialog-action": "copy" }, "Copy command");
  const start = h(
    "button",
    { type: "button", class: "ed-primary", "data-dialog-action": "start" },
    "Start session",
  ) as HTMLButtonElement;
  const hint = h("small", { id: `${id}-start-about` });

  const element = h(
    "dialog",
    { class: "ed-dialog ed-dialog-pptx", "data-dialog": "controller", "aria-labelledby": `${id}-title` },
    h("h2", { class: "ed-dialog-title", id: `${id}-title` }, "Settings"),
    h(
      "div",
      { class: "ed-dialog-body" },
      h(
        "p",
        { class: "ed-hint-text" },
        "The controller is a Claude Code session for this deck. It has the deck's tools and hears what you do here, such as edits, comments and Ask an agent, as it happens.",
      ),
      h(
        "fieldset",
        { class: "ed-pptx-options" },
        h("legend", {}, "Controller session"),
        h(
          "label",
          { class: "ed-field" },
          h("span", {}, "Model"),
          model,
          h("datalist", { id: `${id}-models` }, ...MODELS.map((name) => h("option", { value: name }))),
          h(
            "small",
            { id: `${id}-model-about` },
            "An alias such as opus or sonnet, or a full model name. Empty uses Claude Code's default.",
          ),
        ),
        h(
          "label",
          { class: "ed-field" },
          h("span", {}, "Effort"),
          effort,
          h(
            "small",
            { id: `${id}-effort-about` },
            "How hard the model thinks. Higher is slower and costs more.",
          ),
        ),
      ),
      h("p", { class: "ed-hint-text" }, "To start it yourself, run this in a terminal:"),
      command,
      h("div", { class: "ed-dialog-row" }, copy),
      hint,
      status,
    ),
    h("div", { class: "ed-dialog-foot" }, problem, close, save, start),
  );

  let state: ControllerState | undefined;
  let busy = false;
  const headers = { "Content-Type": "application/json", "X-Depthcue-Token": io.token };

  const show = (next: ControllerState) => {
    state = next;
    model.value = next.settings.model ?? "";
    effort.replaceChildren(
      h("option", { value: "" }, "Claude Code's default"),
      ...next.efforts.map((level) => h("option", { value: level }, level)),
    );
    effort.value = next.settings.effort ?? "";
    command.textContent = next.command ?? "";
    start.disabled = !next.canStart || busy;
    hint.textContent = next.canStart
      ? "Start opens a terminal on this computer. Claude Code asks you to confirm the channel there."
      : "This computer cannot open a terminal from the editor. Copy the command and run it in the deck folder.";
    if (next.problem) problem.textContent = next.problem;
  };
  const refuse = (message: string) => {
    problem.textContent = message;
    status.replaceChildren();
  };
  const settingsNow = () => ({ model: model.value.trim(), effort: effort.value });

  async function ask(path: string, init?: RequestInit): Promise<Response | undefined> {
    try {
      return await io.send(`/_depthcue/api/${path}`, { cache: "no-store", headers, ...init });
    } catch {
      refuse(NO_SERVER);
      return undefined;
    }
  }
  const messageOf = async (response: Response) => {
    try {
      const answer = (await response.json()) as { message?: unknown };
      if (typeof answer.message === "string") return answer.message;
    } catch {
      // Not JSON: the status says enough.
    }
    return `The server answered ${response.status}.`;
  };

  /** Writes what is in the form. Gives false, with the reason shown, when the server did not take it. */
  async function saveNow(): Promise<boolean> {
    problem.textContent = "";
    const response = await ask("controller", { method: "POST", body: JSON.stringify(settingsNow()) });
    if (!response) return false;
    if (!response.ok) {
      refuse(await messageOf(response));
      return false;
    }
    show((await response.json()) as ControllerState);
    return true;
  }

  const working = (on: boolean) => {
    busy = on;
    save.disabled = on;
    start.disabled = on || !state?.canStart;
    for (const control of [save, start]) {
      if (on) control.setAttribute("aria-busy", "true");
      else control.removeAttribute("aria-busy");
    }
  };

  save.addEventListener("click", async () => {
    if (busy) return;
    working(true);
    if (await saveNow()) status.textContent = "Saved. It applies the next time the session starts.";
    working(false);
  });
  start.addEventListener("click", async () => {
    if (busy) return;
    working(true);
    status.replaceChildren();
    if (await saveNow()) {
      const response = await ask("controller/start", { method: "POST", body: "{}" });
      if (response?.ok) status.textContent = "A terminal is opening. Confirm the channel there.";
      else if (response) refuse(await messageOf(response));
    }
    working(false);
  });
  copy.addEventListener("click", async () => {
    problem.textContent = "";
    // The command is shown as it is saved; what is in the form but not saved is not in it yet.
    const text = command.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Copied.";
    } catch {
      status.textContent = "Select the command above and copy it.";
    }
  });

  const finish = () => {
    if (!element.isConnected) return;
    if (element.open && typeof element.close === "function") element.close();
    element.remove();
    back?.focus({ preventScroll: true });
  };
  close.addEventListener("click", finish);
  element.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  element.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
    }
  });
  root.append(element);
  if (typeof element.showModal === "function") element.showModal();
  else element.setAttribute("open", "");
  start.disabled = true;
  status.textContent = "Loading…";
  model.focus();

  void (async () => {
    const response = await ask("controller");
    if (!element.isConnected) return;
    status.replaceChildren();
    if (!response) return;
    if (!response.ok) return refuse(await messageOf(response));
    show((await response.json()) as ControllerState);
  })();
}
