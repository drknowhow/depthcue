import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { docToFiles, loadDoc, readCueMap, revisionOf } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetName, sniffImage } from "../src/edit-api.ts";
import type { LayoutAnswer, LayoutChecker } from "../src/edit-layout.ts";
import { loadDeckDir } from "../src/loader.ts";
import { type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

let root: string;
let folder: string;
let server: RunningServer;

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: Record<string, unknown>;
}

interface Call {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Send the editor's token. Default true. */
  token?: boolean;
}

/** A raw request, so headers go out exactly as written. */
function call(path: string, init: Call = {}): Promise<Answer> {
  return new Promise((resolveAnswer, reject) => {
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${server.port}`,
      ...(init.token === false ? {} : { "X-Depthcue-Token": server.token as string }),
      ...init.headers,
    };
    if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));
    const req = request(
      { host: "127.0.0.1", port: server.port, path, method: init.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(body);
          } catch {
            // not JSON
          }
          resolveAnswer({ status: response.statusCode ?? 0, headers: response.headers, body, json });
        });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const json = (value: unknown): Call => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

const readDeck = () => {
  const loaded = loadDoc(loadDeckDir(folder));
  if (!loaded.doc) throw new Error("the deck on disk should be valid");
  return loaded.doc;
};

/** The deck with the opening headline changed, as the files the editor would send. */
function editedFiles(text: string): Record<string, string> {
  const doc = readDeck();
  const opening = doc.scenes.opening;
  if (!opening) throw new Error("the demo deck has an opening scene");
  const next = {
    ...doc,
    scenes: {
      ...doc.scenes,
      opening: {
        ...opening,
        blocks: opening.blocks.map((block) => (block.id === "opening-title" ? { ...block, text } : block)),
      },
    },
  };
  return docToFiles(next);
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "depthcue-edit-"));
  folder = join(root, "deck");
  const playerDir = join(root, "player");
  const editorDir = join(root, "editor");
  cpSync(demo, folder, { recursive: true });
  mkdirSync(playerDir);
  mkdirSync(editorDir);
  writeFileSync(join(playerDir, "app.js"), "export {};");
  writeFileSync(join(editorDir, "editor.js"), "export {};");
  writeFileSync(join(editorDir, "editor.css"), "body{}");
  server = await startServer({ folder, playerDir, editorDir, port: 0 });
});

afterEach(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("edit mode pages", () => {
  it("serves the editor at / with the token, and the player at /present", async () => {
    const page = await call("/", { token: false });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div id="depthcue-editor">');
    expect(page.body).toContain(`<meta name="depthcue-token" content="${server.token}">`);
    expect(String(page.headers["content-security-policy"])).toContain("script-src 'self'");
    const present = await call("/present", { token: false });
    expect(present.body).toContain('<div id="depthcue"');
    expect(present.body).not.toContain(server.token as string);
    expect((await call("/_depthcue/editor/editor.js", { token: false })).status).toBe(200);
  });

  it("gives every server its own token", async () => {
    const other = await startServer({
      folder,
      playerDir: join(root, "player"),
      editorDir: join(root, "editor"),
      port: 0,
    });
    try {
      expect(other.token).toBeTruthy();
      expect(other.token).not.toBe(server.token);
      expect((server.token as string).length).toBeGreaterThanOrEqual(30);
    } finally {
      await other.close();
    }
  });

  it("stays read-only and token-free without an editor", async () => {
    const plain = await startServer({ folder, playerDir: join(root, "player"), port: 0 });
    try {
      expect(plain.token).toBeUndefined();
      const post = await new Promise<number>((done, fail) => {
        const req = request(
          { host: "127.0.0.1", port: plain.port, path: "/_depthcue/api/save", method: "POST" },
          (response) => {
            response.resume();
            done(response.statusCode ?? 0);
          },
        );
        req.on("error", fail);
        req.end("{}");
      });
      expect(post).toBe(405);
    } finally {
      await plain.close();
    }
  });
});

describe("who may call the write API", () => {
  const body = () => json({ baseRev: "x", files: {} });

  it("refuses a call with no token, a wrong token, or a token of the wrong length", async () => {
    expect((await call("/_depthcue/api/deck", { token: false })).status).toBe(403);
    expect(
      (await call("/_depthcue/api/deck", { headers: { "X-Depthcue-Token": "nope" }, token: false })).status,
    ).toBe(403);
    const almost = `${(server.token as string).slice(0, -1)}A`;
    const wrong = await call("/_depthcue/api/save", {
      ...body(),
      headers: { ...body().headers, "X-Depthcue-Token": almost },
      token: false,
    });
    expect(wrong.status).toBe(403);
    expect(readDeck().deck.title).toBeTruthy();
  });

  it("refuses a page on another origin even when it somehow has the token", async () => {
    for (const origin of ["http://evil.example", "https://127.0.0.1", "http://127.0.0.1:1", "null"]) {
      const answer = await call("/_depthcue/api/deck", { headers: { Origin: origin } });
      expect(answer.status, origin).toBe(403);
    }
    const crossSite = await call("/_depthcue/api/deck", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    const sameSite = await call("/_depthcue/api/deck", { headers: { "Sec-Fetch-Site": "same-site" } });
    expect(sameSite.status).toBe(403);
  });

  it("accepts the editor's own origin under any loopback name", async () => {
    const origin = `http://127.0.0.1:${server.port}`;
    expect((await call("/_depthcue/api/deck", { headers: { Origin: origin } })).status).toBe(200);
    const named = await call("/_depthcue/api/deck", {
      headers: { Host: `localhost:${server.port}`, Origin: `http://localhost:${server.port}` },
    });
    expect(named.status).toBe(200);
    expect((await call("/_depthcue/api/deck", { headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(
      200,
    );
  });

  it("answers a CORS preflight with a refusal and no allow headers", async () => {
    const answer = await call("/_depthcue/api/save", {
      method: "OPTIONS",
      token: false,
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(answer.status).toBe(403);
    expect(answer.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses a rebound host name even with the token", async () => {
    const answer = await call("/_depthcue/api/deck", { headers: { Host: `evil.example:${server.port}` } });
    expect(answer.status).toBe(403);
  });

  it("answers a path that climbs out of the API prefix instead of leaving the request hanging", async () => {
    for (const path of [
      "/_depthcue/api/../deck.json",
      "/_depthcue/api/%2e%2e/deck.json",
      "/_depthcue/api%2fdeck",
    ]) {
      const answer = await Promise.race([
        call(path),
        new Promise<Answer>((_, reject) =>
          setTimeout(() => reject(new Error(`${path} never answered`)), 2000),
        ),
      ]);
      expect([200, 403, 404], path).toContain(answer.status);
    }
  });

  it("does not take the token from the query string", async () => {
    const answer = await call(`/_depthcue/api/deck?token=${server.token}`, { token: false });
    expect(answer.status).toBe(403);
  });
});

describe("reading the deck", () => {
  it("returns the revision, the files as text, and the assets", async () => {
    const answer = await call("/_depthcue/api/deck");
    expect(answer.status).toBe(200);
    expect(answer.json.rev).toBe(revisionOf(readDeck()));
    const text = answer.json.text as Record<string, string>;
    expect(Object.keys(text).sort()).toEqual(
      ["deck.json", ...readdirSync(join(folder, "scenes")).map((name) => `scenes/${name}`)].sort(),
    );
    expect(answer.json.assets).toContain("assets/method.svg");
    expect((answer.headers["cache-control"] as string) ?? "").toContain("no-store");
  });

  it("explains a deck that does not validate, and does not hand over its files", async () => {
    writeFileSync(join(folder, "scenes", "opening.json"), "{ not json");
    const answer = await call("/_depthcue/api/deck");
    expect(answer.status).toBe(422);
    expect((answer.json.diagnostics as unknown[]).length).toBeGreaterThan(0);
    expect(answer.json.text).toBeUndefined();
  });

  it("knows no other routes or methods", async () => {
    expect((await call("/_depthcue/api/nothing")).status).toBe(404);
    expect((await call("/_depthcue/api/deck", { method: "DELETE" })).status).toBe(404);
    expect((await call("/_depthcue/api/save")).status).toBe(404);
  });
});

describe("saving", () => {
  it("writes an edit, reports the new revision, and leaves untouched files alone", async () => {
    const before = readDeck();
    const handFormatted = readFileSync(join(folder, "scenes", "method.json"), "utf8");
    const answer = await call(
      "/_depthcue/api/save",
      json({ baseRev: revisionOf(before), files: editedFiles("Channel B leads, again") }),
    );
    expect(answer.status).toBe(200);
    const after = readDeck();
    expect(answer.json.rev).toBe(revisionOf(after));
    expect(answer.json.written).toEqual(["scenes/opening.json"]);
    const block = after.scenes.opening?.blocks.find((candidate) => candidate.id === "opening-title");
    expect(block && "text" in block && block.text).toBe("Channel B leads, again");
    expect(readFileSync(join(folder, "scenes", "method.json"), "utf8")).toBe(handFormatted);
  });

  it("matches the revision the browser computes for the same document", async () => {
    const files = editedFiles("Same content, same revision");
    const loaded = loadDoc({ text: files, assets: [...readDeck().assets] });
    const answer = await call("/_depthcue/api/save", json({ baseRev: revisionOf(readDeck()), files }));
    expect(loaded.doc && revisionOf(loaded.doc)).toBe(answer.json.rev);
  });

  it("refuses a stale revision, says what is on disk, and writes nothing", async () => {
    const original = readFileSync(join(folder, "scenes", "opening.json"), "utf8");
    const answer = await call(
      "/_depthcue/api/save",
      json({ baseRev: "0000000000000000", files: editedFiles("Should not land") }),
    );
    expect(answer.status).toBe(409);
    expect(answer.json.rev).toBe(revisionOf(readDeck()));
    expect(readFileSync(join(folder, "scenes", "opening.json"), "utf8")).toBe(original);
  });

  it("does not let a stale editor overwrite a change made by an agent", async () => {
    const stale = revisionOf(readDeck());
    const agent = readFileSync(join(folder, "scenes", "opening.json"), "utf8").replace(
      "Channel B now leads demand",
      "Written by an agent",
    );
    writeFileSync(join(folder, "scenes", "opening.json"), agent);
    const answer = await call(
      "/_depthcue/api/save",
      json({ baseRev: stale, files: editedFiles("Human edit") }),
    );
    expect(answer.status).toBe(409);
    expect(readFileSync(join(folder, "scenes", "opening.json"), "utf8")).toBe(agent);
  });

  it("rejects a deck that does not validate, with the reasons, and writes nothing", async () => {
    const original = readFileSync(join(folder, "scenes", "opening.json"), "utf8");
    const files = editedFiles("x");
    const scene = JSON.parse(files["scenes/opening.json"] as string);
    scene.blocks[0].text = "";
    files["scenes/opening.json"] = JSON.stringify(scene);
    const answer = await call("/_depthcue/api/save", json({ baseRev: revisionOf(readDeck()), files }));
    expect(answer.status).toBe(422);
    expect((answer.json.diagnostics as Array<{ at: string }>)[0]?.at).toContain("scenes/opening.json");
    expect(readFileSync(join(folder, "scenes", "opening.json"), "utf8")).toBe(original);
  });

  it("rejects a deck that is missing a scene it lists", async () => {
    const files = editedFiles("x");
    delete files["scenes/method.json"];
    const answer = await call("/_depthcue/api/save", json({ baseRev: revisionOf(readDeck()), files }));
    expect(answer.status).toBe(422);
    expect(existsSync(join(folder, "scenes", "method.json"))).toBe(true);
  });

  it("only writes the deck and scene files it names, never a path the client invents", async () => {
    for (const path of [
      "../evil.json",
      "scenes/../../evil.json",
      "assets/evil.json",
      "notes.txt",
      "scenes/a/b.json",
    ]) {
      const files = { ...editedFiles("x"), [path]: "{}" };
      const answer = await call("/_depthcue/api/save", json({ baseRev: revisionOf(readDeck()), files }));
      expect(answer.status, path).toBe(400);
    }
    expect(existsSync(join(root, "evil.json"))).toBe(false);
  });

  it("rejects malformed bodies, a wrong content type, and an oversized request", async () => {
    expect(
      (
        await call("/_depthcue/api/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect((await call("/_depthcue/api/save", json({ baseRev: 1, files: {} }))).status).toBe(400);
    expect((await call("/_depthcue/api/save", json({ baseRev: "x", files: [] }))).status).toBe(400);
    expect(
      (
        await call("/_depthcue/api/save", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    const huge = await call("/_depthcue/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Buffer.alloc(9 * 1024 * 1024, 0x20),
    }).catch(() => ({ status: 413 }));
    expect(huge.status).toBe(413);
  });
});

describe("adding images", () => {
  const upload = (bytes: Buffer, name = "photo.png", extra: Call = {}) =>
    call(`/_depthcue/api/asset?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
      ...extra,
    });

  it("stores an image under a safe name derived from its content, and does not duplicate it", async () => {
    const first = await upload(PNG, "My Holiday Photo!.PNG");
    expect(first.status).toBe(200);
    expect(first.json.asset).toMatch(/^assets\/my-holiday-photo-[0-9a-f]{8}\.png$/);
    const again = await upload(PNG, "My Holiday Photo!.PNG");
    expect(again.json.asset).toBe(first.json.asset);
    expect(readdirSync(join(folder, "assets")).filter((name) => name.startsWith("my-holiday"))).toHaveLength(
      1,
    );
    expect(readFileSync(join(folder, first.json.asset as string)).equals(PNG)).toBe(true);
    expect(readdirSync(join(folder, "assets")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("cannot be steered out of assets/ by the name it is given", async () => {
    for (const name of ["../../evil.png", "..\\..\\evil.png", "/etc/passwd.png", "a/b/c.png", "..", ""]) {
      const answer = await upload(PNG, name);
      expect(answer.status, name).toBe(200);
      expect(String(answer.json.asset), name).toMatch(/^assets\/[a-z0-9-]+\.png$/);
    }
    expect(existsSync(join(root, "evil.png"))).toBe(false);
    expect(readdirSync(root).sort()).toEqual(["deck", "editor", "player"]);
  });

  it("decides the type from the bytes, not from the name or the declared type", async () => {
    const lie = await upload(Buffer.from("<html><script>alert(1)</script></html>"), "x.png", {
      headers: { "Content-Type": "image/png" },
    });
    expect(lie.status).toBe(415);
    const asPng = await upload(PNG, "data.svg");
    expect(String(asPng.json.asset)).toMatch(/\.png$/);
    expect((await upload(Buffer.alloc(0))).status).toBe(415);
  });

  it("accepts a plain svg and refuses one that can run script", async () => {
    const plain =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>';
    expect((await upload(Buffer.from(plain), "shape.svg")).status).toBe(200);
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
    ]) {
      expect((await upload(Buffer.from(bad), "bad.svg")).status, bad).toBe(415);
    }
  });

  it("refuses an oversized image and needs the token like every other call", async () => {
    const big = await upload(Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024)])).catch(() => ({
      status: 413,
    }));
    expect(big.status).toBe(413);
    expect((await upload(PNG, "photo.png", { token: false })).status).toBe(403);
  });

  it("lets a saved deck use the new image", async () => {
    const stored = await upload(PNG, "chart.png");
    const asset = stored.json.asset as string;
    const files = JSON.parse(JSON.stringify(editedFiles("With a picture")));
    const scene = JSON.parse(files["scenes/opening.json"]);
    scene.blocks.push({ id: "opening-photo", type: "image", asset, alt: "A picture" });
    files["scenes/opening.json"] = JSON.stringify(scene);
    const saved = await call("/_depthcue/api/save", json({ baseRev: revisionOf(readDeck()), files }));
    expect(saved.status).toBe(200);
  });
});

describe("clip cues", () => {
  const SOURCE = "assets/talk.mp4";
  const cueFile = () => join(folder, "assets", "talk.cues.json");
  const clip = { duration: 10, width: 1280, height: 720 };
  const marker = (id: string, start: number) => ({ id, type: "marker", in: start, out: 10 });
  const getCues = (source: string, extra: Call = {}) =>
    call(`/_depthcue/api/cues?source=${encodeURIComponent(source)}`, extra);
  const putCues = (body: unknown, extra: Call = {}) =>
    call("/_depthcue/api/cues", { ...json(body), ...extra });
  const built = {
    format: "depthcue-cues/1",
    source: SOURCE,
    duration: 10,
    width: 1280,
    height: 720,
    fps: 24,
    cues: [{ id: "dot", type: "circle", in: 0, out: 2 }],
    build: { key: "abc", kinescript: "kinescript 1.2.0", quality: "draft", scale: 0.5, scene: "talk.json" },
    note: "written by another tool",
  };

  beforeEach(() => {
    mkdirSync(join(folder, "assets"), { recursive: true });
    writeFileSync(join(folder, "assets", "talk.mp4"), Buffer.alloc(32));
  });

  it("reads a clip with no cue map as having none, and a built one as it is", async () => {
    const none = await getCues(SOURCE);
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ state: "none", cues: [] });
    writeFileSync(cueFile(), JSON.stringify(built));
    const found = await getCues(SOURCE);
    expect(found.json).toEqual({ state: "ok", cues: built.cues, duration: 10 });
  });

  it("calls a cue file the player cannot read broken, and says no more", async () => {
    writeFileSync(cueFile(), "{ not json");
    expect((await getCues(SOURCE)).json).toEqual({ state: "broken", cues: [] });
    writeFileSync(cueFile(), JSON.stringify({ ...built, format: "depthcue-cues/9" }));
    expect((await getCues(SOURCE)).json).toEqual({ state: "broken", cues: [] });
  });

  it("answers only for a video of the deck, never for a path that leads elsewhere", async () => {
    // Each path below names a file that exists, so only the rule about which paths may be named can refuse it.
    mkdirSync(join(folder, "assets", "sub"));
    for (const there of ["talk.mp4", "assets/sub/talk.mp4", "assets/photo.png"]) {
      writeFileSync(join(folder, ...there.split("/")), Buffer.alloc(8));
    }
    writeFileSync(join(root, "talk.mp4"), Buffer.alloc(8));
    const refused = [
      "",
      "talk.mp4",
      "../talk.mp4",
      "assets/../talk.mp4",
      "assets/sub/talk.mp4",
      "assets\\talk.mp4",
      "assets/photo.png",
      "assets/missing.mp4",
    ];
    for (const source of refused) {
      expect((await getCues(source)).status, `read ${source}`).toBe(400);
      expect((await putCues({ source, cues: [], clip })).status, `save ${source}`).toBe(400);
    }
    expect((await call("/_depthcue/api/cues")).status).toBe(400);
    expect(readdirSync(join(folder, "assets")).filter((name) => name.includes("cues"))).toEqual([]);
  });

  it("starts a cue map for a clip that was never built, from what the editor measured", async () => {
    const saved = await putCues({ source: SOURCE, cues: [marker("b", 6), marker("a", 2.5)], clip });
    expect(saved.status).toBe(200);
    expect((saved.json.cues as { id: string }[]).map((cue) => cue.id)).toEqual(["a", "b"]);
    expect(saved.json.duration).toBe(10);
    const map = readCueMap(JSON.parse(readFileSync(cueFile(), "utf8")));
    expect(map).toMatchObject({ source: SOURCE, duration: 10, width: 1280, height: 720, fps: 30 });
    expect(map?.build).toBeUndefined();
    expect(map?.cues.map((cue) => `${cue.id}@${cue.in}`)).toEqual(["a@2.5", "b@6"]);
    expect(readdirSync(join(folder, "assets")).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect((await getCues(SOURCE)).json).toMatchObject({ state: "ok", duration: 10 });
  });

  it("will not start a map without a measured clip, and writes nothing", async () => {
    for (const measured of [undefined, {}, { duration: 10, width: 1280 }, { ...clip, duration: 0 }, "x"]) {
      const answer = await putCues({ source: SOURCE, cues: [], clip: measured });
      expect(answer.status, JSON.stringify(measured)).toBe(422);
      expect(answer.json.error).toBe("needs-clip");
    }
    expect(existsSync(cueFile())).toBe(false);
  });

  it("changes only the cues of a map that is there, so the build record survives", async () => {
    writeFileSync(cueFile(), JSON.stringify(built));
    const saved = await putCues({ source: SOURCE, cues: [...built.cues, marker("marker-1", 4)] });
    expect(saved.status).toBe(200);
    const after = JSON.parse(readFileSync(cueFile(), "utf8"));
    expect(after).toEqual({ ...built, cues: [...built.cues, marker("marker-1", 4)] });
    expect(after.build).toEqual(built.build);
    expect(after.fps).toBe(24);
  });

  it("holds an existing map to its own duration, whatever the editor says the clip measures", async () => {
    writeFileSync(cueFile(), JSON.stringify(built));
    const answer = await putCues({
      source: SOURCE,
      cues: [{ id: "late", type: "marker", in: 50, out: 60 }],
      clip: { ...clip, duration: 99 },
    });
    expect(answer.status).toBe(422);
    expect(answer.json.error).toBe("invalid");
    expect(String(answer.json.message)).toContain("after the clip ends at 10 s");
    expect(JSON.parse(readFileSync(cueFile(), "utf8"))).toEqual(built);
  });

  it("refuses cues the player would not take whole, and leaves the file as it was", async () => {
    writeFileSync(cueFile(), JSON.stringify(built));
    const before = readFileSync(cueFile(), "utf8");
    const bad: [string, unknown][] = [
      ["not a list", "nope"],
      ["a cue that is not usable", [{ id: "", type: "marker", in: 1, out: 2 }]],
      ["an end before the start", [{ id: "x", type: "marker", in: 3, out: 1 }]],
      ["two cues with one id", [marker("same", 1), marker("same", 2)]],
      ["too many", Array.from({ length: 65 }, (_, i) => marker(`m-${i}`, i % 10))],
    ];
    for (const [why, cues] of bad) {
      const answer = await putCues({ source: SOURCE, cues });
      expect(answer.status, why).toBe(422);
      expect(answer.json.error, why).toBe("invalid");
    }
    expect(readFileSync(cueFile(), "utf8")).toBe(before);
  });

  it("never overwrites a file it cannot read as a cue map", async () => {
    writeFileSync(cueFile(), "hand written notes");
    const answer = await putCues({ source: SOURCE, cues: [marker("a", 1)], clip });
    expect(answer.status).toBe(422);
    expect(answer.json.error).toBe("broken");
    expect(readFileSync(cueFile(), "utf8")).toBe("hand written notes");
  });

  it("needs the token, and only JSON of a sensible size", async () => {
    expect((await getCues(SOURCE, { token: false })).status).toBe(403);
    expect((await putCues({ source: SOURCE, cues: [], clip }, { token: false })).status).toBe(403);
    expect(
      (
        await call("/_depthcue/api/cues", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    const garbled = await call("/_depthcue/api/cues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ nope",
    });
    expect(garbled.status).toBe(400);
    expect((await putCues([1, 2])).status).toBe(400);
    const huge = await putCues({ source: SOURCE, cues: [], clip, padding: "x".repeat(300 * 1024) }).catch(
      () => ({ status: 413 }),
    );
    expect(huge.status).toBe(413);
    expect(existsSync(cueFile())).toBe(false);
  });
});

describe("layout", () => {
  const found = {
    severity: "error" as const,
    code: "overflow",
    file: "scenes/method.json",
    path: "/blocks/1",
    message: "The scene is 40px taller than the 1280x720 stage.",
    fix: "Shorten the text first.",
  };
  const asked: string[] = [];
  let answer: LayoutAnswer = { available: true, diagnostics: [found] };
  let closes = 0;
  const fake: LayoutChecker = {
    check: async (scene) => {
      asked.push(scene);
      return answer;
    },
    close: async () => {
      closes += 1;
    },
  };

  beforeEach(async () => {
    asked.length = 0;
    closes = 0;
    answer = { available: true, diagnostics: [found] };
    await server.close();
    server = await startServer({
      folder,
      playerDir: join(root, "player"),
      editorDir: join(root, "editor"),
      port: 0,
      layout: fake,
    });
  });

  it("asks for the layout of a scene of the deck and returns what the render found, in the words of the other calls", async () => {
    const reply = await call("/_depthcue/api/layout?scene=method");
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      available: true,
      diagnostics: [
        {
          code: "overflow",
          at: "scenes/method.json/blocks/1",
          severity: "error",
          message: found.message,
          fix: found.fix,
        },
      ],
    });
    expect(asked).toEqual(["method"]);
  });

  it("passes on that no render could be made, with the reason", async () => {
    answer = { available: false, message: "No browser could be started." };
    const reply = await call("/_depthcue/api/layout?scene=method");
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ available: false, message: "No browser could be started." });
  });

  it("refuses a call with no token, and starts no render for a scene the deck does not have", async () => {
    expect((await call("/_depthcue/api/layout?scene=method", { token: false })).status).toBe(403);
    expect((await call("/_depthcue/api/layout?scene=nothing")).status).toBe(404);
    expect((await call("/_depthcue/api/layout")).status).toBe(404);
    expect((await call("/_depthcue/api/layout?scene=method", { method: "POST" })).status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("says no render can be made while the deck on disk has errors", async () => {
    writeFileSync(join(folder, "scenes", "method.json"), "{ not json");
    const reply = await call("/_depthcue/api/layout?scene=method");
    expect(reply.status).toBe(200);
    expect(reply.json.available).toBe(false);
    expect(asked).toEqual([]);
  });

  it("closes the checker, and the browser with it, when the server closes", async () => {
    await server.close();
    expect(closes).toBe(1);
  });
});

describe("image sniffing", () => {
  it("names the kinds it knows and nothing else", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpg");
    expect(sniffImage(Buffer.from("GIF89a......"))).toBe("gif");
    expect(sniffImage(Buffer.from("RIFF....WEBPVP8 "))).toBe("webp");
    expect(sniffImage(Buffer.from("<?xml version='1.0'?><svg xmlns='x'/>"))).toBe("svg");
    expect(sniffImage(Buffer.from("MZ\x90\x00"))).toBeUndefined();
    expect(sniffImage(Buffer.from("%PDF-1.7"))).toBeUndefined();
  });

  it("builds a name from letters, digits and a content hash", () => {
    expect(assetName("Résumé (final).JPG", "jpg", Buffer.from("a"))).toMatch(
      /^r-sum-final-[0-9a-f]{8}\.jpg$/,
    );
    expect(assetName("", "png", Buffer.from("a"))).toMatch(/^image-[0-9a-f]{8}\.png$/);
    expect(assetName("x".repeat(200), "png", Buffer.from("a")).length).toBeLessThan(60);
  });
});
