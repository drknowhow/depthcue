import type { Comment, CommentOp } from "@depthcue/core";
import type { Api } from "./api.ts";

export interface CommentState {
  /** Every comment, the resolved ones too, in file order. Empty until the first read and while the file cannot be read. */
  readonly comments: readonly Comment[];
  /** Why there are no comments to show, when the file or the server could not be read. */
  readonly problem: string | undefined;
  /** False until the first read has finished, so "no comments" is not said before the answer is in. */
  readonly ready: boolean;
}

export type Applied =
  /** `added` holds the ids the file did not have before. A comment the person just wrote is among them. */
  { ok: true; added: string[] } | { ok: false; message: string };

export interface CommentBook {
  readonly state: CommentState;
  subscribe(listener: () => void): () => void;
  /** Reads the comments again. Call it when the server says they changed, and when the connection comes back. */
  sync(): Promise<void>;
  /**
   * Applies operations, all or none, one call at a time. The revision is the one last read; when the file moved on in
   * the meantime the comments are read again and the operations are sent once more against what is there. Resolves
   * with why when they are refused, and leaves what is shown as the file has it.
   */
  apply(ops: readonly CommentOp[]): Promise<Applied>;
  dispose(): void;
}

/**
 * The comments beside the deck. They are a file of their own with a revision of their own, so they are kept apart from
 * the session: a comment is never an undo step, never a draft and never changes the deck's revision. Writing goes
 * through the server, which runs the same operations `deck_comment` runs, so what the person writes is read by an agent
 * exactly as one it wrote itself.
 */
export function createCommentBook(api: Pick<Api, "loadComments" | "saveComments">): CommentBook {
  let comments: readonly Comment[] = [];
  let problem: string | undefined;
  let ready = false;
  /** The revision the comments shown were read at, or undefined while nothing usable has been read. */
  let rev: string | undefined;
  /** Counts finished writes, so a read that a write overtook can be told apart and thrown away. */
  let epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  async function read(): Promise<void> {
    const seen = epoch;
    const answer = await api.loadComments();
    if (disposed || epoch !== seen) return; // a write finished while the file was being read, so this may predate it
    ready = true;
    if (answer.ok) {
      rev = answer.rev;
      problem = undefined;
      comments = answer.comments;
    } else {
      // Nothing from a file that cannot be read is guessed at, and nothing is written over it.
      rev = undefined;
      problem = answer.message;
      comments = [];
    }
    notify();
  }

  async function send(ops: readonly CommentOp[]): Promise<Applied> {
    if (rev === undefined) {
      return { ok: false, message: problem ?? "The comments have not been read yet. Try again in a moment." };
    }
    const known = () => new Set(comments.map((comment) => comment.id));
    let before = known();
    let result = await api.saveComments(ops, rev);
    if (!result.ok && result.kind === "stale") {
      // Somebody else wrote since this was read. A comment depends on no other, so it is sent again on top of theirs.
      // What they wrote is not the person's, so the ids that count as new are the ones this second write adds.
      epoch += 1;
      await read();
      if (rev === undefined) return { ok: false, message: problem ?? result.message };
      before = known();
      result = await api.saveComments(ops, rev);
    }
    epoch += 1;
    if (result.ok) {
      rev = result.rev;
      comments = result.comments;
      problem = undefined;
      notify();
      return { ok: true, added: result.comments.map((c) => c.id).filter((id) => !before.has(id)) };
    }
    // Refused: what is shown may be what the refusal is about, such as a comment that is gone.
    void read();
    return { ok: false, message: result.message };
  }

  return {
    get state() {
      return { comments, problem, ready };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync: read,
    apply(ops) {
      const run = queue.then(() => send(ops));
      queue = run.catch(() => undefined);
      return run;
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
