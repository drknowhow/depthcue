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
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOps,
  type Doc,
  loadDoc,
  type Op,
  REVIEW_FILE,
  readReview,
  reviewChanges,
  reviewToText,
  revisionOf,
  startReview,
} from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyToFolder } from "../src/deck-api.ts";
import { exportDeck } from "../src/export.ts";
import { loadDeckDir } from "../src/loader.ts";
import { loadReviewDir, recordAgentWrite, recordPersonWrite, saveReviewDir } from "../src/review-file.ts";
import { ChangedOnDiskError, saveDeckDir } from "../src/save.ts";
import { builtPlayerDir, builtStandaloneDir, type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

/** A phrase no part of the deck or the page contains, so finding it anywhere means the review leaked there. */
const MARKER = "zebra-marker-7f3a";

let root: string;
let deck: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-review-"));
  deck = join(root, "deck");
  cpSync(demo, deck, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const doc = (): Doc => {
  const { doc: loaded } = loadDoc(loadDeckDir(deck));
  if (!loaded) throw new Error("the demo deck should load");
  return loaded;
};
const file = () => join(deck, REVIEW_FILE);
const title = (text: string): Op => ({ op: "deck.set", set: { title: text } });
const lead = (value: "human" | "agent" | "shared"): Op => ({
  op: "scene.set",
  id: "opening",
  set: { lead: value },
});

/** An edit as the agent makes it: through `applyToFolder`, which is what `deck_apply` and `depthcue apply` call. */
function agent(...ops: Op[]) {
  const outcome = applyToFolder(deck, ops, revisionOf(doc()));
  if (!outcome.ok) throw new Error(`the edit should apply: ${JSON.stringify(outcome.diagnostics)}`);
  return outcome;
}

function review() {
  const read = loadReviewDir(deck);
  if (!read.ok || read.review === undefined) throw new Error("there should be a review");
  return read.review;
}

/** Every file under a folder, as forward-slash paths. */
const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();

const everything = (dir: string): string =>
  listing(dir)
    .map((path) => readFileSync(join(dir, path), "latin1"))
    .join("\n");

const deckBytes = () => JSON.stringify(loadDeckDir(deck).text);

describe("the review file beside a deck", () => {
  it("reads as no review when there is no file, and is not made by being read", () => {
    expect(loadReviewDir(deck)).toEqual({ ok: true, review: undefined });
    expect(existsSync(file())).toBe(false);
  });

  it("is started by the agent's first edit, from the deck as it was just before the edit", () => {
    const before = doc();
    const outcome = agent(title("A new title"));
    const kept = review();
    expect(kept.rev).toBe(revisionOf(before));
    expect(kept.deck.title).toBe(before.deck.title);
    expect(kept.agent).toEqual(["deck/title"]);
    expect(readFileSync(file(), "utf8")).toBe(reviewToText(kept));
    expect(outcome.diagnostics.filter((d) => d.code === "review-not-recorded")).toEqual([]);
    expect(listing(deck).filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("is not started by an edit that changes nothing", () => {
    agent(title("Why channel B now leads"));
    expect(existsSync(file())).toBe(false);
  });

  it("keeps the first baseline through later edits, and marks each change the agent makes", () => {
    const original = doc();
    agent(title("One"));
    agent(lead("agent"));
    agent(title("Two"));
    const kept = review();
    expect(kept.rev).toBe(revisionOf(original));
    expect(kept.agent).toEqual(["deck/title", "scene:opening/lead"]);
    expect(reviewChanges(kept, doc()).map((c) => [c.id, c.by])).toEqual([
      ["deck/title", "agent"],
      ["scene:opening/lead", "agent"],
    ]);
  });

  it("tells what was done by hand from what the agent did", () => {
    agent(title("One"));
    const scene = join(deck, "scenes", "method.json");
    writeFileSync(scene, readFileSync(scene, "utf8").replace("method-diagram", "method-picture"));
    const handEdited = reviewChanges(review(), doc());
    expect(handEdited.find((c) => c.id === "deck/title")?.by).toBe("agent");
    expect(handEdited.some((c) => c.by === "outside")).toBe(true);
    agent(lead("agent"));
    expect(review().agent).toEqual(["deck/title", "scene:opening/lead"]);
  });

  it("is written whole or not at all, and refuses to replace a file that moved after it was read", () => {
    const start = startReview(doc());
    saveReviewDir(deck, undefined, start);
    expect(loadReviewDir(deck)).toEqual({ ok: true, review: start });
    // A file appeared after the writer saw none.
    expect(() => saveReviewDir(deck, undefined, { ...start, agent: ["deck/title"] })).toThrow(
      ChangedOnDiskError,
    );
    // The file is not the one that was read.
    expect(() => saveReviewDir(deck, { ...start, agent: ["x"] }, start)).toThrow(ChangedOnDiskError);
    saveReviewDir(deck, start, { ...start, agent: ["deck/title"] });
    expect(review().agent).toEqual(["deck/title"]);
  });

  it("refuses to write a review that was read when the file has gone since", () => {
    const start = startReview(doc());
    expect(() => saveReviewDir(deck, start, { ...start, agent: ["deck/title"] })).toThrow(ChangedOnDiskError);
    expect(existsSync(file())).toBe(false);
  });

  it("refuses to write over a file that is not valid, because it may be a hand edit worth keeping", () => {
    writeFileSync(file(), "{ not json");
    expect(() => saveReviewDir(deck, undefined, startReview(doc()))).toThrow(ChangedOnDiskError);
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
  });
});

describe("an edit when the review cannot be updated", () => {
  it("still changes the deck, leaves the file as it was and says so as a warning", () => {
    writeFileSync(file(), "{ not json");
    const before = doc();
    const outcome = agent(title("Changed anyway"));
    expect(doc().deck.title).toBe("Changed anyway");
    expect(revisionOf(doc())).not.toBe(revisionOf(before));
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
    const warning = outcome.diagnostics.find((d) => d.code === "review-not-recorded");
    expect(warning).toMatchObject({ severity: "warning", file: REVIEW_FILE });
    expect(warning?.message).toContain("review.json is not valid");
  });

  it("reports a review it cannot read or write as a warning too", () => {
    const before = doc();
    const after = applyOps(before, [title("X")], revisionOf(before));
    if (!after.ok) throw new Error("the edit should apply");
    // A directory where the file goes cannot be replaced by a write.
    mkdirSync(file());
    const warnings = recordAgentWrite(deck, before, after.doc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("review-not-recorded");
  });

  it("makes no warning and no file for a write that changed nothing", () => {
    expect(recordAgentWrite(deck, doc(), doc())).toEqual([]);
    expect(existsSync(file())).toBe(false);
  });
});

describe("a person's save", () => {
  const person = (...ops: Op[]) => {
    const before = doc();
    const result = applyOps(before, ops, revisionOf(before));
    if (!result.ok) throw new Error("the edit should apply");
    recordPersonWrite(deck, before, result.doc);
    return result.doc;
  };

  it("starts no review: with nothing to compare with, there is nothing to fold into", () => {
    person(title("Mine"));
    expect(existsSync(file())).toBe(false);
  });

  it("is folded into the reviewed deck, so it is never listed as a change", () => {
    agent(title("Agent's"));
    const before = doc();
    const mine = applyOps(before, [lead("shared")], revisionOf(before));
    if (!mine.ok) throw new Error("the edit should apply");
    // The editor's save writes the files and then records the write.
    saveDeckDir(deck, before, mine.doc);
    recordPersonWrite(deck, before, mine.doc);
    expect(reviewChanges(review(), doc()).map((c) => [c.id, c.by])).toEqual([["deck/title", "agent"]]);
    expect(review().scenes.opening?.lead).toBe("shared");
  });

  it("changes nothing in the review when it changed nothing in the deck", () => {
    agent(title("Agent's"));
    const text = readFileSync(file(), "utf8");
    recordPersonWrite(deck, doc(), doc());
    expect(readFileSync(file(), "utf8")).toBe(text);
  });

  it("leaves a review that is not valid as it is", () => {
    writeFileSync(file(), "{ not json");
    person(title("Mine"));
    expect(readFileSync(file(), "utf8")).toBe("{ not json");
  });
});

describe("the review is not part of the deck", () => {
  /** A review whose reviewed deck has a phrase in it that the deck on disk does not. */
  function markedReview() {
    const base = doc();
    const marked = applyOps(
      base,
      [{ op: "block.set", scene: "opening", id: "opening-title", set: { text: MARKER } }],
      revisionOf(base),
    );
    if (!marked.ok) throw new Error("the edit should apply");
    writeFileSync(file(), reviewToText(startReview(marked.doc)));
  }

  it("does not touch the deck's files or its revision, whatever is done to the review", () => {
    const before = { bytes: deckBytes(), rev: revisionOf(doc()), files: listing(deck) };
    markedReview();
    expect(deckBytes()).toBe(before.bytes);
    expect(revisionOf(doc())).toBe(before.rev);
    expect(listing(deck).filter((path) => path !== REVIEW_FILE)).toEqual(before.files);
  });

  it("is not read when the deck is loaded, even when the file is broken", () => {
    markedReview();
    const folder = loadDeckDir(deck);
    expect(Object.keys(folder.text).sort()).toEqual([
      "deck.json",
      "scenes/demand.json",
      "scenes/method.json",
      "scenes/opening.json",
    ]);
    expect(JSON.stringify(folder)).not.toContain(MARKER);
    const clean = loadDoc(loadDeckDir(deck));
    writeFileSync(file(), "{ not json");
    const broken = loadDoc(loadDeckDir(deck));
    expect(broken.diagnostics).toEqual(clean.diagnostics);
    expect(broken.doc && revisionOf(broken.doc)).toBe(clean.doc && revisionOf(clean.doc));
  });

  it("is left out of an export, which is the same with a review as without", () => {
    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "depthcue.js"), "/* the script */");
    writeFileSync(join(runtime, "depthcue.css"), "/* the styles */");
    const exportTo = (name: string) => {
      const result = exportDeck({ folder: deck, out: join(root, name), runtimeDir: runtime });
      if (!result.ok) throw new Error(`the export failed: ${JSON.stringify(result.diagnostics)}`);
      return result.summary;
    };
    const without = exportTo("without");
    markedReview();
    const withReview = exportTo("with");
    expect(listing(join(root, "with"))).toEqual(listing(join(root, "without")));
    expect(listing(join(root, "with"))).not.toContain(REVIEW_FILE);
    expect(withReview).toMatchObject({ files: without.files, bytes: without.bytes, assets: without.assets });
    expect(everything(join(root, "with"))).not.toContain(MARKER);
  });
});

describe("a server leaves the review alone", () => {
  let server: RunningServer;
  const get = (path: string) =>
    new Promise<{ status: number; body: string }>((resolveAnswer, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path, headers: { Host: `127.0.0.1:${server.port}` } },
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
    const base = doc();
    const marked = applyOps(
      base,
      [{ op: "block.set", scene: "opening", id: "opening-title", set: { text: MARKER } }],
      revisionOf(base),
    );
    if (!marked.ok) throw new Error("the edit should apply");
    writeFileSync(file(), reviewToText(startReview(marked.doc)));
    server = await startServer({ folder: deck, playerDir: player, editorDir: editor, port: 0 });
  });
  afterEach(() => server.close());

  it("does not serve review.json, by any spelling of the path", async () => {
    for (const path of [
      "/review.json",
      "/Review.json",
      "/scenes/review.json",
      "/assets/review.json",
      "/assets/../review.json",
      "/%72eview.json",
      "/_depthcue/review.json",
    ]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain(MARKER);
    }
  });

  it("puts nothing of it in the pages it serves", async () => {
    for (const path of ["/", "/present", "/?presenter", "/deck.json", "/scenes/opening.json"]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(200);
      expect(answer.body, path).not.toContain(MARKER);
    }
  });

  it("tells no page to reload when only the review changes", async () => {
    const events: string[] = [];
    const listener = request({
      host: "127.0.0.1",
      port: server.port,
      path: "/_depthcue/events?comments=1",
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
      writeFileSync(file(), reviewToText(startReview(doc())));
      await new Promise((wait) => setTimeout(wait, 300));
      expect(events.join("")).not.toContain("event:");
      // The same wait does see a change to the deck itself, so the silence above means something.
      const scene = join(deck, "scenes", "method.json");
      writeFileSync(scene, `${readFileSync(scene, "utf8")} `);
      await new Promise((wait) => setTimeout(wait, 300));
      expect(events.join("")).toContain("event: change");
    } finally {
      listener.destroy();
    }
  });

  it("tells an editor that asked about the review, on an event of its own and for nothing else", async () => {
    const asked: string[] = [];
    const notAsked: string[] = [];
    const open = (query: string, into: string[]) => {
      const listener = request({
        host: "127.0.0.1",
        port: server.port,
        path: `/_depthcue/events?${query}`,
        headers: { Host: `127.0.0.1:${server.port}` },
      });
      return new Promise<ReturnType<typeof request>>((started, fail) => {
        listener.on("response", (response) => {
          response.setEncoding("utf8");
          response.on("data", (chunk) => into.push(String(chunk)));
          started(listener);
        });
        listener.on("error", fail);
        listener.end();
      });
    };
    const editor = await open("comments=1&review=1", asked);
    const other = await open("comments=1", notAsked);
    try {
      writeFileSync(file(), reviewToText(startReview(doc())));
      await new Promise((wait) => setTimeout(wait, 300));
      expect(asked.join("")).toContain("event: review");
      expect(asked.join("")).not.toContain("event: change");
      expect(notAsked.join("")).not.toContain("event:");
    } finally {
      editor.destroy();
      other.destroy();
    }
  });
});

describe("the built player does not carry the review code", () => {
  it.each([
    ["the player", builtPlayerDir],
    ["the standalone page", builtStandaloneDir],
  ])("%s has no review format and no review message in any script", (_name, dir) => {
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
        REVIEW_FILE,
        "depthcue-review",
        "unknown-change",
        "rev-mismatch",
        "review-not-recorded",
      ]) {
        expect(text.includes(word), `${path} contains ${word}`).toBe(false);
      }
    }
  });

  it("reads a review the way core does", () => {
    expect(readReview(reviewToText(startReview(doc()))).ok).toBe(true);
  });
});
