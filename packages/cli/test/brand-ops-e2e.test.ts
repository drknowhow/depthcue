// Brand files end to end: the edit API's upload and removal routes and `depthcue brand add/remove`, on copies of the
// branded fixture decks. Every refusal the route makes is here, with what it leaves on disk: nothing.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDoc, revisionOf } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";
import { type RunningServer, startServer } from "../src/serve.ts";

const decks = fileURLToPath(new URL("../../../fixtures/decks", import.meta.url));
const hostile = (name: string) => fileURLToPath(new URL(`./fixtures/hostile/${name}`, import.meta.url));
const TIDEWELL_BOLD = readFileSync(join(decks, "tidewell-press/brand/fonts/TidewellText-Bold.woff2"));
const HARBOR_LOGO = readFileSync(join(decks, "v0-4-brand/brand/logos/harbor.svg"));
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(32, 1)]);
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const svg = (body: string, attributes = "") =>
  Buffer.from(`<svg ${SVG_NS} viewBox="0 0 10 10"${attributes}>${body}</svg>`);
const SAFE_SVG = svg(
  '<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><use href="#g"/>',
);

let root: string;
let folder: string;
let server: RunningServer;

interface Answer {
  status: number;
  json: Record<string, any>;
  ms: number;
}

function call(
  path: string,
  method = "GET",
  body?: Buffer | string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const started = performance.now();
  return new Promise((resolveAnswer, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method,
        headers: {
          Host: `127.0.0.1:${server.port}`,
          "X-Depthcue-Token": server.token as string,
          ...(body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) }),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, any> = {};
          try {
            json = JSON.parse(text);
          } catch {
            json = { text };
          }
          resolveAnswer({ status: response.statusCode ?? 0, json, ms: performance.now() - started });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const upload = (bytes: Buffer, query: Record<string, string>) =>
  call(`/_depthcue/api/brand-file?${new URLSearchParams(query)}`, "POST", bytes, {
    "Content-Type": "application/octet-stream",
  });
const removal = (body: unknown) =>
  call("/_depthcue/api/brand-file/remove", "POST", JSON.stringify(body), {
    "Content-Type": "application/json",
  });

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

const revOf = (dir: string): string => {
  const loaded = loadDoc(loadDeckDir(dir));
  if (!loaded.doc) throw new Error(JSON.stringify(loaded.diagnostics));
  return revisionOf(loaded.doc);
};

/** Every file of a folder by its path, with its bytes as latin1, so a refusal can be shown to have written nothing. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(dir, full).split(sep).join("/")] = readFileSync(full, "latin1");
    }
  };
  walk(dir);
  return files;
}

function copyDeck(name: string, as: string): string {
  const dir = join(root, as);
  cpSync(join(decks, name), dir, { recursive: true });
  return dir;
}

async function serve(dir: string): Promise<void> {
  const playerDir = join(root, "player");
  const editorDir = join(root, "editor");
  mkdirSync(playerDir, { recursive: true });
  mkdirSync(editorDir, { recursive: true });
  writeFileSync(join(playerDir, "app.js"), "export {};");
  writeFileSync(join(editorDir, "editor.js"), "export {};");
  writeFileSync(join(editorDir, "editor.css"), "body{}");
  server = await startServer({ folder: dir, playerDir, editorDir, port: 0 });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "depthcue-brand-ops-"));
  folder = copyDeck("v0-4-brand", "deck");
  await serve(folder);
});

afterEach(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the brand file upload", () => {
  it("adds a font under its base name, says what it found, and the server serves it", async () => {
    const before = revOf(folder);
    const answer = await upload(TIDEWELL_BOLD, { kind: "font", name: "TidewellText-Bold.woff2" });
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    expect(answer.json).toMatchObject({
      ok: true,
      path: "fonts/TidewellText-Bold.woff2",
      kind: "font",
      sniffed: { format: "woff2", weight: 700, italic: false },
      written: true,
      replaced: false,
      prevRev: before,
    });
    // The fixture's font names itself by the family it stands in for.
    expect(answer.json.sniffed.family).toBe("Depthcue Classic Sans");
    expect(answer.json.rev).not.toBe(before);
    expect(answer.json.rev).toBe(revOf(folder));
    expect(readFileSync(join(folder, "brand/fonts/TidewellText-Bold.woff2")).equals(TIDEWELL_BOLD)).toBe(
      true,
    );
    const served = await call("/brand/fonts/TidewellText-Bold.woff2");
    expect(served.status).toBe(200);
    // No temporary file is left at the deck's top or in the folder.
    expect(readdirSync(folder).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("names a font by what its bytes are, whatever its name says", async () => {
    const answer = await upload(TIDEWELL_BOLD, { kind: "font", name: "Renamed.ttf" });
    expect(answer.json).toMatchObject({ path: "fonts/Renamed.woff2", sniffed: { format: "woff2" } });
    const png = await upload(PNG, { kind: "font", name: "Picture.woff2" });
    expect(png).toMatchObject({ status: 415, json: { ok: false, error: "not-a-font" } });
    expect(existsSync(join(folder, "brand/fonts/Picture.woff2"))).toBe(false);
  });

  it("refuses each hostile font from step 6 in under 200 ms, and stays up", async () => {
    const before = snapshot(folder);
    for (const name of ["bomb-1.woff2", "bomb-2.woff2", "points-1.woff2", "points-2.woff2"]) {
      const answer = await upload(readFileSync(hostile(name)), { kind: "font", name });
      expect(answer.status, name).toBe(415);
      expect(answer.json.error, name).toBe("not-a-font");
      expect(answer.ms, name).toBeLessThan(200);
    }
    expect(snapshot(folder)).toEqual(before);
    expect((await call("/_depthcue/api/deck")).status).toBe(200);
  });

  it("takes an SVG that draws and links only to places in itself", async () => {
    const answer = await upload(SAFE_SVG, { kind: "logo", name: "mark.svg" });
    expect(answer.json).toMatchObject({ ok: true, path: "logos/mark.svg", sniffed: { format: "svg" } });
    expect((await call("/brand/logos/mark.svg")).status).toBe(200);
  });

  const UNSAFE: Array<[string, Buffer]> = [
    [
      "a DOCTYPE with an entity",
      Buffer.from(`<!DOCTYPE svg [<!ENTITY x "y">]><svg ${SVG_NS}><text>&x;</text></svg>`),
    ],
    [
      "a bare DOCTYPE",
      Buffer.from(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd"><svg ${SVG_NS}/>`),
    ],
    ["a script", svg("<script>alert(1)</script>")],
    [
      "a script under a prefix",
      svg("<s:script>alert(1)</s:script>", ' xmlns:s="http://www.w3.org/2000/svg"'),
    ],
    ["a foreignObject", svg("<foreignObject><div/></foreignObject>")],
    ["an onload attribute", svg("<rect/>", ' onload="go()"')],
    ["an onclick attribute", svg('<rect onclick="go()"/>')],
    ["an href outside the file", svg('<a href="https://example.com"><rect/></a>')],
    [
      "an xlink:href outside the file",
      svg('<use xlink:href="other.svg#a"/>', ' xmlns:xlink="http://www.w3.org/1999/xlink"'),
    ],
    ["a picture held in a link", svg('<image href="data:image/png;base64,AAAA"/>')],
    ["a url() outside the file", svg('<rect style="fill:url(https://example.com/p.svg#g)"/>')],
    ["a url() in an attribute", svg('<rect fill="url(other.svg#g)"/>')],
    ["an @import in a style element", svg("<style>@import url(#a);</style>")],
    ["markup that is not XML", Buffer.from(`<svg ${SVG_NS}><g></svg>`)],
    ["too many elements", svg("<g/>".repeat(20_001))],
  ];
  for (const [what, bytes] of UNSAFE) {
    it(`refuses an SVG with ${what}`, async () => {
      const before = snapshot(folder);
      const answer = await upload(bytes, { kind: "logo", name: "bad.svg" });
      expect(answer.status, JSON.stringify(answer.json)).toBe(422);
      expect(answer.json).toMatchObject({ ok: false, error: "unsafe-svg" });
      expect(snapshot(folder)).toEqual(before);
    });
  }

  it("refuses an SVG over 1 MB", async () => {
    const big = svg(`<!--${"x".repeat(1024 * 1024)}-->`);
    expect(await upload(big, { kind: "image", name: "big.svg" })).toMatchObject({
      status: 413,
      json: { error: "too-large" },
    });
  });

  it("refuses a megabyte of unclosed url( at once, and answers the editor meanwhile", async () => {
    const before = snapshot(folder);
    for (const [wrapper, problem] of [
      [`<svg ${SVG_NS}><rect fill="{}"/></svg>`, /a url\(\) that cannot be read/],
      [`<svg ${SVG_NS}><style>{}</style></svg>`, /a style longer than 64 KB/],
    ] as const) {
      const run = "url(".repeat(Math.floor((1024 * 1024 - wrapper.length + 2) / 4));
      const uploading = upload(Buffer.from(wrapper.replace("{}", run)), { kind: "logo", name: "slow.svg" });
      const meanwhile = call("/_depthcue/api/deck");
      const [answer, deck] = await Promise.all([uploading, meanwhile]);
      expect(answer.status, JSON.stringify(answer.json)).toBe(422);
      expect(answer.json.message).toMatch(problem);
      // A megabyte crosses the loopback in a few milliseconds; the check itself is timed in brand-files.test.ts.
      expect(answer.ms).toBeLessThan(1000);
      expect(deck.status).toBe(200);
      expect(deck.ms).toBeLessThan(1000);
    }
    expect(snapshot(folder)).toEqual(before);
  });

  it("refuses a body past its kind's limit, and an empty one, whichever way it comes", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)]);
    expect(await upload(big, { kind: "logo", name: "big.png" })).toMatchObject({
      status: 413,
      json: { error: "too-large" },
    });
    const file = join(root, "big.png");
    writeFileSync(file, big);
    const added = await cli("brand", "add", file, folder, "--kind", "logo", "--json");
    expect(added.code).toBe(1);
    expect(JSON.parse(added.out)).toMatchObject({ ok: false, error: "too-large" });
    expect((await upload(Buffer.alloc(0), { kind: "logo", name: "empty.png" })).json.error).toBe(
      "bad-request",
    );
    expect(readdirSync(join(folder, "brand/logos"))).toEqual(["harbor.svg"]);
  });

  it("takes only the kinds of file each kind of brand file may be", async () => {
    expect((await upload(JPG, { kind: "logo", name: "x.jpg" })).json.error).toBe("unsupported");
    expect((await upload(GIF, { kind: "image", name: "x.gif" })).json.error).toBe("unsupported");
    expect((await upload(JPG, { kind: "image", name: "photo.jpeg" })).json).toMatchObject({
      path: "images/photo.jpg",
      sniffed: { format: "jpg" },
    });
    expect((await upload(PNG, { kind: "picture", name: "x.png" })).status).toBe(400);
    expect((await upload(PNG, { name: "x.png" })).status).toBe(400);
  });

  it("keeps only the base name, in the characters brand.json takes", async () => {
    for (const [name, path] of [
      ["../../evil/Logo Mark.png", "logos/Logo-Mark.png"],
      ["..\\..\\windows\\back.png", "logos/back.png"],
      ["/etc/passwd", "logos/passwd.png"],
      ["..hidden.png", "logos/hidden.png"],
      ["a..b.png", "logos/a.b.png"],
    ] as const) {
      const answer = await upload(PNG, { kind: "logo", name });
      expect(answer.json.path, name).toBe(path);
    }
    expect(existsSync(join(root, "evil"))).toBe(false);
    expect(readdirSync(join(folder, "brand/logos")).sort()).toEqual(
      ["Logo-Mark.png", "a.b.png", "back.png", "harbor.svg", "hidden.png", "passwd.png"].sort(),
    );
  });

  it("refuses a name Windows keeps for a device, and one with nothing to name the file by", async () => {
    for (const name of ["con.svg", "NUL.png", "lpt1.png", "Com3", "!!!.png"]) {
      const answer = await upload(PNG, { kind: "logo", name });
      expect(answer.status, name).toBe(400);
      expect(answer.json.error, name).toBe("bad-name");
    }
    expect(readdirSync(join(folder, "brand/logos"))).toEqual(["harbor.svg"]);
  });

  it("gives back the path of a file with the same bytes, in any letter case, and writes nothing", async () => {
    const before = snapshot(folder);
    const mtime = statSync(join(folder, "brand/logos/harbor.svg")).mtimeMs;
    const answer = await upload(HARBOR_LOGO, { kind: "logo", name: "HARBOR.svg" });
    expect(answer.json).toMatchObject({
      ok: true,
      path: "logos/harbor.svg",
      written: false,
      rev: revOf(folder),
    });
    expect(snapshot(folder)).toEqual(before);
    expect(statSync(join(folder, "brand/logos/harbor.svg")).mtimeMs).toBe(mtime);
  });

  it("refuses other bytes under a name that is there, in any letter case, until replace names the revision", async () => {
    const before = snapshot(folder);
    for (const name of ["harbor.svg", "Harbor.svg"]) {
      const answer = await upload(SAFE_SVG, { kind: "logo", name });
      expect(answer.status, name).toBe(409);
      expect(answer.json, name).toMatchObject({ error: "exists", existing: "logos/harbor.svg" });
    }
    expect((await upload(SAFE_SVG, { kind: "logo", name: "harbor.svg", replace: "1" })).status).toBe(400);
    const old = revOf(folder);
    // Someone else changes the deck: the revision the uploader holds is old now.
    const edited = await cli(
      "apply",
      folder,
      opsFile([{ op: "deck.set", set: { title: "Moved on" } }]),
      "--base-rev",
      old,
    );
    expect(edited.code, edited.err).toBe(0);
    const stale = await upload(SAFE_SVG, { kind: "logo", name: "harbor.svg", replace: "1", baseRev: old });
    expect(stale).toMatchObject({ status: 409, json: { error: "stale", rev: revOf(folder) } });
    const after = snapshot(folder);
    expect(after["brand/logos/harbor.svg"]).toBe(before["brand/logos/harbor.svg"]);
    const replaced = await upload(SAFE_SVG, {
      kind: "logo",
      name: "Harbor.svg",
      replace: "1",
      baseRev: revOf(folder),
    });
    expect(replaced.json).toMatchObject({
      ok: true,
      path: "logos/harbor.svg",
      written: true,
      replaced: true,
    });
    expect(readFileSync(join(folder, "brand/logos/harbor.svg")).equals(SAFE_SVG)).toBe(true);
    expect(readdirSync(join(folder, "brand/logos"))).toEqual(["harbor.svg"]);
  });

  it("refuses an upload without the editor's token", async () => {
    const answer = await call("/_depthcue/api/brand-file?kind=logo&name=x.png", "POST", PNG, {
      "X-Depthcue-Token": "wrong",
    });
    expect(answer.status).toBe(403);
    expect(existsSync(join(folder, "brand/logos/x.png"))).toBe(false);
  });

  it("refuses to write through a brand folder that links outside the deck", async () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside);
    rmSync(join(folder, "brand/logos"), { recursive: true });
    try {
      // A junction needs no rights on Windows; elsewhere this is a symlink.
      symlinkSync(outside, join(folder, "brand/logos"), "junction");
    } catch (error) {
      if (process.platform === "win32") throw error;
      return; // No links on this machine: nothing to check.
    }
    const answer = await upload(PNG, { kind: "logo", name: "x.png" });
    expect(answer.json.error).toBe("linked-brand-folder");
    expect(readdirSync(outside)).toEqual([]);
  });
});

function opsFile(ops: unknown[]): string {
  const file = join(root, `ops-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(ops));
  return file;
}

describe("removing a brand file", () => {
  it("is refused while brand.json or a template names it, saying where", async () => {
    const answer = await removal({ path: "logos/harbor.svg", baseRev: revOf(folder) });
    expect(answer).toMatchObject({ status: 409, json: { error: "in-use" } });
    expect(answer.json.usedBy).toEqual([{ file: "brand/brand.json", path: "/logos/light" }]);
    expect(existsSync(join(folder, "brand/logos/harbor.svg"))).toBe(true);

    const added = await upload(PNG, { kind: "image", name: "sea.png" });
    const set = await cli(
      "apply",
      folder,
      opsFile([
        {
          op: "template.set",
          id: "cover",
          set: { background: { color: "action", image: "images/sea.png", scrim: 40 } },
        },
      ]),
      "--base-rev",
      added.json.rev,
    );
    expect(set.code, set.err).toBe(0);
    const named = await removal({ path: "images/sea.png", baseRev: revOf(folder) });
    expect(named.json.usedBy).toEqual([{ file: "brand/templates/cover.json", path: "/background/image" }]);
  });

  it("removes a file nothing names, against the current revision only", async () => {
    const added = await upload(PNG, { kind: "image", name: "sea.png" });
    const stale = await removal({ path: "images/sea.png", baseRev: added.json.prevRev });
    expect(stale).toMatchObject({ status: 409, json: { error: "stale", rev: added.json.rev } });
    const removed = await removal({ path: "brand/images/SEA.png", baseRev: added.json.rev });
    expect(removed.json).toMatchObject({
      ok: true,
      path: "images/sea.png",
      removed: true,
      prevRev: added.json.rev,
    });
    expect(removed.json.rev).toBe(added.json.prevRev);
    expect(existsSync(join(folder, "brand/images/sea.png"))).toBe(false);
  });

  it("refuses what is not a brand file of the deck", async () => {
    const rev = revOf(folder);
    expect((await removal({ path: "images/none.png", baseRev: rev })).status).toBe(404);
    for (const path of [
      "../deck.json",
      "brand.json",
      "templates/cover.json",
      "fonts/OFL.txt",
      "logos/../x.svg",
    ]) {
      expect((await removal({ path, baseRev: rev })).json.error, path).toBe("bad-request");
    }
    expect((await removal({ path: "logos/harbor.svg" })).status).toBe(400);
    expect(existsSync(join(folder, "deck.json"))).toBe(true);
  });
});

describe("brand files and the deck's revision", () => {
  it("makes the editor's next save stale when a file is replaced on disk, and an upload's rev saves", async () => {
    const opened = await call("/_depthcue/api/deck");
    writeFileSync(join(folder, "brand/fonts/HarborSans-Bold.woff2"), TIDEWELL_BOLD);
    const files = Object.fromEntries(
      Object.entries(opened.json.text as Record<string, string>).filter(([path]) => path.endsWith(".json")),
    );
    const stale = await call(
      "/_depthcue/api/save",
      "POST",
      JSON.stringify({ baseRev: opened.json.rev, files }),
      {
        "Content-Type": "application/json",
      },
    );
    expect(stale).toMatchObject({ status: 409, json: { error: "stale", rev: revOf(folder) } });
    expect(
      (
        await cli(
          "apply",
          folder,
          opsFile([{ op: "deck.set", set: { title: "x" } }]),
          "--base-rev",
          opened.json.rev,
        )
      ).code,
    ).toBe(3);

    // The revision an upload gives back is the one the next save names.
    const added = await upload(PNG, { kind: "image", name: "sea.png" });
    const saved = await call(
      "/_depthcue/api/save",
      "POST",
      JSON.stringify({ baseRev: added.json.rev, files }),
      {
        "Content-Type": "application/json",
      },
    );
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json.rev).toBe(revOf(folder));
  });

  it("sends the editor each brand file's hash, which is how the revision counts it", async () => {
    const opened = await call("/_depthcue/api/deck");
    expect(opened.json.text["brand/fonts/HarborSans-Bold.woff2"]).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.json.text["brand/fonts/OFL.txt"]).toBeUndefined();
    expect(opened.json.rev).toBe(revOf(folder));
  });
});

describe("depthcue brand add and remove", () => {
  it("writes the same bytes to the same path as the route, and answers the same", async () => {
    const other = copyDeck("v0-4-brand", "other");
    for (const [kind, bytes, name] of [
      ["font", TIDEWELL_BOLD, "Tidewell Bold.ttf"],
      ["logo", SAFE_SVG, "../mark.svg"],
      ["image", PNG, "Sea View.png"],
    ] as const) {
      const routed = await upload(bytes, { kind, name });
      const file = join(root, `upload-${kind}`);
      writeFileSync(file, bytes);
      const added = await cli("brand", "add", file, other, "--kind", kind, "--name", name, "--json");
      expect(added.code, added.err).toBe(0);
      expect(JSON.parse(added.out)).toEqual(routed.json);
      const path = `brand/${routed.json.path}`;
      expect(readFileSync(join(other, path)).equals(readFileSync(join(folder, path)))).toBe(true);
    }
    const removedRoute = await removal({ path: "images/Sea-View.png", baseRev: revOf(folder) });
    const removedCli = await cli(
      "brand",
      "remove",
      "images/Sea-View.png",
      other,
      "--base-rev",
      revOf(other),
      "--json",
    );
    expect(JSON.parse(removedCli.out)).toEqual(removedRoute.json);
    // Each refusal too, with the exit code a caller can branch on.
    const exists = await cli(
      "brand",
      "add",
      join(root, "upload-logo"),
      other,
      "--kind",
      "logo",
      "--name",
      "harbor.svg",
      "--json",
    );
    expect(exists.code).toBe(1);
    expect(JSON.parse(exists.out)).toEqual(
      (await upload(SAFE_SVG, { kind: "logo", name: "harbor.svg" })).json,
    );
    const stale = await cli(
      "brand",
      "add",
      join(root, "upload-logo"),
      other,
      "--kind",
      "logo",
      "--name",
      "harbor.svg",
      "--replace",
      "--base-rev",
      "0000000000000000",
    );
    expect(stale.code).toBe(3);
    expect(stale.err).toContain("changed after the revision");
  });

  it("names the file by its own name and says what it did", async () => {
    const file = join(root, "Coast Line.svg");
    writeFileSync(file, SAFE_SVG);
    const added = await cli("brand", "add", file, folder, "--kind", "image");
    expect(added.code, added.err).toBe(0);
    expect(added.out).toMatch(
      /^Added brand\/images\/Coast-Line\.svg \(svg\)\. Revision [0-9a-f]{16} -> [0-9a-f]{16}\.$/,
    );
    const again = await cli("brand", "add", file, folder, "--kind", "image");
    expect(again.out).toContain("is in the brand with these bytes already");
  });

  it("refuses arguments it does not take", async () => {
    const file = join(root, "x.png");
    writeFileSync(file, PNG);
    expect((await cli("brand", "add", file, folder)).code).toBe(2);
    expect((await cli("brand", "add", file, folder, "--kind", "logo", "--replace")).code).toBe(2);
    expect((await cli("brand", "add", file, folder, "--kind", "logo", "--force")).err).toContain(
      "brand add takes --kind and --name and --replace and --base-rev and --json, not --force.",
    );
    expect((await cli("brand", "remove", "logos/x.png", folder)).code).toBe(2);
    expect((await cli("brand", "use", folder, folder, "--kind", "logo")).err).toContain("not --kind");
    expect((await cli("check", folder, "--kind", "logo")).err).toContain("--kind belongs to brand add.");
    expect((await cli("brand", "add", join(root, "none.png"), folder, "--kind", "logo")).code).toBe(2);
  });

  it("is the agent's change in review, which accept takes and revert leaves", async () => {
    const accepted = await cli("diff", folder, "accept", "--all");
    expect(accepted.code, accepted.err).toBe(0);
    const file = join(root, "sea.png");
    writeFileSync(file, PNG);
    expect((await cli("brand", "add", file, folder, "--kind", "image")).code).toBe(0);
    const listed = JSON.parse((await cli("diff", folder, "--json")).out);
    expect(listed.changes).toMatchObject([{ id: "deck/file:images/sea.png", by: "agent", kind: "added" }]);
    const reverted = await cli("diff", folder, "revert", "deck/file:images/sea.png");
    expect(reverted.code).toBe(0);
    expect(reverted.out).toContain("Nothing to revert.");
    expect(reverted.out).toContain("left deck/file:images/sea.png: A brand file cannot be reverted");
    expect(existsSync(join(folder, "brand/images/sea.png"))).toBe(true);
    const json = JSON.parse((await cli("diff", folder, "revert", "--all", "--json")).out);
    expect(json.left).toEqual([
      { id: "deck/file:images/sea.png", why: expect.stringContaining("cannot be reverted") },
    ]);
    expect((await cli("diff", folder, "accept", "deck/file:images/sea.png")).code).toBe(0);
    expect(JSON.parse((await cli("diff", folder, "--json")).out).changes).toEqual([]);
  });

  it("a person's upload is theirs: it is no change to review", async () => {
    expect((await cli("diff", folder, "accept", "--all")).code).toBe(0);
    expect((await upload(PNG, { kind: "image", name: "sea.png" })).status).toBe(200);
    expect(JSON.parse((await cli("diff", folder, "--json")).out).changes).toEqual([]);
  });

  it("points an accept of a brand change at the file change it needs", async () => {
    expect((await cli("diff", folder, "accept", "--all")).code).toBe(0);
    const file = join(root, "mark.svg");
    writeFileSync(file, SAFE_SVG);
    const added = JSON.parse((await cli("brand", "add", file, folder, "--kind", "logo", "--json")).out);
    const set = await cli(
      "apply",
      folder,
      opsFile([{ op: "brand.set", set: { logos: { light: "logos/mark.svg", alt: "Mark" } } }]),
      "--base-rev",
      added.rev,
    );
    expect(set.code, set.err).toBe(0);
    const alone = await cli("diff", folder, "accept", "deck/brand/logos", "--json");
    expect(alone.code).toBe(1);
    expect(JSON.parse(alone.out).hint).toContain('"deck/file:logos/mark.svg"');
    expect((await cli("diff", folder, "accept", "deck/brand/logos", "deck/file:logos/mark.svg")).code).toBe(
      0,
    );
  });
});
