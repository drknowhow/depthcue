import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

let root: string;
let folder: string;
let playerDir: string;
let server: RunningServer;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request, so the path and Host header go out exactly as written (fetch would normalize both). */
function get(path: string, init: { method?: string; host?: string } = {}): Promise<Answer> {
  return new Promise((resolveAnswer, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: init.method ?? "GET",
        headers: { Host: init.host ?? `127.0.0.1:${server.port}` },
      },
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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "depthcue-serve-"));
  folder = join(root, "deck");
  playerDir = join(root, "player");
  cpSync(demo, folder, { recursive: true });
  mkdirSync(playerDir);
  writeFileSync(join(playerDir, "app.js"), "export {};");
  writeFileSync(join(playerDir, "player.css"), "body{}");
  writeFileSync(join(folder, "notes.txt"), "private notes");
  writeFileSync(join(root, "secret.txt"), "outside the deck folder");
  server = await startServer({ folder, playerDir, port: 0 });
});

afterEach(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("what it serves", () => {
  it("serves the shell page with a strict content security policy", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div id="depthcue"');
    const policy = String(page.headers["content-security-policy"]);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("serves the deck manifest, its scenes and its assets", async () => {
    expect((await get("/deck.json")).status).toBe(200);
    const scene = await get("/scenes/demand.json");
    expect(scene.status).toBe(200);
    expect(JSON.parse(scene.body).id).toBe("demand");
    const asset = await get("/assets/report.csv");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/csv");
  });

  it("serves the built player files", async () => {
    const script = await get("/_depthcue/app.js");
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
  });

  it("answers HEAD without a body", async () => {
    const head = await get("/deck.json", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("sandboxes deck files so an svg opened directly cannot run script", async () => {
    const svg = await get("/assets/method.svg");
    expect(svg.status).toBe(200);
    const policy = String(svg.headers["content-security-policy"]);
    expect(policy).toContain("sandbox");
    expect(policy).toContain("default-src 'none'");
    expect(svg.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("what it refuses", () => {
  it.each([
    "/notes.txt",
    "/package.json",
    "/scenes/",
    "/scenes/missing.json",
    "/scenes/demand.json/extra",
    "/scenes/demand.txt",
    "/assets/",
    "/assets/missing.png",
    "/_depthcue/missing.js",
    "/nothing",
  ])("answers 404 for %s", async (path) => {
    expect((await get(path)).status).toBe(404);
  });

  it.each([
    "/assets/..%2fnotes.txt",
    "/assets/..%2fdeck.json",
    "/assets/..%2f..%2fsecret.txt",
    "/assets/%2e%2e%2fnotes.txt",
    "/assets/..%5cnotes.txt",
    "/scenes/..%2fdeck.json",
    "/scenes/..%2fnotes.txt",
    "/_depthcue/..%2fsecret.txt",
    "/_depthcue/..%2fdeck%2fdeck.json",
    "/%2e%2e/secret.txt",
    "/assets/report.csv%00.png",
  ])("does not let %s climb out of its directory", async (path) => {
    const answer = await get(path);
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("private notes");
    expect(answer.body).not.toContain("outside the deck folder");
  });

  it("does not follow a symlink out of the assets folder", async () => {
    try {
      symlinkSync(join(root, "secret.txt"), join(folder, "assets", "link.txt"));
    } catch {
      return; // creating a symlink needs a privilege on some Windows setups; the check itself is the same code
    }
    expect(existsSync(join(folder, "assets", "link.txt"))).toBe(true);
    const answer = await get("/assets/link.txt");
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("outside the deck folder");
  });

  it("refuses a request whose Host header is not loopback", async () => {
    for (const host of ["evil.example", "evil.example:4173", "127.0.0.1.evil.example", "10.0.0.5"]) {
      expect((await get("/deck.json", { host })).status).toBe(403);
    }
    expect((await get("/deck.json", { host: `localhost:${server.port}` })).status).toBe(200);
  });

  it("refuses anything but GET and HEAD", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect((await get("/deck.json", { method })).status).toBe(405);
    }
  });
});

describe("live reload", () => {
  it("pushes a change event when a scene file is written, and ignores temp files", async () => {
    const events = await new Promise<string>((resolveEvents, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/_depthcue/events",
          headers: { Host: `127.0.0.1:${server.port}` },
        },
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
      setTimeout(() => {
        writeFileSync(join(folder, "scenes", "demand.json.tmp"), "{}");
        writeFileSync(join(folder, "scenes", "opening.json"), "{}");
      }, 150);
      setTimeout(() => reject(new Error("no change event within 5 s")), 5000);
    });
    expect(events).toContain("retry:");
    expect(events.match(/event: change/g)).toHaveLength(1);
  });
});
