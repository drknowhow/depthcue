// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createSession, type DraftStore, loadDoc, memoryDraftStore, serializeDraft } from "@depthcue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckPayload } from "../src/api.ts";
import { openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

/*
 * The store with core's brand checks as the editor's build has them: until their chunk is in, readBrand answers that it
 * is waiting. The store fetches the chunk only when a check says so, then reads again.
 */
const checks = vi.hoisted(() => ({ loaded: false, loads: 0 }));

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
    checks.loaded = true;
  },
}));

beforeEach(() => {
  checks.loaded = false;
  checks.loads = 0;
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
