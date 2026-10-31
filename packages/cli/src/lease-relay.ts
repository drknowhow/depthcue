import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { crossOrigin, isRecord, readBody, sameToken, send, TooLarge } from "./http.ts";

export const RELAY_PREFIX = "/_depthcue/lease/";

/** The four things an agent can ask of the page. Each one is answered by the page, which holds the lease. */
export const RELAY_OPS = ["state", "renew", "submit", "release"] as const;
type Op = (typeof RELAY_OPS)[number];

const MAX_CALL_BYTES = 64 * 1024;

/** How long the server waits for the page. A command can run for 5 s inside the lease, and the rest answer at once. */
export const WAIT_MS: Record<Op, number> = { state: 3000, renew: 3000, release: 3000, submit: 8000 };

export interface RelayOptions {
  /** The secret an agent sends with each call. */
  token: string;
  /** The origins the page can have, for the same-origin check on its replies. Read per request. */
  origins: () => readonly string[];
  /** Replaces how long a call waits for the page. For tests. */
  waitMs?: Partial<Record<Op, number>>;
}

type Outcome = { result: unknown } | { code: "no-page" | "page-timeout"; message: string };

interface Pending {
  page: ServerResponse;
  settle(outcome: Outcome): void;
}

export interface LeaseRelay {
  /** A page that answers agent calls, reached through its open event stream. The newest page is the one an agent gets. */
  attach(page: ServerResponse): void;
  /** Handles `/_depthcue/lease/*`. Returns false when the path is not one of them. */
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  /** Answers every call that is waiting, as if the page had gone. */
  close(): void;
}

const isOp = (name: string): name is Op => (RELAY_OPS as readonly string[]).includes(name);

const refuse = (response: ServerResponse, status: number, code: string, message: string) =>
  send(response, status, { ok: false, code, message });

/**
 * Carries an agent's lease calls to the presenter's page and the page's answers back. The agent calls
 * `POST /_depthcue/lease/<op>` with the secret in `X-Depthcue-Token`; the server sends the call to the page as a
 * `lease` event on its event stream; the page runs it against its lease and posts the answer to
 * `/_depthcue/lease/reply`, which the server returns to the agent. The server decides nothing: the page holds the
 * lease, so a refusal, an expiry or a takeover is the page's answer, word for word.
 */
export function createLeaseRelay(options: RelayOptions): LeaseRelay {
  const pages: ServerResponse[] = [];
  const pending = new Map<string, Pending>();
  const wait = { ...WAIT_MS, ...options.waitMs };

  function call(op: Op, input: unknown): Promise<Outcome> {
    const page = pages.at(-1);
    if (!page) {
      return Promise.resolve({
        code: "no-page",
        message: "No page is open for this deck. Serve it with `depthcue serve` and keep its window open.",
      });
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          entry.settle({
            code: "page-timeout",
            message: "The page did not answer in time. Check that its window is open and not asleep.",
          }),
        wait[op],
      );
      const entry: Pending = {
        page,
        settle(outcome) {
          clearTimeout(timer);
          pending.delete(id);
          resolve(outcome);
        },
      };
      pending.set(id, entry);
      page.write(`event: lease\ndata: ${JSON.stringify({ id, op, input })}\n\n`);
    });
  }

  /** The JSON body of a request, or undefined once the refusal has been sent. */
  async function body(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    if (!String(request.headers["content-type"]).startsWith("application/json")) {
      refuse(response, 415, "bad-request", "Send application/json.");
      return undefined;
    }
    try {
      const text = (await readBody(request, MAX_CALL_BYTES)).toString("utf8");
      return text === "" ? {} : JSON.parse(text);
    } catch (error) {
      if (error instanceof TooLarge) refuse(response, 413, "too-large", "The call is too large.");
      else refuse(response, 400, "bad-request", "The body is not valid JSON.");
      return undefined;
    }
  }

  async function fromAgent(op: Op, request: IncomingMessage, response: ServerResponse) {
    if (!sameToken(request.headers["x-depthcue-token"] as string | undefined, options.token)) {
      return refuse(
        response,
        401,
        "unauthorized",
        "Missing or wrong token. Read it from the deck's link file.",
      );
    }
    const foreign = crossOrigin(request, options.origins());
    if (foreign) return refuse(response, 403, "cross-origin", foreign);
    const input = await body(request, response);
    if (input === undefined) return undefined;
    const outcome = await call(op, input);
    if ("result" in outcome) return send(response, 200, outcome.result);
    return refuse(response, outcome.code === "no-page" ? 503 : 504, outcome.code, outcome.message);
  }

  async function fromPage(request: IncomingMessage, response: ServerResponse) {
    // A custom header forces a CORS preflight, which this server never answers, so only the page's own script gets here.
    if (request.headers["x-depthcue-reply"] !== "1") {
      return refuse(response, 403, "forbidden", "Only the deck's page answers calls.");
    }
    const foreign = crossOrigin(request, options.origins());
    if (foreign) return refuse(response, 403, "cross-origin", foreign);
    const reply = await body(request, response);
    if (reply === undefined) return undefined;
    const entry = isRecord(reply) && typeof reply.id === "string" ? pending.get(reply.id) : undefined;
    if (!entry || !isRecord(reply))
      return refuse(response, 404, "not-found", "No call is waiting for that answer.");
    entry.settle({ result: reply.result });
    return send(response, 200, { ok: true });
  }

  return {
    attach(page) {
      pages.push(page);
      page.once("close", () => {
        const at = pages.indexOf(page);
        if (at >= 0) pages.splice(at, 1);
        for (const entry of [...pending.values()]) {
          if (entry.page === page)
            entry.settle({ code: "no-page", message: "The page closed before it answered." });
        }
      });
    },

    async handle(request, response, url) {
      if (!url.pathname.startsWith(RELAY_PREFIX)) return false;
      if (request.method !== "POST") {
        refuse(response, 405, "method", "Use POST.");
        return true;
      }
      const name = url.pathname.slice(RELAY_PREFIX.length);
      try {
        if (name === "reply") await fromPage(request, response);
        else if (isOp(name)) await fromAgent(name, request, response);
        else
          refuse(
            response,
            404,
            "not-found",
            `There is no such call. The calls are: ${RELAY_OPS.join(", ")}.`,
          );
      } catch (error) {
        refuse(response, 500, "server", (error as Error).message);
      }
      return true;
    },

    close() {
      for (const entry of [...pending.values()]) {
        entry.settle({ code: "no-page", message: "The server is shutting down." });
      }
      pages.length = 0;
    },
  };
}
