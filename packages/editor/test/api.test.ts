import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.ts";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch that answers every call the same way, and keeps what it was asked. */
function server(answer: () => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
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
