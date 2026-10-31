import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Sends `body` as JSON. */
export const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // The rest of a body that was too large is still on its way; closing keeps the server from reading it.
    ...(status === 413 ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(body));
};

export function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A web page on another origin can send a request to a loopback server. A browser tells the server where a
 * request came from, so one that names another origin is refused. Callers that are not browsers send neither
 * header and pass this check; they have to present a secret as well.
 */
export function crossOrigin(request: IncomingMessage, origins: readonly string[]): string | undefined {
  const origin = request.headers.origin;
  if (origin !== undefined && !origins.includes(origin)) return "Cross-origin request refused.";
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return "Cross-origin request refused.";
  return undefined;
}

export class TooLarge extends Error {}

/**
 * Reads a request body of at most `limit` bytes. Past that it stops keeping the bytes and rejects with `TooLarge`,
 * but leaves the connection open, so the caller can still say why. A refusal for being too large closes the
 * connection once it has been sent (see `send`).
 */
export function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        chunks.length = 0;
        reject(new TooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
