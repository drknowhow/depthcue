import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Io } from "./report.ts";

const PACKAGE = "depthcue";
const LATEST_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;

/** The version of the installed package. A checkout that is not a release says 0.0.0. */
export function installedVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  return typeof manifest.version === "string" ? manifest.version : "0.0.0";
}

/** Negative when `a` is older than `b`, positive when newer, zero when the same. A pre-release is older than its release. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => {
    const [core = "", pre] = version.split("-", 2);
    return { numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const x = parts(a);
  const y = parts(b);
  for (let at = 0; at < 3; at++) {
    const difference = (x.numbers[at] ?? 0) - (y.numbers[at] ?? 0);
    if (difference !== 0) return difference;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** What `upgrade` needs from outside, so a test can stand in for the network and for npm. */
export interface UpgradeDeps {
  installed: () => string;
  latest: () => Promise<string>;
  /** Runs `npm install -g depthcue@latest` and returns its exit code. */
  install: () => number;
}

export const realDeps: UpgradeDeps = {
  installed: installedVersion,
  async latest() {
    const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`the npm registry answered ${response.status}`);
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string") throw new Error("the npm registry sent no version");
    return body.version;
  },
  install() {
    const result = spawnSync("npm", ["install", "-g", `${PACKAGE}@latest`], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return result.status ?? 1;
  },
};

/**
 * `depthcue upgrade`: says whether a newer version is on npm. With `--yes` it installs it; without, it prints the
 * command, because replacing the files of a program that is running (or of an MCP server another program holds open,
 * which Windows locks) is the person's call.
 */
export async function upgradeCommand(yes: boolean, io: Io, deps: UpgradeDeps = realDeps): Promise<number> {
  const current = deps.installed();
  let latest: string;
  try {
    latest = await deps.latest();
  } catch (error) {
    io.err(
      `Could not look up the latest version: ${(error as Error).message}. Check the network and try again.`,
    );
    return 2;
  }
  if (current === "0.0.0") {
    io.out(`This is a checkout, not an installed release. The latest release is ${latest}.`);
    return 0;
  }
  if (compareVersions(current, latest) >= 0) {
    io.out(`depthcue ${current} is up to date.`);
    return 0;
  }
  io.out(`depthcue ${current} is installed; ${latest} is available.`);
  if (!yes) {
    io.out(`Run: npm install -g ${PACKAGE}@latest\nOr run: depthcue upgrade --yes`);
    return 0;
  }
  io.out("Close any running depthcue edit or depthcue-mcp first; on Windows they hold their files open.");
  const code = deps.install();
  if (code !== 0) {
    io.err(`npm exited ${code}, so depthcue was not upgraded.`);
    return 2;
  }
  io.out(`Installed ${PACKAGE}@latest.`);
  return 0;
}
