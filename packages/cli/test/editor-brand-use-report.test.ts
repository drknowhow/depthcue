import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PptxSummary } from "../src/pptx/index.ts";
import { launchBrowser } from "../src/render.ts";
import {
  builtPlayerDir,
  PPTX_ROUTE,
  REPORT_HEADER,
  REPORT_LIMIT,
  reportHeader,
  startServer,
} from "../src/serve.ts";

/*
 * The report the export call sends with the file, for the editor's Download PowerPoint dialog: one header, without the
 * file's path or any other folder of this computer, and shortened, saying so, when it would be too long for a header.
 */

const harborDeck = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "depthcue-report-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const decode = (header: string) => JSON.parse(decodeURIComponent(header)) as Record<string, unknown>;

/** Every way a folder of this computer could be written in the report: either slash, as a file URL, in any case. */
function pathsIn(text: string, folders: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return folders.flatMap((folder) =>
    [folder, folder.replaceAll("\\", "/"), folder.replaceAll("/", "\\"), pathToFileURL(folder).href].filter(
      (form) => lower.includes(form.toLowerCase()),
    ),
  );
}

function summary(over: Partial<PptxSummary> = {}): PptxSummary {
  return {
    out: join(root, "deck.pptx"),
    scenes: 2,
    bytes: 1234,
    notes: true,
    pictures: false,
    steps: false,
    posters: false,
    layouts: ["Blank"],
    fonts: [{ family: "Harbor Sans", roles: ["text"], embedded: ["regular"], notes: [] }],
    slides: [
      { scene: "one", title: "One", left: [] },
      { scene: "two", title: "Two", left: ['"two-chart": the chart explorer has no PowerPoint form.'] },
    ],
    deck: ["Scene changes: the slides change with no transition."],
    warnings: [],
    ...over,
  };
}

describe("the export call's report header", () => {
  it("is the summary without the file's path, as percent-encoded JSON", () => {
    const sent = decode(reportHeader(summary(), [[join(root, "deck"), "<deck>"]]));
    const { out: _out, ...rest } = summary();
    expect(sent).toEqual(rest);
    expect(sent).not.toHaveProperty("out");
    expect(sent).not.toHaveProperty("shortened");
  });

  it("names no folder of this computer: the deck, the player, beside the deck and home become labels", () => {
    const deck = join(root, "My Deck");
    const player = join(root, "player", "dist");
    const fontFile = join(deck, "brand", "fonts", "x.woff2");
    const home = homedir();
    const sent = reportHeader(
      summary({
        fonts: [
          {
            family: "Harbor Sans",
            roles: ["text"],
            embedded: [],
            notes: [
              `brand/fonts/x.woff2: ENOENT: no such file or directory, open '${fontFile}', so it is not embedded.`,
              `${pathToFileURL(join(player, "fonts", "a.woff2")).href} could not be read.`,
              // Windows does not tell C:\USERS from C:\Users, so neither does the report there.
              ...(process.platform === "win32"
                ? [`${fontFile.replaceAll("\\", "/").toUpperCase()} is upper case.`]
                : []),
            ],
          },
        ],
        deck: [`The file goes beside the deck, in ${join(root, "out.pptx")}.`, `Home is ${join(home, "x")}.`],
        warnings: [{ code: "w", file: "deck.json", path: "", severity: "warning", message: `See ${deck}.` }],
      }),
      [
        [deck, "<deck>"],
        [player, "<player>"],
        [root, "<beside the deck>"],
        [home, "~"],
      ],
    );
    const text = decodeURIComponent(sent);
    expect(pathsIn(text, [deck, player, root, home, tmpdir()])).toEqual([]);
    expect(text).not.toMatch(/\b[A-Za-z]:[\\/]/);
    const report = decode(sent) as unknown as PptxSummary;
    expect(report.fonts[0]?.notes[0]).toContain("open '<deck>");
    expect(report.fonts[0]?.notes[1]).toMatch(/^<player>/);
    expect(report.deck).toEqual([
      `The file goes beside the deck, in <beside the deck>${join("x", "out.pptx").slice(1)}.`,
      `Home is ~${join("x", "x").slice(1)}.`,
    ]);
    expect(report.warnings[0]?.message).toBe("See <deck>.");
  });

  it("keeps the counts and the first lines that fit when it would be over the limit, and says it is shortened", () => {
    const line = (n: number) =>
      `"block-${n}" is ${n} px past the bottom of the slide, and it is cropped there.`;
    const slides = Array.from({ length: 400 }, (_, at) => ({
      scene: `s${at}`,
      title: `Scene ${at}`,
      left: [line(at), line(at + 1000)],
    }));
    const long = summary({ slides, deck: ["every slide"], warnings: [] });
    const whole = reportHeader(long, [], Number.POSITIVE_INFINITY);
    expect(whole.length).toBeGreaterThan(REPORT_LIMIT);
    expect(REPORT_LIMIT).toBe(32 * 1024);

    const sent = reportHeader(long, []);
    expect(sent.length).toBeLessThanOrEqual(REPORT_LIMIT);
    const short = decode(sent) as unknown as PptxSummary & {
      shortened: boolean;
      counts: Record<string, number>;
    };
    expect(short.shortened).toBe(true);
    expect(short.counts).toEqual({ slides: 400, left: 800, deck: 1, fonts: 1, warnings: 0 });
    expect(short.slides.length).toBeGreaterThan(10);
    expect(short.slides.length).toBeLessThan(400);
    // The lines that came are the first ones, whole, in order; only the last slide may have lost some of its own.
    short.slides.forEach((slide, at) => {
      expect(slide.title).toBe(`Scene ${at}`);
      const want = at < short.slides.length - 1 ? [line(at), line(at + 1000)] : slide.left;
      expect(slide.left).toEqual(want);
    });
    expect(short.deck).toEqual([]);
    // It is filled: what is left is less than one more line.
    expect(sent.length).toBeGreaterThan(
      REPORT_LIMIT - encodeURIComponent(JSON.stringify(line(9999))).length - 64,
    );
  });
});

describe("the export call on the live server", () => {
  it("sends the report with the file, same origin only, with no path of this computer in it", async (test) => {
    if (!existsSync(join(builtPlayerDir(), "app.js"))) {
      if (process.env.CI) throw new Error("The player is not built.");
      return test.skip();
    }
    try {
      await (await launchBrowser()).close();
    } catch (error) {
      if (process.env.CI) throw error;
      return test.skip();
    }
    const deck = join(root, "harbor");
    cpSync(harborDeck, deck, { recursive: true });
    const editor = join(root, "editor");
    mkdirSync(editor);
    const server = await startServer({
      folder: deck,
      playerDir: builtPlayerDir(),
      editorDir: editor,
      port: 0,
    });
    let reply: { status: number; headers: Record<string, string | string[] | undefined> };
    try {
      reply = await new Promise((done, fail) => {
        const call = request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: PPTX_ROUTE,
            method: "POST",
            headers: { "X-Depthcue-Token": server.token as string, "Content-Type": "application/json" },
          },
          (response) => {
            response.resume();
            response.on("end", () => done({ status: response.statusCode ?? 0, headers: response.headers }));
          },
        );
        call.on("error", fail);
        call.end("{}");
      });
    } finally {
      await server.close();
    }
    expect(reply.status).toBe(200);
    const header = reply.headers[REPORT_HEADER.toLowerCase()];
    expect(typeof header).toBe("string");
    expect((header as string).length).toBeLessThanOrEqual(REPORT_LIMIT);
    // No header lets another origin read it.
    expect(Object.keys(reply.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
    const text = decodeURIComponent(header as string);
    expect(pathsIn(text, [deck, dirname(deck), builtPlayerDir(), homedir(), tmpdir()])).toEqual([]);
    expect(text).not.toMatch(/\b[A-Za-z]:[\\/]/);
    const report = decode(header as string) as unknown as PptxSummary;
    expect(report).not.toHaveProperty("out");
    expect(report.slides.length).toBeGreaterThan(0);
    expect(report.fonts.some((font) => font.embedded.length > 0)).toBe(true);
  }, 180_000);
});
