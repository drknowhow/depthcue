import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { type ClientRequest, type IncomingMessage, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WAIT_MS } from "../src/lease-relay.ts";
import { builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

let root: string;
let server: RunningServer;
let open: Array<{ req: ClientRequest; res?: IncomingMessage }>;

interface Answer {
  status: number;
  json: Record<string, unknown>;
}

interface Call {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Send the agent's secret. Default true. */
  token?: boolean;
  /** Send the content type of JSON. Default true. */
  json?: boolean;
}

/** A raw request, so headers go out exactly as written. */
function call(path: string, init: Call = {}): Promise<Answer> {
  return new Promise((resolveAnswer, reject) => {
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${server.port}`,
      ...(init.json === false ? {} : { "Content-Type": "application/json" }),
      ...(init.token === false ? {} : { "X-Depthcue-Token": server.agentToken }),
      ...init.headers,
    };
    if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));
    const req = request(
      { host: "127.0.0.1", port: server.port, path, method: init.method ?? "POST", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // not JSON
          }
          resolveAnswer({ status: response.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const agent = (op: string, body: unknown = {}, init: Call = {}) =>
  call(`/_depthcue/lease/${op}`, { body: JSON.stringify(body), ...init });

const reply = (id: unknown, result: unknown, init: Call = {}) =>
  call("/_depthcue/lease/reply", {
    token: false,
    body: JSON.stringify({ id, result }),
    ...init,
    headers: { "X-Depthcue-Reply": "1", ...init.headers },
  });

type Seen = { id: string; op: string; input: unknown };

/** A page: holds the event stream open and hands each relayed call to `answer`, which says what to reply with. */
function connect(answer?: (seen: Seen) => unknown, lease = true): Promise<{ calls: Seen[]; close(): void }> {
  return new Promise((resolveOpen, reject) => {
    const calls: Seen[] = [];
    const req = request({
      host: "127.0.0.1",
      port: server.port,
      path: `/_depthcue/events${lease ? "?lease=1" : ""}`,
      headers: { Host: `127.0.0.1:${server.port}` },
    });
    const entry: { req: ClientRequest; res?: IncomingMessage } = { req };
    open.push(entry);
    let buffer = "";
    req.on("response", (res) => {
      entry.res = res;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!block.startsWith("event: lease\ndata: ")) continue;
          const seen = JSON.parse(block.slice("event: lease\ndata: ".length)) as Seen;
          calls.push(seen);
          if (answer) {
            const result = answer(seen);
            if (result !== undefined) void reply(seen.id, result);
          }
        }
      });
      // The server writes its first bytes straight away, so the page is attached once they arrive.
      res.once("data", () => resolveOpen({ calls, close: () => req.destroy() }));
    });
    // Closing the stream from the test is an error to the request, and is not a failure.
    req.on("error", (error) => {
      if (!entry.res) reject(error);
    });
    req.end();
  });
}

beforeEach(async () => {
  open = [];
  root = mkdtempSync(join(tmpdir(), "depthcue-relay-"));
  const folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  server = await startServer({
    folder,
    playerDir: builtPlayerDir(),
    port: 0,
    leaseWaitMs: { state: 400, renew: 400, release: 400, submit: 600 },
  });
});

afterEach(async () => {
  for (const { req } of open) req.destroy();
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the lease relay", () => {
  it("carries a call to the page and the page's answer back, word for word", async () => {
    const page = await connect((seen) => ({ ok: true, echoed: seen.input, op: seen.op }));
    const answer = await agent("submit", { action: "next", sequence: 3 });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ ok: true, echoed: { action: "next", sequence: 3 }, op: "submit" });
    expect(page.calls).toHaveLength(1);
  });

  it("relays all four calls, and no others", async () => {
    await connect((seen) => ({ op: seen.op }));
    for (const op of ["state", "renew", "submit", "release"]) {
      expect((await agent(op)).json).toEqual({ op });
    }
    const unknown = await agent("grant");
    expect(unknown.status).toBe(404);
    expect(unknown.json.code).toBe("not-found");
    expect(String(unknown.json.message)).toContain("state, renew, submit, release");
  });

  it("returns the page's refusal as an answer, not as a failure of the link", async () => {
    await connect(() => ({ ok: false, code: "stale-epoch", message: "You were taken over." }));
    const answer = await agent("submit", {});
    expect(answer.status).toBe(200);
    expect(answer.json.code).toBe("stale-epoch");
  });

  it("keeps simultaneous calls apart", async () => {
    await connect((seen) => ({ n: (seen.input as { n: number }).n }));
    const answers = await Promise.all([1, 2, 3, 4, 5].map((n) => agent("renew", { n })));
    expect(answers.map((one) => one.json.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses a call without the secret, or with a wrong one, and never reaches the page", async () => {
    const page = await connect((seen) => ({ op: seen.op }));
    const none = await agent("state", {}, { token: false });
    expect(none.status).toBe(401);
    expect(none.json.code).toBe("unauthorized");
    const wrong = await agent("state", {}, { headers: { "X-Depthcue-Token": `${server.agentToken}x` } });
    expect(wrong.status).toBe(401);
    const editor = await agent("state", {}, { headers: { "X-Depthcue-Token": "" } });
    expect(editor.status).toBe(401);
    expect(page.calls).toEqual([]);
  });

  it("refuses a call that a web page on another origin sent, even with the secret", async () => {
    const page = await connect((seen) => ({ op: seen.op }));
    for (const headers of [{ Origin: "http://evil.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
      const answer = await agent("state", {}, { headers });
      expect(answer.status).toBe(403);
      expect(answer.json.code).toBe("cross-origin");
    }
    expect(page.calls).toEqual([]);
    const own = await agent("state", {}, { headers: { Origin: `http://127.0.0.1:${server.port}` } });
    expect(own.status).toBe(200);
  });

  it("says so when no page is open, and when the open page does not hold a lease", async () => {
    const none = await agent("state");
    expect(none.status).toBe(503);
    expect(none.json.code).toBe("no-page");
    // A page with no lease script, as a deck served by an older player would be, opens the stream without ?lease=1.
    await connect(() => ({ op: "never" }), false);
    expect((await agent("state")).status).toBe(503);
  });

  it("times out when the page does not answer, and says why", async () => {
    const page = await connect();
    const started = Date.now();
    const answer = await agent("state");
    expect(answer.status).toBe(504);
    expect(answer.json.code).toBe("page-timeout");
    // The test shortens the wait to 400 ms; the real one is 3 s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(page.calls).toHaveLength(1);
    // The answer that comes too late has nothing to land on.
    const late = await reply(page.calls[0]?.id, { ok: true });
    expect(late.status).toBe(404);
  });

  it("lets a submit wait longer than a renew, since a command can run for seconds", async () => {
    const page = await connect();
    const slow = agent("submit", {});
    await new Promise((done) => setTimeout(done, 450));
    expect(page.calls).toHaveLength(1);
    await reply(page.calls[0]?.id, { ok: true });
    expect((await slow).status).toBe(200);
  });

  it("answers a waiting call at once when the page closes, instead of waiting out the timer", async () => {
    const page = await connect();
    const waiting = agent("submit", {});
    await new Promise((done) => setTimeout(done, 100));
    page.close();
    const started = Date.now();
    const answer = await waiting;
    expect(answer.status).toBe(503);
    expect(answer.json.code).toBe("no-page");
    expect(String(answer.json.message)).toContain("closed");
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("sends calls to the newest page, and falls back to the older one when the newest closes", async () => {
    const older = await connect((seen) => ({ page: "older", op: seen.op }));
    const newer = await connect((seen) => ({ page: "newer", op: seen.op }));
    expect((await agent("state")).json.page).toBe("newer");
    newer.close();
    await new Promise((done) => setTimeout(done, 100));
    expect((await agent("state")).json.page).toBe("older");
    expect(older.calls).toHaveLength(1);
  });

  it("leaves a call alone when some other page closes", async () => {
    const older = await connect();
    const newer = await connect();
    const waiting = agent("state");
    await new Promise((done) => setTimeout(done, 50));
    older.close();
    await new Promise((done) => setTimeout(done, 100));
    await reply(newer.calls[0]?.id, { op: "state" });
    expect((await waiting).json).toEqual({ op: "state" });
    expect(older.calls).toHaveLength(0);
  });

  it("waits 3 s for the page to answer state, renew and release, and 8 s for submit", () => {
    expect(WAIT_MS).toEqual({ state: 3000, renew: 3000, release: 3000, submit: 8000 });
  });

  it("answers the calls that are waiting when the server shuts down", async () => {
    await connect();
    const waiting = agent("submit", {});
    await new Promise((done) => setTimeout(done, 100));
    await server.close();
    const answer = await waiting;
    expect(answer.status).toBe(503);
    expect(String(answer.json.message)).toContain("shutting down");
  });

  it("allows only POST", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const answer = await call("/_depthcue/lease/state", { method });
      expect(answer.status).toBe(405);
    }
  });

  it("wants JSON, bounded in size", async () => {
    await connect((seen) => ({ op: seen.op }));
    const text = await agent("state", {}, { json: false, headers: { "Content-Type": "text/plain" } });
    expect(text.status).toBe(415);
    const broken = await call("/_depthcue/lease/state", { body: "{not json" });
    expect(broken.status).toBe(400);
    const empty = await call("/_depthcue/lease/state", { body: "" });
    expect(empty.status).toBe(200);
    const huge = await call("/_depthcue/lease/state", { body: JSON.stringify({ pad: "x".repeat(70_000) }) });
    expect(huge.status).toBe(413);
    expect(huge.json.code).toBe("too-large");
  });

  describe("the page's answers", () => {
    it("are taken only with the page's header, which a web page on another origin cannot send", async () => {
      const page = await connect();
      const waiting = agent("state");
      await new Promise((done) => setTimeout(done, 50));
      const id = page.calls[0]?.id;
      const bare = await call("/_depthcue/lease/reply", {
        token: false,
        body: JSON.stringify({ id, result: { forged: true } }),
      });
      expect(bare.status).toBe(403);
      const foreign = await reply(id, { forged: true }, { headers: { Origin: "http://evil.example" } });
      expect(foreign.status).toBe(403);
      expect(foreign.json.code).toBe("cross-origin");
      await reply(id, { genuine: true });
      expect((await waiting).json).toEqual({ genuine: true });
    });

    it("do not need the secret, since the page never holds it", async () => {
      const page = await connect();
      const waiting = agent("state");
      await new Promise((done) => setTimeout(done, 50));
      expect((await reply(page.calls[0]?.id, { ok: 1 })).status).toBe(200);
      expect((await waiting).status).toBe(200);
    });

    it("settle a call once, and refuse an id nobody is waiting on", async () => {
      const page = await connect();
      const waiting = agent("state");
      await new Promise((done) => setTimeout(done, 50));
      const id = page.calls[0]?.id;
      expect((await reply(id, { n: 1 })).status).toBe(200);
      expect((await reply(id, { n: 2 })).status).toBe(404);
      expect((await waiting).json).toEqual({ n: 1 });
      expect((await reply("not-a-call", {})).status).toBe(404);
      expect((await reply(undefined, {})).status).toBe(404);
      expect(
        (
          await call("/_depthcue/lease/reply", {
            token: false,
            headers: { "X-Depthcue-Reply": "1" },
            body: "[]",
          })
        ).status,
      ).toBe(404);
    });
  });
});
