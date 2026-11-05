import type { Review } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch that answers every call the same way, and keeps what it was asked. */
function server(answer: () => Response | Promise<Response>) {
  const calls: { url: string; method: string | undefined; body: unknown; headers: Record<string, string> }[] =
    [];
  const send = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return answer();
  }) as unknown as typeof fetch;
  return { calls, api: createApi("secret", send) };
}

describe("asking the server for a scene's layout problems", () => {
  const found = {
    code: "overflow",
    at: "scenes/method.json/blocks/1",
    severity: "error",
    message: "Too tall.",
  };

  it("sends the scene and the token, and gives the diagnostics of an available answer", async () => {
    const { api, calls } = server(() => reply(200, { available: true, diagnostics: [found] }));
    expect(await api.loadLayout("a scene/with a slash")).toEqual({ available: true, diagnostics: [found] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/_depthcue/api/layout?scene=a%20scene%2Fwith%20a%20slash");
    expect(calls[0]?.headers["X-Depthcue-Token"]).toBe("secret");
  });

  it("gives the server's reason when it cannot render", async () => {
    const { api } = server(() => reply(200, { available: false, message: "No browser could be started." }));
    expect(await api.loadLayout("method")).toEqual({
      available: false,
      message: "No browser could be started.",
    });
  });

  it("is unavailable, with the server's words, when the server refuses the question", async () => {
    const { api } = server(() => reply(404, { error: "not-found", message: 'There is no scene "x".' }));
    expect(await api.loadLayout("x")).toEqual({ available: false, message: 'There is no scene "x".' });
  });

  it("is unavailable, and does not throw, when the server cannot be reached", async () => {
    const { api } = server(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await api.loadLayout("method")).toEqual({
      available: false,
      message: "The editor could not reach the server.",
    });
  });

  it("is unavailable when the answer is not what the server sends", async () => {
    const { api } = server(() => new Response("<html>", { status: 200 }));
    const answer = await api.loadLayout("method");
    expect(answer.available).toBe(false);
  });
});

describe("reading the audit log", () => {
  const entries = [{ id: "a", time: "2026-11-05T10:00:00.000Z", by: "agent", kind: "edit", summary: "x" }];

  it("reads the entries with the token and counts the lines that were skipped", async () => {
    const { api, calls } = server(() => reply(200, { entries, skipped: 2 }));
    expect(await api.loadAudit()).toEqual({ ok: true, entries, skipped: 2 });
    expect(calls[0]?.url).toBe("/_depthcue/api/audit");
    expect(calls[0]?.headers["X-Depthcue-Token"]).toBe("secret");
  });

  it("does not throw when the server cannot be reached, or sends something else", async () => {
    const down = server(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await down.api.loadAudit()).toEqual({
      ok: false,
      message: "The editor could not reach the server.",
    });
    const odd = server(() => reply(200, { nothing: true }));
    expect(await odd.api.loadAudit()).toMatchObject({ ok: false });
  });
});

describe("reading and writing the review", () => {
  const review = {
    format: "depthcue-review/1",
    rev: "0123456789abcdef",
    deck: { id: "demo" },
    scenes: {},
    agent: ["scene:a/title"],
  } as unknown as Review;

  it("reads the review with the token, and the revision to write against", async () => {
    const { api, calls } = server(() => reply(200, { rev: "abc", review }));
    expect(await api.loadReview()).toEqual({ ok: true, rev: "abc", review });
    expect(calls[0]?.url).toBe("/_depthcue/api/review");
    expect(calls[0]?.headers["X-Depthcue-Token"]).toBe("secret");
  });

  it("reads no review as the revision of none, with no review", async () => {
    const { api } = server(() => reply(200, { rev: "none", review: null }));
    expect(await api.loadReview()).toEqual({ ok: true, rev: "none", review: undefined });
  });

  it("says why when the file is not valid, with the server's words", async () => {
    const { api } = server(() =>
      reply(422, { error: "unreadable-review", message: "review.json is not valid." }),
    );
    expect(await api.loadReview()).toEqual({ ok: false, message: "review.json is not valid." });
  });

  it("does not throw when the server cannot be reached, or sends something else", async () => {
    const down = server(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await down.api.loadReview()).toEqual({
      ok: false,
      message: "The editor could not reach the server.",
    });
    const odd = server(() => reply(200, { nothing: true }));
    expect(await odd.api.loadReview()).toMatchObject({ ok: false });
  });

  it("writes the review against the revision it read, and gives back what was written", async () => {
    const { api, calls } = server(() => reply(200, { rev: "def", review }));
    expect(await api.saveReview(review, "abc")).toEqual({ ok: true, rev: "def", review });
    expect(calls[0]).toMatchObject({
      url: "/_depthcue/api/review",
      method: "POST",
      body: { baseRev: "abc", review },
    });
  });

  it("tells a review that moved on from one the server refused", async () => {
    const stale = server(() =>
      reply(409, { error: "stale", message: "The review changed on disk.", rev: "xyz" }),
    );
    expect(await stale.api.saveReview(review, "abc")).toEqual({
      ok: false,
      kind: "stale",
      rev: "xyz",
      message: "The review changed on disk.",
    });
    const refused = server(() => reply(422, { error: "invalid", message: "Not a review." }));
    expect(await refused.api.saveReview(review, "abc")).toEqual({
      ok: false,
      kind: "rejected",
      message: "Not a review.",
    });
    const broken = server(() => reply(500, { message: "Disk full." }));
    expect(await broken.api.saveReview(review, "abc")).toMatchObject({ ok: false, kind: "failed" });
  });

  it("says so, and does not throw, when the server cannot be reached for a write", async () => {
    const { api } = server(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await api.saveReview(review, "abc")).toMatchObject({ ok: false, kind: "failed" });
  });
});

describe("saving the deck", () => {
  it("sends the changes the agent still owns, when there are any", async () => {
    const { api, calls } = server(() => reply(200, { rev: "r2" }));
    await api.save({ "deck.json": "{}" }, "r1", { keepAgent: ["scene:a/title"] });
    expect(calls[0]?.body).toEqual({
      baseRev: "r1",
      files: { "deck.json": "{}" },
      keepAgent: ["scene:a/title"],
    });
  });

  it("sends nothing about them when there are none", async () => {
    const { api, calls } = server(() => reply(200, { rev: "r2" }));
    await api.save({ "deck.json": "{}" }, "r1");
    await api.save({ "deck.json": "{}" }, "r1", { keepAgent: [] });
    expect(calls[0]?.body).toEqual({ baseRev: "r1", files: { "deck.json": "{}" } });
    expect(calls[1]?.body).toEqual({ baseRev: "r1", files: { "deck.json": "{}" } });
  });
});
