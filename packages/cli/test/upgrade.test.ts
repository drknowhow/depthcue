import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { compareVersions, installedVersion, type UpgradeDeps, upgradeCommand } from "../src/upgrade.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
}

const deps = (installed: string, latest: string | Error, installs: number[] = []): UpgradeDeps => ({
  installed: () => installed,
  latest: async () => {
    if (latest instanceof Error) throw latest;
    return latest;
  },
  install: () => {
    installs.push(1);
    return 0;
  },
});

describe("compareVersions", () => {
  it("orders by number, not by text, and puts a pre-release before its release", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
  });
});

describe("depthcue --version and --help", () => {
  it("prints the installed version", () => {
    const { io, out } = capture();
    expect(run(["--version"], io)).toBe(0);
    expect(out).toEqual([installedVersion()]);
    expect(run(["-v"], capture().io)).toBe(0);
  });

  it("prints the usage on standard output and succeeds", () => {
    for (const word of ["--help", "-h", "help"]) {
      const { io, out, err } = capture();
      expect(run([word], io)).toBe(0);
      expect(out.join("\n")).toContain("depthcue upgrade [--yes]");
      expect(err).toEqual([]);
    }
  });
});

describe("depthcue upgrade", () => {
  it("says when it is up to date and installs nothing", async () => {
    const installs: number[] = [];
    const { io, out } = capture();
    expect(await upgradeCommand(true, io, deps("0.1.0", "0.1.0", installs))).toBe(0);
    expect(out.join("\n")).toContain("0.1.0 is up to date");
    expect(installs).toEqual([]);
  });

  it("prints the command when behind and --yes was not given", async () => {
    const installs: number[] = [];
    const { io, out } = capture();
    expect(await upgradeCommand(false, io, deps("0.1.0", "0.2.0", installs))).toBe(0);
    expect(out.join("\n")).toContain("0.2.0 is available");
    expect(out.join("\n")).toContain("npm install -g depthcue@latest");
    expect(installs).toEqual([]);
  });

  it("installs with --yes", async () => {
    const installs: number[] = [];
    expect(await upgradeCommand(true, capture().io, deps("0.1.0", "0.2.0", installs))).toBe(0);
    expect(installs).toHaveLength(1);
  });

  it("does not touch a checkout", async () => {
    const installs: number[] = [];
    const { io, out } = capture();
    expect(await upgradeCommand(true, io, deps("0.0.0", "0.2.0", installs))).toBe(0);
    expect(out.join("\n")).toContain("checkout");
    expect(installs).toEqual([]);
  });

  it("exits 2 and says why when the registry cannot be reached", async () => {
    const { io, err } = capture();
    expect(await upgradeCommand(false, io, deps("0.1.0", new Error("offline")))).toBe(2);
    expect(err.join("\n")).toContain("offline");
  });

  it("refuses arguments and a --yes on another command", async () => {
    expect(await run(["upgrade", "extra"], capture().io)).toBe(2);
    expect(await run(["check", "somewhere", "--yes"], capture().io)).toBe(2);
  });
});
