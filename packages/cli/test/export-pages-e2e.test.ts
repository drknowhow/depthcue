import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderHtmlZip, renderPdf } from "../src/export-pages.ts";
import { renderPptx } from "../src/pptx/index.ts";
import { launchBrowser } from "../src/render.ts";
import { builtPlayerDir, builtStandaloneDir, HTML_ROUTE, PDF_ROUTE, startServer } from "../src/serve.ts";

/**
 * The editor's Export button against the real player: the PDF, the zipped page and the PowerPoint file with comments,
 * each made from a copy of the demo deck that has a speaker note on its first scene and two comments.
 */

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

const COMMENTS = {
  format: "depthcue-comments/1",
  comments: [
    {
      id: "c1",
      scene: "opening",
      block: "opening-title",
      anchor: { x: 0.5, y: 0.5 },
      thread: [
        { author: "you", text: "Shorter <title>?", at: "2026-11-01T10:00:00Z" },
        { author: "agent", text: "Done & dusted.", at: "2026-11-01T10:01:00Z" },
      ],
      resolved: false,
    },
    {
      id: "c2",
      scene: "demand",
      block: "demand-chart",
      anchor: { x: 0.2, y: 0.4 },
      thread: [{ author: "agent", text: "Is this the right year?", at: "2026-11-01T10:02:00Z" }],
      resolved: true,
    },
  ],
};

let skipReason: string | undefined;
let root: string;
let folder: string;

beforeAll(async () => {
  try {
    if (!existsSync(join(builtStandaloneDir(), "depthcue.js"))) throw new Error("The player is not built.");
    await (await launchBrowser()).close();
  } catch (error) {
    if (process.env.CI) throw error;
    skipReason = (error as Error).message;
    return;
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-pages-e2e-"));
  folder = join(root, "demo");
  cpSync(demo, folder, { recursive: true });
  writeFileSync(join(folder, "comments.json"), `${JSON.stringify(COMMENTS, null, 2)}\n`);
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const ready = (test: { skip(): void }) => {
  if (skipReason !== undefined) test.skip();
};

describe("the PDF", () => {
  it("is a PDF with a page for each scene", async (test) => {
    ready(test);
    const result = await renderPdf({ folder });
    if (!result.ok) throw new Error("the deck has errors");
    expect(result.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.summary).toEqual({
      scenes: JSON.parse(readFileSync(join(folder, "deck.json"), "utf8")).scenes.length,
      notes: true,
      comments: undefined,
    });
  }, 120_000);

  it("is longer with the comments than without", async (test) => {
    ready(test);
    const plain = await renderPdf({ folder, notes: false });
    const full = await renderPdf({ folder, comments: true });
    if (!plain.ok || !full.ok) throw new Error("the deck has errors");
    expect(full.summary.comments).toBe(2);
    expect(full.bytes.length).toBeGreaterThan(plain.bytes.length);
  }, 120_000);
});

describe("the zipped page", () => {
  it("holds the page, and the comments only when asked", async (test) => {
    ready(test);
    const without = await renderHtmlZip({ folder });
    const withComments = await renderHtmlZip({ folder, comments: true });
    if (!without.ok || !withComments.ok) throw new Error("the deck has errors");
    const names = async (bytes: Buffer) => Object.keys((await JSZip.loadAsync(bytes)).files);
    const plain = await names(without.bytes);
    expect(plain).toContain("demo-export/index.html");
    expect(plain.some((name) => name.endsWith("comments.html") || name.endsWith("comments.json"))).toBe(
      false,
    );
    const full = await JSZip.loadAsync(withComments.bytes);
    const page = await full.file("demo-export/comments.html")?.async("string");
    expect(page).toContain("Shorter &lt;title&gt;?");
    expect(page).toContain("Done &amp; dusted.");
    expect(page).toContain("resolved");
    expect(await full.file("demo-export/index.html")?.async("string")).not.toContain("Shorter");
  });

  it("leaves the speaker notes out when told to", async (test) => {
    ready(test);
    const result = await renderHtmlZip({ folder, notes: false });
    if (!result.ok) throw new Error("the deck has errors");
    const zip = await JSZip.loadAsync(result.bytes);
    expect(await zip.file("demo-export/index.html")?.async("string")).not.toContain("Open with the answer");
  });
});

describe("PowerPoint comments", () => {
  it("writes one classic comment for each message, linked from the slide", async (test) => {
    ready(test);
    const result = await renderPptx({
      folder,
      out: join(root, "demo.pptx"),
      comments: true,
    });
    if (!result.ok) throw new Error("the deck has errors");
    expect(result.summary.comments).toBe(3);
    const zip = await JSZip.loadAsync(result.bytes);
    const first = (await zip.file("ppt/comments/comment1.xml")?.async("string")) ?? "";
    expect(first).toContain("opening-title: Shorter &lt;title&gt;?");
    expect(first).toContain("Done &amp; dusted.");
    expect(first.match(/<p:cm /g)).toHaveLength(2);
    expect(await zip.file("ppt/comments/comment2.xml")?.async("string")).toContain(
      "[Resolved] demand-chart:",
    );
    expect(await zip.file("ppt/slides/_rels/slide1.xml.rels")?.async("string")).toContain(
      "comments/comment1.xml",
    );
    expect(await zip.file("[Content_Types].xml")?.async("string")).toContain("commentAuthors+xml");
  }, 120_000);

  it("writes none unless asked", async (test) => {
    ready(test);
    const result = await renderPptx({ folder, out: join(root, "plain.pptx") });
    if (!result.ok) throw new Error("the deck has errors");
    expect(result.summary.comments).toBeUndefined();
    expect(Object.keys((await JSZip.loadAsync(result.bytes)).files).some((n) => n.includes("comment"))).toBe(
      false,
    );
  }, 120_000);
});

describe("the export calls on the live server", () => {
  async function post(path: string, body: string, token?: string) {
    const editor = join(root, "editor");
    mkdirSync(editor, { recursive: true });
    const server = await startServer({ folder, playerDir: builtPlayerDir(), editorDir: editor, port: 0 });
    try {
      return await new Promise<{
        status: number;
        type: string | undefined;
        disposition: string | undefined;
        bytes: Buffer;
      }>((done, fail) => {
        const call = request(
          {
            host: "127.0.0.1",
            port: server.port,
            path,
            method: "POST",
            headers: {
              "X-Depthcue-Token": token ?? (server.token as string),
              "Content-Type": "application/json",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              done({
                status: response.statusCode ?? 0,
                type: response.headers["content-type"],
                disposition: response.headers["content-disposition"],
                bytes: Buffer.concat(chunks),
              }),
            );
          },
        );
        call.on("error", fail);
        call.end(body);
      });
    } finally {
      await server.close();
    }
  }

  it("sends a PDF named for the deck folder", async (test) => {
    ready(test);
    const reply = await post(PDF_ROUTE, JSON.stringify({ comments: true }));
    expect(reply.status).toBe(200);
    expect(reply.type).toBe("application/pdf");
    expect(reply.disposition).toContain('filename="demo.pdf"');
    expect(reply.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  }, 120_000);

  it("sends the page as a zip", async (test) => {
    ready(test);
    const reply = await post(HTML_ROUTE, "{}");
    expect(reply.status).toBe(200);
    expect(reply.type).toBe("application/zip");
    expect(reply.disposition).toContain('filename="demo-export.zip"');
    expect(Object.keys((await JSZip.loadAsync(reply.bytes)).files)).toContain("demo-export/index.html");
  }, 120_000);

  it("refuses a wrong token, and an option the format does not have", async (test) => {
    ready(test);
    expect((await post(PDF_ROUTE, "{}", "wrong")).status).toBe(403);
    const reply = await post(HTML_ROUTE, JSON.stringify({ pictures: true }));
    expect(reply.status).toBe(400);
    expect(reply.bytes.toString()).toContain('no option \\"pictures\\"');
  });
});
