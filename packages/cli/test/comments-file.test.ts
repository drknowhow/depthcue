import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMENTS_FILE,
  type CommentOp,
  commentsRevision,
  commentsToText,
  emptyComments,
  loadDoc,
  readComments,
  revisionOf,
} from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCommentsDir, loadCommentsDir, saveCommentsDir } from "../src/comments-file.ts";
import { exportDeck } from "../src/export.ts";
import { loadDeckDir } from "../src/loader.ts";
import { ChangedOnDiskError } from "../src/save.ts";
import { builtPlayerDir, builtStandaloneDir, type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

/** A phrase no part of the deck or the page contains, so finding it anywhere means a comment leaked there. */
const MARKER = "zebra-marker-7f3a";
const NOW = "2026-11-01T10:00:00.000Z";

let root: string;
let deck: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-comments-"));
  deck = join(root, "deck");
  cpSync(demo, deck, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const doc = () => {
  const { doc: loaded } = loadDoc(loadDeckDir(deck));
  if (!loaded) throw new Error("the demo deck should load");
  return loaded;
};
const add = (text = "Check this label."): CommentOp => ({
  op: "comment.add",
  scene: "method",
  block: "method-diagram",
  anchor: { x: 0.5, y: 0.5 },
  author: "you",
  text,
});
const file = () => join(deck, COMMENTS_FILE);
const rev = () => {
  const read = loadCommentsDir(deck);
  if (read.file === null) throw new Error("the comments should read");
  return commentsRevision(read.file);
};
const apply = (ops: CommentOp[], baseRev = rev()) => applyCommentsDir(deck, ops, baseRev, doc(), () => NOW);
const done = (ops: CommentOp[]) => {
  const result = apply(ops);
  if (!result.ok) throw new Error(`the comments should apply: ${JSON.stringify(result.diagnostics)}`);
  return result;
};

/** Every file under a folder, as forward-slash paths. */
const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();

/** The text of every file under a folder, to look for a phrase in any of them. */
const everything = (dir: string): string =>
  listing(dir)
    .map((path) => readFileSync(join(dir, path), "latin1"))
    .join("\n");

/** The bytes of the deck itself: its manifest and scenes. */
const deckBytes = () => {
  const { text } = loadDeckDir(deck);
  return JSON.stringify(text);
};

describe("the comments file beside a deck", () => {
  it("reads as no comments when there is no file, and does not make one by being read", () => {
    expect(loadCommentsDir(deck)).toEqual({ file: emptyComments(), diagnostics: [] });
    expect(existsSync(file())).toBe(false);
  });

  it("is written by the first comment, as two-space JSON that reads back, and not by anything else", () => {
    const result = done([add()]);
    expect(readFileSync(file(), "utf8")).toBe(commentsToText(result.file));
    expect(loadCommentsDir(deck).file).toEqual(result.file);
    expect(result.rev).toBe(rev());
    expect(listing(deck).filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("changes with each comment, and the revision it gives is the one the next edit must name", () => {
    const first = done([add("One")]);
    const second = done([add("Two")]);
    expect(second.prevRev).toBe(first.rev);
    expect(second.file.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    const stale = apply([add("Three")], first.rev);
    expect(stale).toMatchObject({ ok: false, code: "stale-revision", rev: second.rev });
    expect(readComments(readFileSync(file(), "utf8")).file?.comments).toHaveLength(2);
  });

  it("leaves the file as it is, byte for byte, when the operations change nothing", () => {
    const first = done([add(), { op: "comment.resolve", id: "c1" }]);
    // Hand-format the file the way an author might: the content is the same, the bytes are not.
    const text = JSON.stringify(first.file);
    writeFileSync(file(), text);
    const before = statSync(file()).mtimeMs;
    const result = apply([{ op: "comment.resolve", id: "c1" }]);
    expect(result).toMatchObject({ ok: true, changed: [] });
    expect(readFileSync(file(), "utf8")).toBe(text);
    expect(statSync(file()).mtimeMs).toBe(before);
  });

  it("writes nothing when the operations are refused", () => {
    done([add()]);
    const text = readFileSync(file(), "utf8");
    const refused = apply([add(), { op: "comment.delete", id: "nope" }]);
    expect(refused).toMatchObject({ ok: false, code: "bad-op" });
    expect(readFileSync(file(), "utf8")).toBe(text);
  });

  it("refuses to work on a file that is not valid, and does not overwrite it", () => {
    writeFileSync(file(), "{ not json");
    const result = apply([add()], "0000000000000000");
    expect(result).toMatchObject({ ok: false, code: "invalid-comments" });
    expect(result.ok ? [] : result.diagnostics[0]).toMatchObject({ code: "json-parse", file: COMMENTS_FILE });
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
  });

  it("refuses to save over a file that changed after it was read", () => {
    const first = done([add()]);
    const next = done([add("Two")]);
    // `first.file` is what a slow writer read; the file on disk has since moved on.
    expect(() => saveCommentsDir(deck, first.file, { ...first.file, comments: [] })).toThrow(
      ChangedOnDiskError,
    );
    expect(loadCommentsDir(deck).file).toEqual(next.file);
    // Saving from what is on disk goes through.
    saveCommentsDir(deck, next.file, first.file);
    expect(loadCommentsDir(deck).file).toEqual(first.file);
  });

  it("refuses to save over a file that was written invalid after it was read", () => {
    writeFileSync(file(), "{ not json");
    expect(() => saveCommentsDir(deck, emptyComments(), emptyComments())).toThrow(ChangedOnDiskError);
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
  });
});

describe("comments are not part of the deck", () => {
  it("does not touch the deck's files or its revision, whatever is done to the comments", () => {
    const before = {
      bytes: deckBytes(),
      rev: revisionOf(doc()),
      files: listing(deck).filter((p) => p !== COMMENTS_FILE),
    };
    done([add(), add("Two")]);
    done([
      { op: "comment.reply", id: "c1", author: "agent", text: "Looks right." },
      { op: "comment.resolve", id: "c2" },
    ]);
    done([{ op: "comment.delete", id: "c1" }]);
    expect(deckBytes()).toBe(before.bytes);
    expect(revisionOf(doc())).toBe(before.rev);
    expect(listing(deck).filter((path) => path !== COMMENTS_FILE)).toEqual(before.files);
  });

  it("is not read when the deck is loaded: the folder listing has deck.json and scenes, not comments.json", () => {
    writeFileSync(file(), commentsToText(done([add(MARKER)]).file));
    const folder = loadDeckDir(deck);
    expect(Object.keys(folder.text).sort()).toEqual([
      "deck.json",
      "scenes/demand.json",
      "scenes/method.json",
      "scenes/opening.json",
    ]);
    expect([...folder.assets].every((path) => path.startsWith("assets/"))).toBe(true);
    expect(JSON.stringify(folder)).not.toContain(MARKER);
  });

  it("is not read when the deck is loaded, even when the file is broken", () => {
    const clean = loadDoc(loadDeckDir(deck));
    writeFileSync(file(), "{ not json");
    const broken = loadDoc(loadDeckDir(deck));
    expect(broken.diagnostics).toEqual(clean.diagnostics);
    expect(broken.doc && revisionOf(broken.doc)).toBe(clean.doc && revisionOf(clean.doc));
  });
});

describe("an export leaves the comments behind", () => {
  const runtime = () => {
    const dir = join(root, "runtime");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "depthcue.js"), "/* the script */");
    writeFileSync(join(dir, "depthcue.css"), "/* the styles */");
    return dir;
  };
  const exportTo = (name: string) => {
    const result = exportDeck({ folder: deck, out: join(root, name), runtimeDir: runtime() });
    if (!result.ok) throw new Error(`the export failed: ${JSON.stringify(result.diagnostics)}`);
    return result.summary;
  };

  it("holds the same files, the same page and the same summary with comments as without", () => {
    const without = exportTo("without");
    const without_html = readFileSync(join(root, "without", "index.html"), "utf8");
    done([add(MARKER), add(`${MARKER} again`)]);
    done([{ op: "comment.reply", id: "c1", author: "agent", text: MARKER }]);
    const withComments = exportTo("with");
    expect(listing(join(root, "with"))).toEqual(listing(join(root, "without")));
    expect(listing(join(root, "with"))).not.toContain(COMMENTS_FILE);
    expect(withComments).toMatchObject({
      files: without.files,
      bytes: without.bytes,
      assets: without.assets,
    });
    expect(readFileSync(join(root, "with", "index.html"), "utf8")).toBe(without_html);
    expect(everything(join(root, "with"))).not.toContain(MARKER);
  });
});

describe("a server leaves the comments alone", () => {
  let server: RunningServer;
  const get = (path: string, host?: string) =>
    new Promise<{ status: number; body: string }>((resolveAnswer, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path, headers: { Host: host ?? `127.0.0.1:${server.port}` } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolveAnswer({ status: response.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });

  beforeEach(async () => {
    const player = join(root, "player");
    const editor = join(root, "editor");
    mkdirSync(player);
    mkdirSync(editor);
    writeFileSync(join(player, "app.js"), "export {};");
    writeFileSync(join(editor, "editor.js"), "export {};");
    done([add(MARKER)]);
    server = await startServer({ folder: deck, playerDir: player, editorDir: editor, port: 0 });
  });
  afterEach(() => server.close());

  it("does not serve comments.json, by any spelling of the path", async () => {
    for (const path of [
      "/comments.json",
      "/Comments.json",
      "/scenes/comments.json",
      "/assets/comments.json",
      "/assets/../comments.json",
      "/%63omments.json",
      "/_depthcue/comments.json",
    ]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain(MARKER);
    }
  });

  it("puts no comment in the pages it serves, the deck window, the presenter or the editor", async () => {
    for (const path of ["/", "/present", "/?presenter", "/deck.json", "/scenes/method.json"]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(200);
      expect(answer.body, path).not.toContain(MARKER);
    }
  });

  it("does not tell a page to reload when only the comments change", async () => {
    const events: string[] = [];
    const listener = request({
      host: "127.0.0.1",
      port: server.port,
      path: "/_depthcue/events",
      headers: { Host: `127.0.0.1:${server.port}` },
    });
    try {
      await new Promise<void>((started, fail) => {
        listener.on("response", (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk) => events.push(String(chunk)));
          started();
        });
        listener.on("error", fail);
        listener.end();
      });
      done([add("Another")]);
      await new Promise((wait) => setTimeout(wait, 300));
      expect(events.join("")).not.toContain("event: change");
      // The same wait does see a change to the deck itself, so the silence above means something.
      const scene = join(deck, "scenes", "method.json");
      writeFileSync(scene, `${readFileSync(scene, "utf8")} `);
      await new Promise((wait) => setTimeout(wait, 300));
      expect(events.join("")).toContain("event: change");
    } finally {
      listener.destroy();
    }
  });
});

describe("the built player does not carry the comments code", () => {
  it.each([
    ["the player", builtPlayerDir],
    ["the standalone page", builtStandaloneDir],
  ])("%s has no comment format and no comment operations in any script", (_name, dir) => {
    const built = dir();
    const scripts = existsSync(built) ? listing(built).filter((path) => path.endsWith(".js")) : [];
    if (scripts.length === 0) {
      // CI builds first, so it must not skip. A machine that has not built can run everything else.
      if (process.env.CI) throw new Error(`Nothing is built in ${built}. Run pnpm build.`);
      return;
    }
    for (const path of scripts) {
      const text = readFileSync(join(built, path), "utf8");
      for (const word of [
        COMMENTS_FILE,
        "depthcue-comments",
        "comment.add",
        "comment.reply",
        "orphaned-comment",
      ]) {
        // A boolean, so a failure names the file and the word and does not print a minified script.
        expect(text.includes(word), `${path} contains ${word}`).toBe(false);
      }
    }
  });
});
