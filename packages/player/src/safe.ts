/**
 * Deck files are data from an author or an agent, so nothing in them is trusted just because the validator
 * would have caught it. The player builds DOM with textContent and runs every URL through these two checks.
 */

/** A link target the player will follow: http or https only. */
export function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** An asset path inside the deck folder: starts with assets/ and never climbs out of it. */
export function assetUrl(base: string, path: string): string | undefined {
  if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path) || path.includes("..")) return undefined;
  return `${base.replace(/\/+$/, "")}/${path}`;
}
