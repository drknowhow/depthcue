import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** What an agent needs to reach a deck that is being served: where it is and the secret for its lease calls. */
export interface Link {
  url: string;
  token: string;
  pid: number;
}

/**
 * Where the link for a deck folder is kept: a file in the temporary directory named by the folder's real path, so
 * the server and an agent working on the same folder find each other without any setup, and nothing secret lands
 * in the folder, where it could be committed.
 */
export function linkPath(folder: string): string {
  let real = realpathSync.native(resolve(folder));
  if (process.platform === "win32") real = real.toLowerCase();
  return join(
    tmpdir(),
    "depthcue-links",
    `${createHash("sha256").update(real).digest("hex").slice(0, 20)}.json`,
  );
}

/** Publishes the link and returns a function that removes it, but only if it is still this server's. */
export function writeLink(folder: string, link: Link): () => void {
  const path = linkPath(folder);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(link), { mode: 0o600 });
  return () => {
    if (readLink(folder)?.token === link.token) rmSync(path, { force: true });
  };
}

export function readLink(folder: string): Link | undefined {
  try {
    const parsed = JSON.parse(readFileSync(linkPath(folder), "utf8")) as Partial<Link>;
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string" || typeof parsed.pid !== "number")
      return undefined;
    return { url: parsed.url, token: parsed.token, pid: parsed.pid };
  } catch {
    return undefined;
  }
}
