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
import { type DeckLook, lookOf } from "@depthcue/core";
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
  it("is the deck's look as core works it out, with the brand's faces, chrome and templates", async () => {
    await serve(folder);
    const answer = await get("/look.json");
    expect(answer.status).toBe(200);
    expect(String(answer.headers["content-type"])).toContain("application/json");
    const look = JSON.parse(answer.body) as DeckLook;
    const opened = openDeck(folder);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(look).toEqual(JSON.parse(JSON.stringify(lookOf(opened.doc))));
    expect(look.colors.action).toBe("#0B6E6E");
    expect(look.faces?.display.family).toBe("Harbor Display");
    expect(look.chrome?.logo?.path).toBe("brand/logos/harbor.svg");
    expect(Object.keys(look.templates).sort()).toEqual(["chart-and-note", "cover"]);
  });

  it("is a look for a deck with no brand too, without chrome or faces", async () => {
    await serve(plain);
    const look = JSON.parse((await get("/look.json")).body) as DeckLook;
    expect(look.colors.bg).toMatch(/^#/);
    expect(look.faces).toBeUndefined();
    expect(look.chrome).toBeUndefined();
  });

  it("is not there for a deck with errors, so the page draws it from deck.json alone", async () => {
    writeFileSync(join(folder, "scenes", "growth.json"), "{ not json");
    await serve(folder);
    expect((await get("/look.json")).status).toBe(404);
    expect((await get("/deck.json")).status).toBe(200);
  });

  it("follows the files: a changed brand colour is in the next answer", async () => {
    await serve(folder);
    const before = JSON.parse((await get("/look.json")).body) as DeckLook;
    const brandFile = join(folder, "brand", "brand.json");
    writeFileSync(brandFile, readFileSync(brandFile, "utf8").replace("#0B6E6E", "#0A5C5C"));
    const after = JSON.parse((await get("/look.json")).body) as DeckLook;
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

  it("does not follow a symlink out of the brand folder", async () => {
    try {
      symlinkSync(join(root, "secret.txt"), join(folder, "brand", "fonts", "link.woff2"));
    } catch {
      return; // creating a symlink needs a privilege on some Windows setups; the check itself is the same code
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
