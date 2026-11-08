import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DCUE_FORMAT, dcueText, deckFolderOf } from "../src/dcue.ts";
import { run } from "../src/index.ts";
import { readLink } from "../src/link.ts";
import { openCommand, type Reg, registerCommand, registryValues } from "../src/open.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) },
  };
}

function deck(name = "harbor-talk") {
  const root = mkdtempSync(join(tmpdir(), "depthcue-open-"));
  temps.push(root);
  const folder = join(root, name);
  cpSync(demo, folder, { recursive: true });
  return { root, folder };
}

/** A promise with its resolve, so a test says when the editor stops. */
function later() {
  let settle: () => void = () => {};
  const promise = new Promise<void>((done) => {
    settle = done;
  });
  return { promise, settle };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((done) => setTimeout(done, 25));
  expect(check()).toBe(true);
};

describe("the .dcue file", () => {
  it("names the deck folder it sits in, as the folder and its deck.json do", () => {
    const { folder } = deck();
    writeFileSync(join(folder, "harbor-talk.dcue"), dcueText());
    for (const path of [join(folder, "harbor-talk.dcue"), folder, join(folder, "deck.json")]) {
      expect(deckFolderOf(path)).toEqual({ ok: true, folder });
    }
    expect(JSON.parse(dcueText()).format).toBe(DCUE_FORMAT);
  });

  it("refuses a .dcue that is not one, one moved away from its deck, other files and folders with no deck", () => {
    const { root, folder } = deck();
    writeFileSync(join(folder, "empty.dcue"), "");
    expect(deckFolderOf(join(folder, "empty.dcue"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("is not a Depthcue file"),
    });
    writeFileSync(join(root, "moved.dcue"), dcueText());
    expect(deckFolderOf(join(root, "moved.dcue"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("is not beside a deck"),
    });
    expect(deckFolderOf(join(folder, "scenes"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("has no deck.json"),
    });
    writeFileSync(join(folder, "notes.txt"), "mine");
    expect(deckFolderOf(join(folder, "notes.txt"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("is not a deck"),
    });
    expect(deckFolderOf(join(root, "nothing"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("is not there"),
    });
  });

  it("is written by depthcue file once, under the folder's name, and never over one that is there", async () => {
    const { folder } = deck();
    const first = capture();
    expect(await run(["file", folder, "--json"], first.io)).toBe(0);
    expect(JSON.parse(first.lines.join("\n"))).toEqual({
      ok: true,
      file: join(folder, "harbor-talk.dcue"),
      written: true,
    });
    expect(readFileSync(join(folder, "harbor-talk.dcue"), "utf8")).toBe(dcueText());

    writeFileSync(
      join(folder, "harbor-talk.dcue"),
      `${JSON.stringify({ format: DCUE_FORMAT, mine: true })}\n`,
    );
    const again = capture();
    expect(await run(["file", folder], again.io)).toBe(0);
    expect(again.lines[0]).toContain("is there already; nothing was written");
    expect(JSON.parse(readFileSync(join(folder, "harbor-talk.dcue"), "utf8")).mine).toBe(true);
  });

  it("is refused by depthcue file for a folder that is not a deck", async () => {
    const { root } = deck();
    const { io, errors } = capture();
    expect(await run(["file", root], io)).toBe(2);
    expect(errors[0]).toContain("has no deck.json");
  });
});

describe("depthcue open", () => {
  it("starts the editor on the deck a .dcue names, opens it in the browser, and stops when asked", async () => {
    const { folder } = deck();
    writeFileSync(join(folder, "harbor-talk.dcue"), dcueText());
    const opened: string[] = [];
    const stop = later();
    const { io, lines, errors } = capture();
    const running = openCommand(
      {
        path: join(folder, "harbor-talk.dcue"),
        port: 0,
        browser: true,
        browse: (url) => opened.push(url),
        stop: stop.promise,
      },
      io,
    );
    await until(() => opened.length === 1);
    const url = opened[0] as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(lines[0]).toBe(`Editing ${realpathSync(folder)} at ${url}`);
    expect(await (await fetch(url)).text()).toContain('name="depthcue-token"');
    expect(readLink(folder)?.url).toBe(url);

    // A second double-click opens the same editor again and starts nothing.
    const second = capture();
    const reopened: string[] = [];
    expect(
      await openCommand({ path: folder, browser: true, browse: (u) => reopened.push(u) }, second.io),
    ).toBe(0);
    expect(reopened).toEqual([url]);
    expect(second.lines[0]).toContain("is open already");

    stop.settle();
    expect(await running).toBe(0);
    expect(errors).toEqual([]);
    expect(readLink(folder)).toBeUndefined();
  });

  it("takes the next port when 4173 is busy", async () => {
    const { folder } = deck();
    const busy: Server = createServer();
    const held = await new Promise<boolean>((done) => {
      busy.once("error", () => done(false));
      busy.listen(4173, "127.0.0.1", () => done(true));
    });
    const opened: string[] = [];
    const stop = later();
    const running = openCommand(
      { path: folder, browser: true, browse: (url) => opened.push(url), stop: stop.promise },
      capture().io,
    );
    try {
      await until(() => opened.length === 1);
      expect(opened[0]).not.toContain(":4173/");
    } finally {
      stop.settle();
      await running;
      if (held) await new Promise((done) => busy.close(done));
    }
  });

  it("refuses a deck that fails check, and a path that is not a deck, without starting anything", async () => {
    const { folder } = deck();
    writeFileSync(join(folder, "deck.json"), "{ not json");
    const broken = capture();
    expect(await openCommand({ path: folder, port: 0, browser: false }, broken.io)).toBe(1);
    expect(broken.errors.at(-1)).toContain("needs a deck that passes `depthcue check`");
    const missing = capture();
    expect(await run(["open", join(folder, "nope.dcue"), "--pause-on-error"], missing.io)).toBe(2);
    expect(missing.errors[0]).toContain("is not there");
  });

  it.each([
    [["open"], "open needs a .dcue file, a deck folder or its deck.json."],
    [["open", "a", "b"], "Unexpected argument b."],
    [["open", "a", "--json"], "open takes --port, --no-browser and --pause-on-error."],
    [["open", "a", "--force"], "open takes --port, --no-browser and --pause-on-error."],
    [["open", "a", "--out", "b"], "open takes --port, --no-browser and --pause-on-error."],
    [["open", "a", "--port", "x"], "--port needs a whole number from 0 to 65535."],
    [["file"], "file needs a deck folder."],
    [["file", "a", "--no-browser"], "file takes --json."],
    [["register", "a"], "Unexpected argument a."],
    [["unregister", "--port", "3"], "unregister takes --json."],
  ])("refuses %j with exit 2: %s", async (args, message) => {
    const { io, errors, lines } = capture();
    expect(await run(args, io)).toBe(2);
    expect(errors[0]).toContain(message);
    expect(lines).toEqual([]);
  });
});

describe("depthcue register", () => {
  const registration = {
    node: "C:\\Program Files\\nodejs\\node.exe",
    main: "C:\\Tools\\depthcue\\main.js",
    icon: "C:\\Tools\\depthcue.ico",
  };

  it("names the .dcue type, the command that opens it with the file, and its icon", () => {
    expect(registryValues(registration, "HKCU\\T")).toEqual([
      ["HKCU\\T\\.dcue", "Depthcue.Deck"],
      ["HKCU\\T\\Depthcue.Deck", "Depthcue deck"],
      [
        "HKCU\\T\\Depthcue.Deck\\shell\\open\\command",
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Tools\\depthcue\\main.js" open "%1" --pause-on-error',
      ],
      ["HKCU\\T\\Depthcue.Deck\\DefaultIcon", '"C:\\Tools\\depthcue.ico"'],
    ]);
  });

  it("works on Windows only, and says how to open a deck elsewhere", () => {
    const { io, errors } = capture();
    expect(
      registerCommand(
        { remove: false, json: false, platform: "linux", reg: () => ({ code: 0, out: "" }) },
        io,
      ),
    ).toBe(2);
    expect(errors[0]).toContain("depthcue open <file.dcue | deck-folder>");
  });

  it("takes the extension back on unregister only while it still names Depthcue", () => {
    const calls: string[][] = [];
    const reg =
      (answer: string): Reg =>
      (args) => {
        calls.push([...args]);
        return { code: 0, out: args[0] === "query" ? answer : "" };
      };
    const quiet = capture().io;
    registerCommand(
      {
        remove: true,
        json: false,
        platform: "win32",
        classes: "HKCU\\T",
        reg: reg("(Default) REG_SZ Other.App"),
      },
      quiet,
    );
    expect(calls.filter((call) => call[0] === "delete")).toEqual([
      ["delete", "HKCU\\T\\Depthcue.Deck", "/f"],
    ]);
    calls.length = 0;
    registerCommand(
      {
        remove: true,
        json: false,
        platform: "win32",
        classes: "HKCU\\T",
        reg: reg("(Default) REG_SZ Depthcue.Deck"),
      },
      quiet,
    );
    expect(calls.filter((call) => call[0] === "delete")).toEqual([
      ["delete", "HKCU\\T\\.dcue", "/f"],
      ["delete", "HKCU\\T\\Depthcue.Deck", "/f"],
    ]);
  });

  it.runIf(process.platform === "win32")(
    "writes the values with reg.exe as they are, quotes included, and removes them",
    () => {
      const root = `HKCU\\Software\\DepthcueTest-${randomBytes(4).toString("hex")}`;
      const classes = `${root}\\Classes`;
      const query = (key: string) => spawnSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8" });
      try {
        const { io, errors } = capture();
        expect(registerCommand({ remove: false, json: false, classes, registration }, io)).toBe(0);
        expect(errors).toEqual([]);
        expect(query(`${classes}\\Depthcue.Deck\\shell\\open\\command`).stdout).toContain(
          '"C:\\Program Files\\nodejs\\node.exe" "C:\\Tools\\depthcue\\main.js" open "%1" --pause-on-error',
        );
        expect(query(`${classes}\\.dcue`).stdout).toContain("Depthcue.Deck");
        expect(registerCommand({ remove: true, json: false, classes }, capture().io)).toBe(0);
        expect(query(`${classes}\\.dcue`).status).not.toBe(0);
        expect(query(`${classes}\\Depthcue.Deck`).status).not.toBe(0);
      } finally {
        spawnSync("reg.exe", ["delete", root, "/f"]);
      }
    },
  );
});

describe("depthcue new", () => {
  it("writes the .dcue file beside deck.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "depthcue-open-new-"));
    temps.push(root);
    mkdirSync(join(root, "parent"));
    const folder = join(root, "parent", "spring-plan");
    const { io, lines } = capture();
    expect(await run(["new", folder], io)).toBe(0);
    expect(readFileSync(join(folder, "spring-plan.dcue"), "utf8")).toBe(dcueText());
    expect(lines.at(-1)).toBe(
      `Open it by double-clicking spring-plan.dcue (once depthcue register has run), or with: depthcue open ${folder}`,
    );
    expect(deckFolderOf(join(folder, "spring-plan.dcue"))).toEqual({ ok: true, folder });
  });
});
