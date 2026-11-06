import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDeckFiles } from "@depthcue/core";
import { type ControllerSettings, readController } from "./controller-file.ts";
import { writeLink } from "./link.ts";
import { loadDeckDir } from "./loader.ts";
import { count, type Io, report } from "./report.ts";
import { builtEditorDir, builtPlayerDir, startServer } from "./serve.ts";

/** The name the MCP server goes by in the session, and so in the channel flag. */
const SERVER = "depthcue";

/**
 * The server is a sibling package: `packages/mcp` here, `node_modules/@depthcue/mcp` once installed, and the
 * path from this file's folder is the same in both.
 */
const mcpMain = () => fileURLToPath(new URL("../../mcp/dist/main.js", import.meta.url));

export interface ControlOptions {
  folder: string;
  port: number;
  /** Say what would run and run nothing. */
  print: boolean;
  /** The command that starts Claude Code, so a test can stand in for it. */
  claude: readonly string[];
  /** Said on the command line; they win over the deck's controller.json. */
  settings?: ControllerSettings;
}

/** The command to start Claude Code. DEPTHCUE_CLAUDE names another program, such as a wrapper script. */
export const claudeCommand = (): readonly string[] => [process.env.DEPTHCUE_CLAUDE || "claude"];

/** Claude Code's arguments for a session that has the deck's server and listens to its channel. */
export function claudeArgs(config: string, settings: ControllerSettings = {}): string[] {
  return [
    "--mcp-config",
    config,
    "--dangerously-load-development-channels",
    `server:${SERVER}`,
    ...(settings.model ? ["--model", settings.model] : []),
    ...(settings.effort ? ["--effort", settings.effort] : []),
  ];
}

/** Writes the MCP configuration for one deck folder, where the same folder always gets the same file. */
export function writeConfig(folder: string, main: string): string {
  const dir = join(tmpdir(), "depthcue-control");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${createHash("sha256").update(folder).digest("hex").slice(0, 12)}.json`);
  const config = { mcpServers: { [SERVER]: { command: process.execPath, args: [main, folder] } } };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

const quote = (text: string) => (/[\s"]/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text);

export interface SessionPlan {
  folder: string;
  program: string;
  args: string[];
}

export type Planned = { ok: true; plan: SessionPlan } | { ok: false; message: string };

/** What to run for a deck: the program, its arguments and the folder to run it in. Writes the MCP configuration. */
export function planSession(
  folderPath: string,
  settings: ControllerSettings,
  claude: readonly string[] = claudeCommand(),
): Planned {
  const folder = resolve(folderPath);
  const main = mcpMain();
  if (!existsSync(main))
    return { ok: false, message: "The MCP server is not built. Run `pnpm build` first." };
  const [program, ...front] = claude;
  return {
    ok: true,
    plan: {
      folder,
      program: program as string,
      args: [...front, ...claudeArgs(writeConfig(folder, main), settings)],
    },
  };
}

/** The plan as one line to paste into a terminal in the deck folder. */
export const commandLine = (plan: SessionPlan): string =>
  [plan.program, ...plan.args].map((part) => quote(part)).join(" ");

/** Where a new terminal window can be opened for the person. */
export const canOpenTerminal = (): boolean => process.platform === "win32" || process.platform === "darwin";

export type Started = { ok: true } | { ok: false; message: string };

/**
 * Opens a terminal window in the deck folder and runs the plan in it. The window is the person's: Claude Code needs
 * a terminal to ask them to confirm the channel, and it stays open when the session ends. Nothing here comes from the
 * page except the settings, and those have been checked down to the characters a model name may have.
 */
export function openTerminal(plan: SessionPlan): Started {
  if (!canOpenTerminal()) {
    return {
      ok: false,
      message: "This computer cannot open a terminal from here. Copy the command and run it.",
    };
  }
  const dir = join(tmpdir(), "depthcue-control");
  mkdirSync(dir, { recursive: true });
  const id = `session-${Date.now()}`;
  try {
    if (process.platform === "win32") {
      const q = (text: string) => `"${text.replaceAll("%", "%%")}"`;
      const script = join(dir, `${id}.cmd`);
      writeFileSync(
        script,
        `@echo off\r\ntitle Depthcue controller\r\ncd /d ${q(plan.folder)}\r\n${[plan.program, ...plan.args].map(q).join(" ")}\r\n`,
      );
      const child = spawn("cmd.exe", ["/c", "start", "Depthcue controller", "cmd.exe", "/k", script], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => undefined);
      child.unref();
    } else {
      const q = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
      const script = join(dir, `${id}.command`);
      writeFileSync(
        script,
        `#!/bin/sh\ncd ${q(plan.folder)}\nexec ${[plan.program, ...plan.args].map(q).join(" ")}\n`,
      );
      chmodSync(script, 0o755);
      const child = spawn("open", ["-a", "Terminal", script], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    }
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  return { ok: true };
}

/**
 * Makes this terminal the controller of a deck: the editor runs here, and Claude Code starts beside it with the
 * deck's MCP server and its channel, so what the person does in the editor reaches the session as it happens.
 * When Claude Code ends, so does the editor.
 */
export async function controlCommand(options: ControlOptions, io: Io): Promise<number> {
  const folder = resolve(options.folder);
  const saved = readController(folder);
  if (saved.problem) io.err(`${saved.problem} Starting without its settings.`);
  const planned = planSession(folder, { ...saved.settings, ...options.settings }, options.claude);
  if (!planned.ok) {
    io.err(planned.message);
    return 2;
  }
  const { program, args } = planned.plan;

  if (options.print) {
    io.out(`Editor:  depthcue edit ${quote(folder)}`);
    io.out(`Session: ${commandLine(planned.plan)}`);
    return 0;
  }

  const diagnostics = checkDeckFiles(loadDeckDir(folder));
  const errors = count(diagnostics, "error");
  const playerDir = builtPlayerDir();
  const editorDir = builtEditorDir();
  if (!existsSync(join(playerDir, "app.js")) || !existsSync(join(editorDir, "editor.js"))) {
    io.err("The player or the editor is not built. Run `pnpm build` first.");
    return 2;
  }
  if (errors > 0) {
    report(io, diagnostics, false);
    io.err("The editor needs a deck that passes `depthcue check`. Fix these first.");
    return 1;
  }

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ folder, playerDir, port: options.port, editorDir });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      io.err(`Port ${options.port} is in use. Pick another with --port, or --port 0 for a free one.`);
      return 2;
    }
    throw error;
  }
  const unlink = writeLink(folder, { url: server.url, token: server.agentToken, pid: process.pid });
  io.out(`Editing ${folder} at ${server.url}`);
  io.out(
    "Starting Claude Code with the deck's server and its channel. Claude Code asks you to confirm the channel.",
  );

  try {
    return await new Promise<number>((done) => {
      const child = spawn(program, args, { stdio: "inherit", cwd: folder });
      child.once("error", (error: NodeJS.ErrnoException) => {
        io.err(
          error.code === "ENOENT"
            ? `Could not start "${program}". Install Claude Code, or set DEPTHCUE_CLAUDE to its path.`
            : error.message,
        );
        done(2);
      });
      child.once("exit", (code) => done(code ?? 0));
    });
  } finally {
    unlink();
    await server.close();
  }
}
