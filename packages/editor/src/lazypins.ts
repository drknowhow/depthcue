import type { Scene, Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { CommentPins, CommentSurface } from "./commentpins.ts";
import { notLoaded, PARTS, type Part, withPart } from "./lazy.ts";

type Module = typeof import("./commentpins.ts");

/** The comments beside the deck, and the part that draws them on the slide. */
export interface PinSurface extends CommentSurface {
  part?: Part<Module>;
}

/**
 * The pins of the comments, whose code is a part of its own. It is fetched once the deck has a comment, or when the
 * person reaches for one: the Comment tool, a new comment on a block, a thread to open. What was asked for while it is
 * on its way is kept and done when it arrives, so no click is lost. When it does not arrive, `failed` says so, the tool
 * is off again, and the next reach tries again.
 */
export function lazyPins(
  session: Session,
  host: HTMLElement,
  overlay: HTMLElement,
  nodeOf: (id: string) => HTMLElement | undefined,
  surface: PinSurface,
  failed: (text: string) => void,
): CommentPins {
  const from = surface.part ?? PARTS.comments;
  const { book } = surface;
  // Where the layer of pins goes, so it stays under the toolbar that the editor adds to the overlay after it.
  const spot = h("i", { hidden: true });
  overlay.append(spot);
  let real: CommentPins | undefined;
  let scene: Scene | undefined;
  let shown = true;
  let resolved = false;
  let tool = false;
  let then: ((pins: CommentPins) => void) | undefined;
  let gone = false;

  const reach = (todo?: (pins: CommentPins) => void) => {
    if (todo) then = todo;
    withPart(
      from,
      (module) => {
        if (gone) return;
        if (!real) {
          real = module.createCommentPins(session, host, overlay, nodeOf, surface, spot);
          if (!shown) real.setShown(false);
          if (resolved) real.setShowResolved(true);
          real.draw(scene);
        }
        const next = then;
        then = undefined;
        next?.(real);
      },
      () => {
        if (gone) return;
        then = undefined;
        tool = false;
        surface.changed();
        failed(notLoaded("the comments"));
      },
    );
  };
  const unsubscribe = book.subscribe(() => {
    if (!real && book.state.comments.length > 0) reach();
  });
  if (from.ready || book.state.comments.length > 0) reach();

  /** Keeps a choice until the pins are in. */
  const keep = (set: () => void) => {
    set();
    surface.changed();
  };
  return {
    draw(next) {
      scene = next;
      real?.draw(next);
    },
    place: () => real?.place(),
    get tool() {
      return real ? real.tool : tool;
    },
    setTool(on) {
      if (real) real.setTool(on);
      else if (on) {
        keep(() => (tool = true));
        reach((pins) => pins.setTool(true));
      } else {
        then = undefined;
        keep(() => (tool = false));
      }
    },
    get shown() {
      return real ? real.shown : shown;
    },
    setShown(on) {
      if (real) real.setShown(on);
      else keep(() => (shown = on));
    },
    get showResolved() {
      return real ? real.showResolved : resolved;
    },
    setShowResolved(on) {
      if (real) real.setShowResolved(on);
      else keep(() => (resolved = on));
    },
    compose(id, at) {
      if (real) return real.compose(id, at);
      reach((pins) => pins.compose(id, at));
      return true;
    },
    open(id) {
      if (real) return real.open(id);
      reach((pins) => pins.open(id));
      return true;
    },
    close(refocus) {
      then = undefined;
      real?.close(refocus);
    },
    get isOpen() {
      return real?.isOpen === true;
    },
    destroy() {
      gone = true;
      unsubscribe();
      real?.destroy();
      spot.remove();
    },
  };
}
