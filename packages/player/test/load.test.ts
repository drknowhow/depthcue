// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PlayerSource, readDeckJson } from "../src/load.ts";
import { demoSource } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

const source = (overrides: Partial<PlayerSource> = {}): PlayerSource => ({
  ...demoSource(),
  assetBase: "/deck",
  ...overrides,
});

function answer(reply: { ok: boolean; status?: number; body?: unknown }) {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(url);
      return { ok: reply.ok, status: reply.status ?? 200, json: async () => reply.body };
    }),
  );
  return fetched;
}

describe("readDeckJson", () => {
  it("returns the copy the page holds, without a request", async () => {
    const fetched = answer({ ok: true, body: "from the folder" });
    const held = { cues: [] };
    const read = await readDeckJson(source({ files: { "assets/a.cues.json": held } }), "assets/a.cues.json");
    expect(read).toBe(held);
    expect(fetched).toEqual([]);
  });

  it("returns a held value even when it is falsy", async () => {
    const fetched = answer({ ok: true, body: "from the folder" });
    expect(await readDeckJson(source({ files: { "assets/a.json": null } }), "assets/a.json")).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("asks the folder for a file the page does not hold", async () => {
    const fetched = answer({ ok: true, body: { from: "folder" } });
    const read = await readDeckJson(source({ files: { "assets/other.json": 1 } }), "assets/a.json");
    expect(read).toEqual({ from: "folder" });
    expect(fetched).toEqual(["/deck/assets/a.json"]);
  });

  it("asks the folder when the page holds no files at all", async () => {
    const fetched = answer({ ok: true, body: [1] });
    expect(await readDeckJson(source(), "assets/a.json")).toEqual([1]);
    expect(fetched).toEqual(["/deck/assets/a.json"]);
  });

  it("does not take a name from the object's prototype for a held file", async () => {
    const fetched = answer({ ok: true, body: "folder" });
    await expect(readDeckJson(source({ files: {} }), "constructor")).rejects.toThrow(/not a file/);
    expect(fetched).toEqual([]);
  });

  it("rejects, naming the answer, when the folder has no such file", async () => {
    answer({ ok: false, status: 404 });
    await expect(readDeckJson(source(), "assets/a.json")).rejects.toThrow(
      "/deck/assets/a.json answered 404.",
    );
  });

  it("rejects a path outside assets/ instead of asking for it", async () => {
    const fetched = answer({ ok: true, body: {} });
    await expect(readDeckJson(source(), "deck.json")).rejects.toThrow(/not a file the deck can read/);
    await expect(readDeckJson(source(), "assets/../deck.json")).rejects.toThrow(/not a file/);
    expect(fetched).toEqual([]);
  });
});
