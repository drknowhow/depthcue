import { type Deck, parseTarget, type Scene } from "@depthcue/core";
import { h } from "./dom.ts";
import { formatRoute } from "./model.ts";
import { assetUrl, safeUrl } from "./safe.ts";

/** What a page needs to follow a library link: its entries, and the scenes a jump may land on. */
export interface LinkContext {
  assetBase: string;
  links?: Deck["links"];
  scenes?: readonly Scene[];
}

/** A library link as the page shows it: words, and where it goes. A path or a scene the deck lacks has no `href`. */
export interface Followed {
  title: string;
  href?: string;
  /** True when the address leaves the page, so it opens in a new tab. */
  outside: boolean;
  /** A place on the author's disk, which a browser cannot open: offered as text to copy. */
  path?: string;
}

const MAIL = /^(mailto|tel|sms):/;

/** The library link `id`, read for the page, or undefined when the deck has none by that id or its target is unsafe. */
export function followLink(ctx: LinkContext, id: string): Followed | undefined {
  const entry = ctx.links?.find((candidate) => candidate.id === id);
  const target = entry && parseTarget(entry.target);
  if (!entry || !target) return undefined;
  const title = entry.title;
  switch (target.kind) {
    case "address": {
      if (MAIL.test(target.href)) return { title, href: target.href, outside: false };
      const href = safeUrl(target.href);
      return href ? { title, href, outside: true } : undefined;
    }
    case "asset": {
      const href = assetUrl(ctx.assetBase, target.asset);
      return href ? { title, href, outside: true } : undefined;
    }
    case "scene": {
      const scenes = ctx.scenes ?? [];
      const scene = scenes.findIndex((candidate) => candidate.id === target.scene);
      if (scene < 0) return { title, outside: false };
      const at = target.step
        ? (scenes[scene]?.steps?.findIndex((step) => step.id === target.step) ?? -1)
        : -1;
      const href = formatRoute(scenes, { kind: "scene", position: { scene, step: at + 1 } });
      return { title, href, outside: false };
    }
    case "path":
      return { title, outside: false, path: target.path };
  }
}

/**
 * The link as an element: an anchor that opens outside the page in a new tab and carries `noopener noreferrer`, a jump
 * inside it, or, for a place on a disk, a button that copies the path. One that goes nowhere is its words.
 */
export function linkElement(followed: Followed, className = "dc-link"): HTMLElement {
  if (followed.href) {
    return h(
      "a",
      {
        class: className,
        href: followed.href,
        ...(followed.outside ? { target: "_blank", rel: "noopener noreferrer" } : {}),
      },
      followed.title,
    );
  }
  if (followed.path !== undefined) {
    const path = followed.path;
    const button = h(
      "button",
      {
        type: "button",
        class: `${className} dc-link-path`,
        title: path,
        "aria-label": `Copy the path ${path}`,
      },
      followed.title,
    );
    button.addEventListener("click", () => {
      navigator.clipboard?.writeText(path).catch(() => undefined);
    });
    return button;
  }
  return h("span", { class: className }, followed.title);
}
