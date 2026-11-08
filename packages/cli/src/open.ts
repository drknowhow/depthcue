/** `depthcue open`, `register` and `unregister`: the editor for a deck's .dcue file, and the Windows file type. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDeckFiles } from "@depthcue/core";
import { DCUE_EXTENSION, deckFolderOf } from "./dcue.ts";
import { readLink, writeLink } from "./link.ts";
import { loadDeckDir } from "./loader.ts";
import { count, type Io, report } from "./report.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "./serve.ts";

/** The ports `open` tries in turn when none is given: the editor's own first, since its drafts are kept per port. */
const PORTS = [4173, 4174, 4175, 4176, 4177, 4178, 4179, 4180, 4181, 4182, 0];

/** Opens a page in the person's own browser. Nothing waits for it, and a browser that does not start is no error. */
export function openInBrowser(url: string): void {
  const [program, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(program, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The address is printed, so the person can still open it.
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The address of an editor that is open on this folder now, if there is one. A player-only `serve` is not one. */
export async function runningEditor(folder: string): Promise<string | undefined> {
  const link = readLink(folder);
  if (link === undefined || !alive(link.pid)) return undefined;
  try {
    const answer = await fetch(link.url, { signal: AbortSignal.timeout(1500) });
    return answer.ok && (await answer.text()).includes('name="depthcue-token"') ? link.url : undefined;
  } catch {
    return undefined;
  }
}

export interface OpenOptions {
  /** A .dcue file, a deck folder or its deck.json. */
  path: string;
  /** The port to use. Without one, 4173 and then the next free one. */
  port?: number;
  /** Open the editor in the browser. */
  browser: boolean;
  /** Opens the page. For tests; by default the person's browser. */
  browse?: (url: string) => void;
  /** Settles when the editor should stop. For tests; by default Ctrl+C, or the window closing. */
  stop?: Promise<unknown>;
}

const stopSignal = (): Promise<void> =>
  new Promise((done) => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => done());
  });

/**
 * `depthcue open`: the editor for a deck, in the browser. When an editor is open on the deck already, its page is
 * opened again and nothing new starts, so double-clicking the file twice gives one editor.
 */
export async function openCommand(options: OpenOptions, io: Io): Promise<number> {
  const deck = deckFolderOf(options.path);
  if (!deck.ok) {
    io.err(deck.message);
    return 2;
  }
  const folder = realpathSync(deck.folder);
  const browse = options.browse ?? openInBrowser;
  const running = await runningEditor(folder);
  if (running !== undefined) {
    io.out(`The editor for ${folder} is open already, at ${running}.`);
    if (options.browser) browse(running);
    return 0;
  }

  const diagnostics = checkDeckFiles(loadDeckDir(folder));
  if (count(diagnostics, "error") > 0) {
    report(io, diagnostics, false);
    io.err("The editor needs a deck that passes `depthcue check`. Fix these first.");
    return 1;
  }
  const playerDir = builtPlayerDir();
  const editorDir = builtEditorDir();
  if (!existsSync(join(playerDir, "app.js")) || !existsSync(join(editorDir, "editor.js"))) {
    io.err("The player or the editor is not built. Run `pnpm build` first.");
    return 2;
  }

  let server: RunningServer | undefined;
  for (const port of options.port === undefined ? PORTS : [options.port]) {
    try {
      server = await startServer({ folder, playerDir, port, editorDir });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  if (server === undefined) {
    io.err(`Port ${options.port} is in use. Pick another with --port, or leave it out to take a free one.`);
    return 2;
  }
  const unlink = writeLink(folder, { url: server.url, token: server.agentToken, pid: process.pid });
  process.title = `Depthcue - ${basename(folder)}`;
  io.out(`Editing ${folder} at ${server.url}`);
  io.out("Close this window, or press Ctrl+C, to stop the editor.");
  if (options.browser) browse(server.url);
  try {
    await (options.stop ?? stopSignal());
  } finally {
    unlink();
    await server.close();
  }
  return 0;
}

/** Keeps a window that a double-click opened on screen until the person has read what went wrong. */
export function holdWindow(io: Io): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve();
  io.out("Press Enter to close this window.");
  return new Promise((done) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      done();
    });
  });
}

/** Where Windows keeps the current user's file types. Tests name a key of their own. */
export const CLASSES = "HKCU\\Software\\Classes";
export const PROG_ID = "Depthcue.Deck";

/** The icon .dcue files show: `icons/depthcue.ico` in this package, beside dist/ and src/. */
export const iconPath = (): string => fileURLToPath(new URL("../icons/depthcue.ico", import.meta.url));

export interface Registration {
  /** The Node that runs the command, and the command's own script. */
  node: string;
  main: string;
  icon?: string;
}

/** The registry values that make .dcue files open with `depthcue open`: key, then the default value. */
export function registryValues(registration: Registration, classes = CLASSES): [string, string][] {
  const values: [string, string][] = [
    [`${classes}\\${DCUE_EXTENSION}`, PROG_ID],
    [`${classes}\\${PROG_ID}`, "Depthcue deck"],
    [
      `${classes}\\${PROG_ID}\\shell\\open\\command`,
      `"${registration.node}" "${registration.main}" open "%1" --pause-on-error`,
    ],
  ];
  if (registration.icon !== undefined)
    values.push([`${classes}\\${PROG_ID}\\DefaultIcon`, `"${registration.icon}"`]);
  return values;
}

export type Reg = (args: readonly string[]) => { code: number; out: string };

const regExe: Reg = (args) => {
  const done = spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });
  return { code: done.status ?? 1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
};

export interface RegisterOptions {
  /** Takes the file type away instead. */
  remove: boolean;
  json: boolean;
  /** Seams for tests: the registry tool, where the file types live, and what runs the command. */
  reg?: Reg;
  classes?: string;
  registration?: Registration;
  platform?: NodeJS.Platform;
}

/** The command's script as Windows should run it: the file this process was started with. */
function thisRegistration(): Registration | undefined {
  const script = process.argv[1];
  if (script === undefined || !existsSync(script)) return undefined;
  const icon = iconPath();
  return { node: process.execPath, main: realpathSync(script), ...(existsSync(icon) ? { icon } : {}) };
}

/** `depthcue register` and `depthcue unregister`: the .dcue file type for this Windows user, no administrator needed. */
export function registerCommand(options: RegisterOptions, io: Io): number {
  const done = (ok: boolean, message: string, extra: object = {}): number => {
    if (options.json) io.out(JSON.stringify({ ok, message, ...extra }, null, 2));
    else if (ok) io.out(message);
    else io.err(message);
    return ok ? 0 : 2;
  };
  if ((options.platform ?? process.platform) !== "win32") {
    return done(
      false,
      "register works on Windows for now. On this computer, open a deck with: depthcue open <file.dcue | deck-folder>",
    );
  }
  const reg = options.reg ?? regExe;
  const classes = options.classes ?? CLASSES;

  if (options.remove) {
    // The extension is taken back only while it is still ours; another program may have claimed it since.
    const ext = `${classes}\\${DCUE_EXTENSION}`;
    const ours = reg(["query", ext, "/ve"]);
    const removed: string[] = [];
    if (ours.code === 0 && ours.out.includes(PROG_ID)) {
      if (reg(["delete", ext, "/f"]).code === 0) removed.push(ext);
    }
    const prog = `${classes}\\${PROG_ID}`;
    if (reg(["query", prog]).code === 0 && reg(["delete", prog, "/f"]).code === 0) removed.push(prog);
    return done(
      true,
      removed.length === 0
        ? ".dcue files were not registered; nothing was changed."
        : "Removed the .dcue file type.",
      { removed },
    );
  }

  const registration = options.registration ?? thisRegistration();
  if (registration === undefined) return done(false, "Could not find the depthcue command's own script.");
  const values = registryValues(registration, classes);
  for (const [key, value] of values) {
    const written = reg(["add", key, "/ve", "/d", value, "/f"]);
    if (written.code !== 0) return done(false, `Could not write ${key}: ${written.out.trim()}`);
  }
  if (options.reg === undefined) spawnSync("ie4uinit.exe", ["-show"], { windowsHide: true });
  return done(
    true,
    `Registered .dcue files for this user. Double-clicking one runs: ${values[2]?.[1]}\nRun depthcue register again after moving Node or Depthcue, and depthcue unregister to take it away.`,
    { command: values[2]?.[1] },
  );
}
