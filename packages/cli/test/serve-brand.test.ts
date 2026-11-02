import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookOf, type PageLook, pageLook } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDeck } from "../src/deck-api.ts";
import { type RunningServer, startServer } from "../src/serve.ts";

const branded = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));
const plain = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

let root: string;
let folder: string;
let server: RunningServer | undefined;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(path: string, port = server?.port): Promise<Answer> {
  return new Promise((resolveAnswer, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}` } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolveAnswer({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function editJson(path: string, change: (json: Record<string, any>) => void): void {
  const json = JSON.parse(readFileSync(path, "utf8"));
  change(json);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

async function serve(deck: string) {
  const playerDir = join(root, "player");
  mkdirSync(playerDir, { recursive: true });
  writeFileSync(join(playerDir, "app.js"), "export {};");
  writeFileSync(join(playerDir, "player.css"), "body{}");
  server = await startServer({ folder: deck, playerDir, port: 0 });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-serve-brand-"));
  folder = join(root, "deck");
  cpSync(branded, folder, { recursive: true });
  writeFileSync(join(root, "secret.txt"), "outside the deck folder");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("/look.json", () => {
  it("is the deck's look as core works it out, cut to what the page reads, with the brand's faces, chrome and templates", async () => {
    await serve(folder);
    const answer = await get("/look.json");
    expect(answer.status).toBe(200);
    expect(String(answer.headers["content-type"])).toContain("application/json");
    const look = JSON.parse(answer.body) as PageLook;
    const opened = openDeck(folder);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(look).toEqual(JSON.parse(JSON.stringify(pageLook(lookOf(opened.doc)))));
    expect(look.colors.action).toBe("#0B6E6E");
    expect(look.faces?.display.family).toBe("Harbor Display");
    expect(look.chrome?.logo?.path).toBe("brand/logos/harbor.svg");
    expect(Object.keys(look.templates).sort()).toEqual(["chart-and-note", "cover"]);
  });

  it("leaves out what the page does not read: names, descriptions, hints, accepted kinds, limits and required marks", async () => {
    await serve(folder);
    const answer = await get("/look.json");
    const look = JSON.parse(answer.body) as PageLook;
    const cover = look.templates.cover;
    expect(cover?.slots.map((slot) => slot.id)).toEqual(["kicker", "title", "byline"]);
    // What it draws with is there: the background, the chrome, and each slot's role, frame and alignment.
    expect(cover?.background).toEqual({ color: "action" });
    expect(cover?.chrome).toBe("none");
    expect(cover?.slots[1]).toEqual({
      id: "title",
      role: "title",
      frame: { x: 8, y: 30, w: 84, h: 30 },
      valign: "bottom",
    });
    for (const word of ["description", "hint", "accepts", "required", '"name"']) {
      expect(answer.body, word).not.toContain(word);
    }
    // And the styles keep their looks without their names or the kinds of block they are for.
    const styles = Object.values(look.styles);
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) expect(Object.keys(style)).not.toEqual(expect.arrayContaining(["name"]));
    expect(look.styles["quiet-panel"]).toMatchObject({
      fill: "surface",
      border: "line",
      radius: "m",
      pad: "m",
    });
  });

  it("is a look for a deck with no brand too, without chrome or faces", async () => {
    await serve(plain);
    const look = JSON.parse((await get("/look.json")).body) as PageLook;
    expect(look.colors.bg).toMatch(/^#/);
    expect(look.faces).toBeUndefined();
    expect(look.chrome).toBeUndefined();
  });

  it("is not there for a deck that has never had a sound deck.json and brand, so the page draws it from deck.json alone", async () => {
    writeFileSync(join(folder, "brand", "brand.json"), "{ not json");
    await serve(folder);
    expect((await get("/look.json")).status).toBe(404);
    expect((await get("/deck.json")).status).toBe(200);
  });

  it("keeps the brand when a scene has an error: the cover and section slides still get their look", async () => {
    // A title in the ink color on the cover's teal is 2.99:1, under the 3:1 the check wants: an error in a scene.
    editJson(join(folder, "scenes", "welcome.json"), (scene) => {
      scene.blocks[1].tone = "text";
    });
    const opened = openDeck(folder);
    expect(opened.ok).toBe(false);
    expect(opened.diagnostics.some((d) => d.severity === "error" && d.file === "scenes/welcome.json")).toBe(
      true,
    );
    await serve(folder);
    const answer = await get("/look.json");
    expect(answer.status).toBe(200);
    const look = JSON.parse(answer.body) as PageLook;
    expect(look.colors.action).toBe("#0B6E6E");
    expect(look.faces?.display.family).toBe("Harbor Display");
    expect(Object.keys(look.templates).sort()).toEqual(["chart-and-note", "cover"]);
  });

  it.each([
    [
      "a scene file that is not JSON",
      (dir: string) => writeFileSync(join(dir, "scenes", "growth.json"), "{ not json"),
    ],
    ["a scene file that is gone", (dir: string) => rmSync(join(dir, "scenes", "growth.json"))],
    [
      "a scene that names a template the deck does not have",
      (dir: string) => editJson(join(dir, "scenes", "growth.json"), (scene) => (scene.template = "nowhere")),
    ],
  ])("keeps the brand when there is %s", async (_what, break_) => {
    break_(folder);
    expect(openDeck(folder).ok).toBe(false);
    await serve(folder);
    const answer = await get("/look.json");
    expect(answer.status).toBe(200);
    const look = JSON.parse(answer.body) as PageLook;
    expect(look.faces?.display.family).toBe("Harbor Display");
    // The scenes that read still name their templates.
    expect(look.templates.cover).toBeDefined();
  });

  it("serves the last good look while the brand is broken, and the new one when it is mended", async () => {
    await serve(folder);
    const good = (await get("/look.json")).body;
    const brandFile = join(folder, "brand", "brand.json");
    const original = readFileSync(brandFile, "utf8");
    // Half-way through an edit: the file is not JSON, then it is JSON that is not a brand.
    writeFileSync(brandFile, "{ not json");
    expect(await get("/look.json")).toMatchObject({ status: 200, body: good });
    writeFileSync(brandFile, JSON.stringify({ schemaVersion: "0.4", id: "harbor", name: 7 }));
    expect(await get("/look.json")).toMatchObject({ status: 200, body: good });
    writeFileSync(brandFile, original.replace("#0B6E6E", "#0A5C5C"));
    const mended = JSON.parse((await get("/look.json")).body) as PageLook;
    expect(mended.colors.action).toBe("#0A5C5C");
    // A template file that is broken stops the look the same way.
    writeFileSync(join(folder, "brand", "templates", "cover.json"), "{ not json");
    expect(JSON.parse((await get("/look.json")).body)).toEqual(mended);
  });

  it("serves the last good look while deck.json is broken", async () => {
    await serve(folder);
    const good = (await get("/look.json")).body;
    writeFileSync(join(folder, "deck.json"), "{ not json");
    expect(await get("/look.json")).toMatchObject({ status: 200, body: good });
  });

  it("follows the files: a changed brand colour is in the next answer", async () => {
    await serve(folder);
    const before = JSON.parse((await get("/look.json")).body) as PageLook;
    const brandFile = join(folder, "brand", "brand.json");
    writeFileSync(brandFile, readFileSync(brandFile, "utf8").replace("#0B6E6E", "#0A5C5C"));
    const after = JSON.parse((await get("/look.json")).body) as PageLook;
    expect(before.colors.action).toBe("#0B6E6E");
    expect(after.colors.action).toBe("#0A5C5C");
  });
});

describe("/brand/", () => {
  it("serves the brand's fonts, logos and images, sandboxed, with their types", async () => {
    mkdirSync(join(folder, "brand", "images"), { recursive: true });
    writeFileSync(join(folder, "brand", "images", "hero.png"), "png");
    await serve(folder);
    const font = await get("/brand/fonts/HarborSans-Regular.woff2");
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect(String(font.headers["content-security-policy"])).toContain("sandbox");
    const logo = await get("/brand/logos/harbor.svg");
    expect(logo.status).toBe(200);
    expect(String(logo.headers["content-type"])).toContain("image/svg+xml");
    expect(String(logo.headers["content-security-policy"])).toContain("sandbox");
    expect((await get("/brand/images/hero.png")).status).toBe(200);
  });

  it.each([
    "/brand/brand.json",
    "/brand/templates/cover.json",
    "/brand/templates/",
    "/brand/fonts/OFL.txt",
    "/brand/fonts/",
    "/brand/fonts/missing.woff2",
    "/brand/logos/harbor.svg/extra",
    "/brand/",
    "/brand",
  ])("does not serve %s", async (path) => {
    await serve(folder);
    expect((await get(path)).status).toBe(404);
  });

  it.each([
    "/brand/fonts/..%2fbrand.json",
    "/brand/fonts/..%2f..%2fdeck.json",
    "/brand/fonts/..%2f..%2f..%2fsecret.txt",
    "/brand/logos/%2e%2e%2f%2e%2e%2fdeck.json",
    "/brand/fonts/..%5c..%5cdeck.json",
    "/brand/fonts/HarborSans-Regular.woff2%00.txt",
  ])("does not let %s climb out of the brand folder", async (path) => {
    await serve(folder);
    const answer = await get(path);
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("outside the deck folder");
    expect(answer.body).not.toContain("brand-contracts");
  });

  // The server decodes a path before it looks at it, so "..%2f" is a ".." and "%5c" a backslash, which is a separator on
  // Windows. Each lands inside brand/ and so passes the check of the folder, but leaves the subfolder the kind of file is
  // tied to: a picture's folder cannot hand out the templates' or a stray file of brand/.
  describe("does not let an encoded way up leave the subfolder a kind of file is tied to", () => {
    beforeEach(() => {
      mkdirSync(join(folder, "brand", "images"), { recursive: true });
      writeFileSync(join(folder, "brand", "images", "hero.png"), "png");
      writeFileSync(join(folder, "brand", "notes.png"), "a picture the page has no business with");
      writeFileSync(join(folder, "brand", "templates", "draft.svg"), "<svg/>");
      writeFileSync(join(folder, "brand", "fonts", "stray.woff2"), "font");
    });

    it.each([
      "/brand/images/..%2fnotes.png",
      "/brand/images/..%2Fnotes.png",
      "/brand/images/%2e%2e%2fnotes.png",
      "/brand/images/..%5cnotes.png",
      "/brand/images/..%5Cnotes.png",
      "/brand/images/%2e%2e%5cnotes.png",
      "/brand/logos/..%2ftemplates%2fdraft.svg",
      "/brand/logos/..%5ctemplates%5cdraft.svg",
      "/brand/logos/%2e%2e%2ftemplates%2fdraft.svg",
      "/brand/logos/harbor.svg%00.png",
      "/brand/images/hero.png%00",
      "/brand/images/.%2fhero.png",
      "/brand/images/%2e%2fhero.png",
      "/brand/images%2f%2fhero.png",
      "/brand/images%5chero.png",
      "/brand/fonts%2f..%2fimages%2fhero.png",
      "/brand/fonts/..%2fimages%2fhero.png",
      "/brand/fonts/images%2f..%2f..%2ffonts%2fstray.woff2",
    ])("%s", async (path) => {
      await serve(folder);
      const answer = await get(path);
      expect(answer.status).toBe(404);
      expect(answer.body).not.toContain("a picture the page has no business with");
      expect(answer.body).not.toContain("<svg/>");
    });

    it("still serves the same files by their plain paths", async () => {
      await serve(folder);
      expect((await get("/brand/images/hero.png")).status).toBe(200);
      expect((await get("/brand/logos/harbor.svg")).status).toBe(200);
      // An encoded separator that makes the same plain path is the same file, not a way up.
      expect((await get("/brand/images%2fhero.png")).status).toBe(200);
    });
  });

  it("does not follow a symlink out of the brand folder", async (ctx) => {
    try {
      symlinkSync(join(root, "secret.txt"), join(folder, "brand", "fonts", "link.woff2"));
    } catch {
      // Creating a symlink needs a privilege on some Windows setups, and the check cannot be run without one: skipped,
      // not passed.
      return ctx.skip();
    }
    expect(existsSync(join(folder, "brand", "fonts", "link.woff2"))).toBe(true);
    await serve(folder);
    const answer = await get("/brand/fonts/link.woff2");
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("outside the deck folder");
  });
});

describe("live reload of the brand", () => {
  it("pushes a change event when a file under brand/ is written", async () => {
    await serve(folder);
    const port = server?.port;
    const events = await new Promise<string>((resolveEvents, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/_depthcue/events", headers: { Host: `127.0.0.1:${port}` } },
        (response) => {
          let seen = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            seen += chunk;
            if (seen.includes("event: change")) {
              req.destroy();
              resolveEvents(seen);
            }
          });
        },
      );
      req.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      req.end();
      setTimeout(() => writeFileSync(join(folder, "brand", "logos", "harbor.svg"), "<svg/>"), 150);
      setTimeout(() => reject(new Error("no change event within 5 s")), 5000);
    });
    expect(events).toContain("event: change");
  });
});
