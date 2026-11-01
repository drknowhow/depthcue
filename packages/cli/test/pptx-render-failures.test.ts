import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index.ts";
import { LIMITS } from "../src/pptx/index.ts";
import { builtStandaloneDir } from "../src/serve.ts";

/**
 * A browser that is not one: it does what the test says at each step the export takes, so a page that fails or never
 * answers can be had without waiting for a real one to. It fails every call still waiting when it is closed, as the
 * real one does.
 */
interface Behaviour {
  goto?: () => Promise<void>;
  settled?: () => Promise<unknown>;
  measure?: () => Promise<unknown>;
}

const fake = vi.hoisted(() => ({
  behaviour: {} as Behaviour,
  closed: false,
  waiting: [] as Array<(error: Error) => void>,
}));

vi.mock("../src/render.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/render.ts")>();
  const answer = (work: (() => Promise<unknown>) | undefined) =>
    new Promise<unknown>((resolve, reject) => {
      fake.waiting.push(reject);
      (work ?? (async () => undefined))().then(resolve, reject);
    });
  return {
    ...original,
    launchBrowser: async () => ({
      newContext: async () => ({
        newPage: async () => {
          let evaluated = 0;
          return {
            on: () => undefined,
            goto: () => answer(fake.behaviour.goto),
            addStyleTag: async () => undefined,
            waitForSelector: async () => undefined,
            // The first evaluation waits for the page to settle; the second measures it.
            evaluate: () => answer(++evaluated === 1 ? fake.behaviour.settled : fake.behaviour.measure),
          };
        },
        close: async () => undefined,
      }),
      close: async () => {
        fake.closed = true;
        for (const reject of fake.waiting.splice(0))
          reject(new Error("Target page, context or browser has been closed"));
      },
    }),
  };
});

const v01 = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

let root: string;
let deck: string;
const limits = { ...LIMITS };

beforeEach(() => {
  if (!existsSync(join(builtStandaloneDir(), "depthcue.js"))) {
    throw new Error("The player is not built. Run pnpm build.");
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-pptx-failures-"));
  deck = join(root, "deck");
  cpSync(v01, deck, { recursive: true });
  fake.behaviour = {};
  fake.closed = false;
  fake.waiting = [];
});

afterEach(() => {
  Object.assign(LIMITS, limits);
  rmSync(root, { recursive: true, force: true });
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

async function exportJson() {
  const { io, lines, errors } = capture();
  const out = join(root, "out.pptx");
  const code = await run(["export", deck, "--format", "pptx", "--out", out, "--json"], io);
  return { code, lines, errors, out };
}

describe("export --format pptx when the page fails", () => {
  it("reports a page that cannot be loaded as render-failed on stdout with --json, and closes the browser", async () => {
    fake.behaviour.goto = () => Promise.reject(new Error("page.goto: Timeout 30000ms exceeded."));
    const { code, lines, errors, out } = await exportJson();
    expect(code).toBe(2);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(1);
    const reported = JSON.parse(lines[0] as string);
    expect(reported).toMatchObject({ ok: false, code: "render-failed" });
    expect(reported.message).toContain("Timeout 30000ms exceeded");
    expect(reported.message).toContain('Scene "');
    expect(fake.closed).toBe(true);
    expect(existsSync(out)).toBe(false);
  });

  it("reports a player that drew no scene as render-failed on stdout with --json", async () => {
    fake.behaviour.measure = () => Promise.reject(new Error("The player did not render a scene."));
    const { code, lines, errors } = await exportJson();
    expect(code).toBe(2);
    expect(errors).toEqual([]);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: false,
      code: "render-failed",
      message: expect.stringContaining("The player did not render a scene."),
    });
    expect(fake.closed).toBe(true);
  });

  it("says the same in words without --json, on stderr", async () => {
    fake.behaviour.measure = () => Promise.reject(new Error("The player did not render a scene."));
    const { io, lines, errors } = capture();
    const code = await run(["export", deck, "--format", "pptx", "--out", join(root, "out.pptx")], io);
    expect(code).toBe(2);
    expect(lines).toEqual([]);
    expect(errors.join("\n")).toContain("The player did not render a scene.");
  });

  it("stops waiting for a page that never settles, closes the browser, and writes nothing", async () => {
    LIMITS.settle = 60;
    fake.behaviour.settled = () => new Promise(() => undefined);
    const { code, lines, out } = await exportJson();
    expect(code).toBe(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: false,
      code: "render-failed",
      message: expect.stringMatching(/The player did not settle scene "[^"]+" within 0\.06 seconds\./),
    });
    expect(fake.closed).toBe(true);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(root)).toEqual(["deck"]);
  }, 10_000);

  it("stops waiting for a page that never finishes measuring, and closes the browser", async () => {
    LIMITS.measure = 60;
    fake.behaviour.measure = () => new Promise(() => undefined);
    const { code, lines } = await exportJson();
    expect(code).toBe(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: false,
      code: "render-failed",
      message: expect.stringMatching(
        /The page did not finish measuring scene "[^"]+" within 0\.06 seconds\./,
      ),
    });
    expect(fake.closed).toBe(true);
  }, 10_000);
});
