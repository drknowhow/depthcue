// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { type Doc, docToFiles, loadDoc, memoryDraftStore, revisionOf } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrandFileAnswer, DeckPayload, SaveOptions, SaveResult } from "../src/api.ts";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

const fixture = resolve(import.meta.dirname, "../../../fixtures/decks/v0-4-brand");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * The branded fixture, served as `depthcue edit` serves it: the brand folder's files listed with their hashes, which
 * the revision counts. A brand file call adds `brand/<kind>s/<name>` with the hash of what was sent, or removes one
 * that nothing names, and answers with the revisions before and after, as the real route does.
 */
class FileServer extends FakeServer {
  readonly brandFiles: string[] = [];
  /** Holds a save's answer until this settles, so a test can send a file while the save is out. */
  saveGate: Promise<void> | undefined;
  /** Makes the next brand file call answer with this instead of running. */
  nextBrandFile: BrandFileAnswer | undefined;
  /** What the server reads in a font that is sent. */
  font = { family: "Fixture Sans", weight: 700, italic: false };

  constructor() {
    super();
    const text: Record<string, string> = {};
    const walk = (at: string) => {
      for (const name of readdirSync(at)) {
        const full = join(at, name);
        const path = relative(fixture, full).split(sep).join("/");
        if (statSync(full).isDirectory()) walk(full);
        else if (path.endsWith(".json")) text[path] = readFileSync(full, "utf8");
        else if (/^brand\/(fonts|logos|images)\//.test(path)) {
          this.brandFiles.push(path);
          text[path] = sha256(readFileSync(full));
        }
      }
    };
    walk(fixture);
    this.text = text;
    this.assets = [];
  }

  /** The hashes the server sends beside the JSON. */
  #hashes(): Record<string, string> {
    return Object.fromEntries(this.brandFiles.map((path) => [path, this.text[path] as string]));
  }

  #load(text: Record<string, string>): Doc | null {
    return loadDoc({ text: { ...text, ...this.#hashes() }, assets: this.assets, brandFiles: this.brandFiles })
      .doc;
  }

  override get rev(): string {
    const doc = this.#load(this.text);
    if (!doc) throw new Error("the branded fixture should be valid");
    return revisionOf(doc);
  }

  override async loadDeck(): Promise<DeckPayload> {
    return {
      rev: this.rev,
      text: { ...this.text },
      assets: [],
      brandFiles: [...this.brandFiles],
      warnings: [],
    };
  }

  override async save(
    files: Record<string, string>,
    baseRev: string,
    options?: SaveOptions,
  ): Promise<SaveResult> {
    this.saves.push({ files, baseRev, options });
    await this.saveGate;
    if (baseRev !== this.rev)
      return { ok: false, kind: "stale", rev: this.rev, message: "The deck changed on disk." };
    const doc = this.#load(files);
    if (!doc) return { ok: false, kind: "rejected", message: "Invalid.", diagnostics: [] };
    this.text = { ...docToFiles(doc), ...this.#hashes() };
    return { ok: true, rev: this.rev };
  }

  override async brandFile(path: string, body: Blob | string): Promise<BrandFileAnswer> {
    this.brandCalls.push(path);
    if (this.nextBrandFile) {
      const answer = this.nextBrandFile;
      this.nextBrandFile = undefined;
      return answer;
    }
    const prevRev = this.rev;
    if (path === "/remove") {
      const sent = JSON.parse(body as string) as { path: string; baseRev: string };
      if (sent.baseRev !== prevRev) return { ok: false, error: "stale", message: "The deck changed." };
      const file = `brand/${sent.path}`;
      if (JSON.stringify(this.#load(this.text)?.brand).includes(JSON.stringify(sent.path)))
        return { ok: false, error: "in-use", message: `${file} is named by brand.json.` };
      this.brandFiles.splice(this.brandFiles.indexOf(file), 1);
      delete this.text[file];
      return { ok: true, path: sent.path, file, hash: null, prevRev, rev: this.rev };
    }
    const query = new URLSearchParams(path.slice(1));
    const name = `${query.get("kind")}s/${query.get("name")}`;
    const file = `brand/${name}`;
    const hash = sha256(Buffer.from(await (body as Blob).arrayBuffer()));
    if (!this.brandFiles.includes(file)) this.brandFiles.push(file);
    this.text[file] = hash;
    const sniffed = query.get("kind") === "font" ? { format: "woff2", ...this.font } : { format: "svg" };
    return { ok: true, path: name, file, hash, prevRev, rev: this.rev, sniffed, written: true };
  }
}

let server: FileServer;
let store: EditorStore;

beforeEach(async () => {
  server = new FileServer();
  store = await openStore(server, () => memoryDraftStore());
});

const upload = (name: string, bytes = name) =>
  store.brandFile(() => [`?kind=logo&name=${name}`, new Blob([bytes])]);

describe("a file sent to the brand folder, in the store", () => {
  it("is taken in, and a saved deck stays saved on the disk's new revision", async () => {
    const before = store.session.rev;
    const answer = await upload("mark.svg");
    expect(answer.ok).toBe(true);
    expect(store.session.doc.brandFiles?.has("brand/logos/mark.svg")).toBe(true);
    expect(store.saved.brandFiles?.has("brand/logos/mark.svg")).toBe(true);
    expect(store.session.rev).not.toBe(before);
    expect(store.session.rev).toBe(server.rev);
    expect([store.session.dirty, store.status.save]).toEqual([false, "saved"]);
  });

  it("leaves unsaved edits unsaved, and saves them on the revision the file left", async () => {
    store.session.apply([{ op: "brand.set", set: { name: "Harbor Two" } }]);
    const answer = await upload("mark.svg");
    expect(store.session.dirty).toBe(true);
    await store.save();
    expect(server.saves.at(-1)?.baseRev).toBe(answer.ok ? answer.rev : "an answer");
    expect([store.session.dirty, store.status.save, store.status.conflict]).toEqual([
      false,
      "saved",
      undefined,
    ]);
    expect(JSON.parse(server.text["brand/brand.json"] as string).name).toBe("Harbor Two");
  });

  it("waits for a save under way, and sends on the revision that save left", async () => {
    let release = () => {};
    server.saveGate = new Promise((done) => {
      release = done;
    });
    store.session.apply([{ op: "brand.set", set: { name: "Harbor Two" } }]);
    const saving = store.save();
    const sending = upload("mark.svg");
    await Promise.resolve();
    await Promise.resolve();
    expect(server.brandCalls).toEqual([]);
    release();
    await saving;
    expect((await sending).ok).toBe(true);
    expect(server.brandCalls).toHaveLength(1);
    expect([store.session.dirty, store.session.rev]).toEqual([false, server.rev]);
  });

  it("changes nothing when the server says no", async () => {
    const before = store.session.rev;
    server.nextBrandFile = { ok: false, error: "unsafe-svg", message: "The SVG has a script element." };
    expect(await upload("bad.svg")).toEqual({
      ok: false,
      error: "unsafe-svg",
      message: "The SVG has a script element.",
    });
    expect([store.session.rev, store.session.dirty]).toEqual([before, false]);
  });

  it("drops the steps History keeps outside the session, since every revision moved", async () => {
    const now = store.session.rev;
    store.history.push({ before: now, after: now, undo: () => undefined, redo: () => undefined });
    expect(store.history.canUndo).toBe(true);
    await upload("mark.svg");
    expect(store.history.canUndo).toBe(false);
  });

  it("takes a removed file out, with the revision on disk", async () => {
    await upload("spare.svg");
    const answer = await store.brandFile((rev) => [
      "/remove",
      JSON.stringify({ path: "logos/spare.svg", baseRev: rev }),
    ]);
    expect(answer.ok).toBe(true);
    expect(store.session.doc.brandFiles?.has("brand/logos/spare.svg")).toBe(false);
    expect([store.session.dirty, store.session.rev]).toEqual([false, server.rev]);
  });
});

describe("the brand folder's files in the Brand panel", () => {
  let host: HTMLElement;
  let editor: Editor;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.replaceChildren(host);
    editor = mountEditor(host, store);
    host.querySelector<HTMLElement>("[data-action='brand']")?.click();
  });
  afterEach(() => editor.destroy());

  const panel = () => host.querySelector(".ed-brand") as HTMLElement;
  const field = (key: string) => panel().querySelector(`[data-field='${key}']`) as HTMLElement;
  const said = () => (panel().querySelector(".ed-brand-said") as HTMLElement).textContent;
  const tab = (id: string) => panel().querySelector<HTMLElement>(`[data-tab='${id}']`)?.click();
  /** Chooses a file in a file field, as the file chooser does. */
  const choose = (key: string, name: string, bytes = name) => {
    const input = field(key) as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File([bytes], name)], configurable: true });
    input.dispatchEvent(new Event("change"));
  };
  const settled = () => new Promise((done) => setTimeout(done, 0));

  it("sends a logo and names it for its kind of slide, as one step of Undo, the deck still saved but for that", async () => {
    tab("logos");
    choose("brand:logos:dark:upload", "mark-dark.svg");
    await settled();
    expect(server.brandCalls).toEqual(["?kind=logo&name=mark-dark.svg"]);
    expect(store.session.doc.brand?.logos).toEqual({
      alt: "Harbor Analytics",
      light: "logos/harbor.svg",
      dark: "logos/mark-dark.svg",
    });
    expect(said()).toBe("");
    store.session.undo();
    expect(store.session.doc.brand?.logos?.dark).toBeUndefined();
    expect([store.session.doc.brandFiles?.has("brand/logos/mark-dark.svg"), store.session.dirty]).toEqual([
      true,
      false,
    ]);
  });

  it("says the server's refusal as it words it, and offers to replace a file of that name only when asked", async () => {
    tab("logos");
    server.nextBrandFile = {
      ok: false,
      error: "unsafe-svg",
      message: "logos/x.svg has an on* attribute (onload).",
    };
    choose("brand:logos:dark:upload", "x.svg");
    await settled();
    expect(said()).toBe("logos/x.svg has an on* attribute (onload).");
    expect(store.session.doc.brand?.logos?.dark).toBeUndefined();

    server.nextBrandFile = {
      ok: false,
      error: "exists",
      existing: "logos/harbor.svg",
      message: "brand/logos/harbor.svg is there already, with other bytes.",
    };
    choose("brand:logos:dark:upload", "harbor.svg", "other bytes");
    await settled();
    expect(said()).toContain("brand/logos/harbor.svg is there already, with other bytes.");
    expect(server.brandCalls.at(-1)).toBe("?kind=logo&name=harbor.svg");
    const rev = server.rev;
    field("brand:file:replace").click();
    await settled();
    expect(server.brandCalls.at(-1)).toBe(`?kind=logo&name=harbor.svg&replace=1&baseRev=${rev}`);
    expect(store.session.doc.brand?.logos?.dark).toBe("logos/harbor.svg");
  });

  it("adds a font file to a new face in the roles chosen, with the license written, and asks for the license first", async () => {
    tab("fonts");
    choose("brand:fonts:upload", "Fixture-Bold.woff2");
    await settled();
    expect(said()).toMatch(
      /^brand\/fonts\/Fixture-Bold\.woff2 is in the brand folder now\. A face the deck carries needs its license/,
    );
    const license = field("brand:fonts:file-license") as HTMLInputElement;
    license.value = "OFL-1.1";
    license.dispatchEvent(new Event("input"));
    choose("brand:fonts:upload", "Fixture-Bold.woff2");
    await settled();
    const fonts = store.session.doc.brand?.fonts;
    const face = {
      family: "Fixture Sans",
      license: "OFL-1.1",
      files: [{ file: "fonts/Fixture-Bold.woff2", weight: 700, style: "normal" }],
    };
    expect(typeof fonts === "object" ? [fonts.display, fonts.body] : fonts).toEqual([face, face]);
  });

  it("adds a font file of a family the brand has to that face, by its weight and style, with no license asked", async () => {
    server.font = { family: "Harbor Sans", weight: 400, italic: true };
    tab("fonts");
    choose("brand:fonts:upload", "HarborSans-Italic.woff2");
    await settled();
    expect(said()).toBe("");
    const fonts = store.session.doc.brand?.fonts;
    if (typeof fonts !== "object") throw new Error("the brand should have its own faces");
    expect(fonts.body.files).toEqual([
      { file: "fonts/HarborSans-Italic.woff2", weight: 400, style: "italic" },
      { file: "fonts/HarborSans-Regular.woff2", weight: 400, style: "normal" },
      { file: "fonts/HarborSans-Bold.woff2", weight: 700, style: "normal" },
    ]);
    expect(fonts.display.family).toBe("Harbor Display");
  });

  it("lists the folder's files, offers Delete only for one nothing names, and asks before it goes", async () => {
    await upload("spare.svg");
    tab("logos");
    const rows = [...panel().querySelectorAll<HTMLElement>(".ed-brand-files li")];
    expect(rows.map((row) => [row.dataset.file, row.textContent?.includes("In use")])).toEqual([
      ["logos/harbor.svg", true],
      ["logos/spare.svg", false],
    ]);
    field("brand:file:logos/spare.svg:remove").click();
    expect(said()).toMatch(/^Delete brand\/logos\/spare\.svg\?/);
    expect(server.brandCalls).toHaveLength(1);
    field("brand:file:delete").click();
    await settled();
    expect(server.brandCalls.at(-1)).toBe("/remove");
    expect(store.session.doc.brandFiles?.has("brand/logos/spare.svg")).toBe(false);
    expect(panel().querySelector("[data-file='logos/spare.svg']")).toBeNull();
  });
});
