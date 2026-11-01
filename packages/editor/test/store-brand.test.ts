// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  createSession,
  type DraftStore,
  loadDoc,
  memoryDraftStore,
  revisionOf,
  serializeDraft,
} from "@depthcue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckPayload } from "../src/api.ts";
import { CHECKS_FAILED, openStore } from "../src/store.ts";
import { FakeServer, retitle } from "./helpers.ts";

/*
 * The store with core's brand checks as the editor's build has them: until their chunk is in, readBrand answers that it
 * is waiting. The store fetches the chunk only when a check says so, then reads again. While `fail` is set the fetch
 * rejects, as the browser's import does when the network drops or the server has a newer build.
 */
const checks = vi.hoisted(() => ({ loaded: false, loads: 0, fail: false }));

vi.mock("../../core/src/brandcheck.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/src/brandcheck.ts")>();
  return {
    ...real,
    readBrand: (...args: Parameters<typeof real.readBrand>) =>
      checks.loaded
        ? real.readBrand(...args)
        : {
            diagnostics: [
              {
                severity: "error",
                code: "brand-checks-loading",
                file: "brand/brand.json",
                path: "",
                message: "",
                fix: "",
              },
            ],
          },
  };
});

vi.mock("../src/brandchecks.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/brandchecks.ts")>()),
  loadBrandChecks: async () => {
    checks.loads += 1;
    if (checks.fail) throw new TypeError("Failed to fetch dynamically imported module: brandcheck.js");
    checks.loaded = true;
  },
}));

beforeEach(() => {
  checks.loaded = false;
  checks.loads = 0;
  checks.fail = false;
});

const fixture = resolve(import.meta.dirname, "../../../fixtures/decks/v0-4-brand");

/** The branded fixture as the server sends it: its JSON as text, the brand's other files listed. */
function branded(): { text: Record<string, string>; brandFiles: string[] } {
  const text: Record<string, string> = {};
  const brandFiles: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const path = relative(fixture, full).split(sep).join("/");
      if (statSync(full).isDirectory()) walk(full);
      else if (path.endsWith(".json")) text[path] = readFileSync(full, "utf8");
      else brandFiles.push(path);
    }
  };
  walk(fixture);
  return { text, brandFiles };
}

/** The fake server, with files in the deck's brand folder that are not JSON. */
class BrandFilesServer extends FakeServer {
  readonly brandFiles: string[];

  constructor(brandFiles: string[]) {
    super();
    this.brandFiles = brandFiles;
  }

  override async loadDeck(): Promise<DeckPayload> {
    return { ...(await super.loadDeck()), brandFiles: [...this.brandFiles] };
  }
}

/** The fake server, serving the branded fixture. Its revision is worked out with the checks in, as the server's is. */
class BrandServer extends BrandFilesServer {
  readonly #rev: string;

  constructor() {
    const deck = branded();
    super(deck.brandFiles);
    this.text = deck.text;
    this.assets = [];
    this.#rev = withChecks(() => createSession(this.doc()).rev);
  }

  /** The fixture as core reads it with its brand checks in. */
  doc() {
    return withChecks(() => {
      const { doc } = loadDoc({ text: this.text, assets: [], brandFiles: this.brandFiles });
      if (!doc) throw new Error("the branded fixture should be valid");
      return doc;
    });
  }

  override get rev(): string {
    return this.#rev;
  }
}

/** The fake server, serving the demo deck until `brand()` swaps in the branded fixture, as an agent's edit would. */
class TurningServer extends BrandFilesServer {
  constructor() {
    super([]);
  }

  brand(): void {
    const deck = branded();
    this.text = deck.text;
    this.assets = [];
    this.brandFiles.splice(0, this.brandFiles.length, ...deck.brandFiles);
  }

  override get rev(): string {
    return withChecks(() => {
      const { doc } = loadDoc({ text: this.text, assets: this.assets, brandFiles: this.brandFiles });
      if (!doc) throw new Error("the fake server's deck should be valid");
      return revisionOf(doc);
    });
  }
}

function withChecks<T>(run: () => T): T {
  const before = checks.loaded;
  checks.loaded = true;
  try {
    return run();
  } finally {
    checks.loaded = before;
  }
}

describe("a deck's brand checks in the editor's store", () => {
  it("are not fetched for a deck without a brand", async () => {
    const store = await openStore(new FakeServer(), () => memoryDraftStore());
    expect(store.session.doc.brand).toBeUndefined();
    expect(checks.loads).toBe(0);
  });

  it("are fetched once a check of a deck with a brand waits for them, and the deck then opens", async () => {
    const server = new BrandServer();
    const store = await openStore(server, () => memoryDraftStore());
    expect(checks.loads).toBe(1);
    expect(store.session.doc.brand?.id).toBe("harbor");
    expect(store.session.rev).toBe(server.rev);
  });

  it("are fetched for a draft with a brand, which is kept rather than thrown away for want of them", async () => {
    const server = new BrandServer();
    const draftText = withChecks(() => {
      const session = createSession(server.doc());
      session.apply([{ op: "deck.set", set: { title: "A draft in its brand" } }]);
      return serializeDraft({ doc: session.doc, rev: session.rev, savedRev: session.rev }, new Date());
    });
    // The deck on disk is another, with no brand but its logo still in the brand folder: opening it checks no brand.
    const disk = new BrandFilesServer(server.brandFiles);
    const drafts: DraftStore = memoryDraftStore(draftText);
    const store = await openStore(disk, () => drafts);
    expect(checks.loads).toBe(1);
    expect(store.status.draft?.kind).toBe("stale");
    expect(drafts.read()).toBe(draftText);
    store.useDraft();
    expect(store.session.doc.deck.title).toBe("A draft in its brand");
    expect(store.session.doc.brand?.id).toBe("harbor");
  });
});

describe("brand checks the editor cannot fetch", () => {
  beforeEach(() => {
    checks.fail = true;
  });

  it("stop a deck with a brand from opening, saying to reload the page", async () => {
    await expect(openStore(new BrandServer(), () => memoryDraftStore())).rejects.toThrow(CHECKS_FAILED);
    expect(checks.loads).toBe(1);
  });

  it("stop a draft with a brand from opening, and the draft is kept for the next try", async () => {
    const server = new BrandServer();
    const draftText = withChecks(() => {
      const session = createSession(server.doc());
      session.apply([{ op: "deck.set", set: { title: "A draft in its brand" } }]);
      return serializeDraft({ doc: session.doc, rev: session.rev, savedRev: session.rev }, new Date());
    });
    const drafts: DraftStore = memoryDraftStore(draftText);
    await expect(openStore(new BrandFilesServer(server.brandFiles), () => drafts)).rejects.toThrow(
      CHECKS_FAILED,
    );
    expect(drafts.read()).toBe(draftText);
  });

  it("are not needed for a deck without a brand that has brand files left in its folder", async () => {
    const server = new FakeServer();
    server.text["brand/brand.json"] = readFileSync(join(fixture, "brand/brand.json"), "utf8");
    const store = await openStore(server, () => memoryDraftStore());
    expect(store.session.doc.brand).toBeUndefined();
    expect(store.status.save).toBe("saved");
    expect(checks.loads).toBe(0);
  });

  it("leave reloading the files as an error the editor shows, with the deck as it was", async () => {
    const server = new TurningServer();
    const store = await openStore(server, () => memoryDraftStore());
    server.brand();
    await store.takeDisk();
    expect(store.status).toMatchObject({ save: "error", message: CHECKS_FAILED });
    expect(store.session.doc.brand).toBeUndefined();
  });

  it("leave a sync from disk as an error, and the next sync takes the files in once the checks arrive", async () => {
    const server = new TurningServer();
    const store = await openStore(server, () => memoryDraftStore());
    server.brand();
    await store.syncFromDisk();
    expect(store.status).toMatchObject({ save: "error", message: CHECKS_FAILED });
    checks.fail = false;
    await store.syncFromDisk();
    expect(store.status).toMatchObject({ save: "saved", message: "Updated from the files on disk." });
    expect(store.session.doc.brand?.id).toBe("harbor");
  });

  it("let a save whose follow-up sync meets them finish, with the error, and not reject", async () => {
    const server = new TurningServer();
    const store = await openStore(server, () => memoryDraftStore());
    store.session.apply([retitle("Before the brand")]);
    server.duringSave = () => {
      server.duringSave = undefined;
      server.brand();
      void store.syncFromDisk(); // runs after the save, as a change event during it would
      store.session.apply([retitle("During the save")]); // owes another save
    };
    await expect(store.save()).resolves.toBeUndefined();
    expect(store.status).toMatchObject({ save: "error", message: CHECKS_FAILED });
    expect(checks.loads).toBe(1);
  });
});
