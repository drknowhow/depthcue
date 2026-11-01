import type { Comment, CommentOp, Cue, Review } from "@depthcue/core";

export interface ApiDiagnostic {
  code: string;
  at: string;
  severity: "error" | "warning";
  message: string;
  fix?: string;
}

/** The deck as the server has it: the revision, the JSON files as text, and the files under assets/. */
export interface DeckPayload {
  rev: string;
  text: Record<string, string>;
  assets: string[];
  warnings: ApiDiagnostic[];
}

export type SaveResult =
  | { ok: true; rev: string }
  /** The files changed on disk after the editor loaded them; `rev` is what is there now. */
  | { ok: false; kind: "stale"; rev: string; message: string }
  | { ok: false; kind: "rejected" | "failed"; message: string; diagnostics: ApiDiagnostic[] };

/**
 * A clip's cues as the server has them. `none` is a clip with no cue map yet, and `broken` a file where the map
 * should be that the player cannot read, which the server never overwrites.
 */
export interface CueList {
  state: "none" | "broken" | "ok";
  cues: Cue[];
  /** Seconds. Only a clip with a cue map has one on record. */
  duration?: number;
}

/** What the browser measured of a video, sent when the clip has no cue map to take these from. */
export interface ClipSize {
  duration: number;
  width: number;
  height: number;
}

/**
 * The layout problems of one scene as a render of the saved deck finds them. `available: false` is a server with no
 * browser to render in, or a render that failed; the editor then has nothing to add to what it can see itself.
 */
export type LayoutAnswer =
  | { available: true; diagnostics: ApiDiagnostic[] }
  | { available: false; message: string };

/**
 * The comments beside the deck as the server has them, all of them, resolved ones included. `rev` is the comments' own
 * revision, to send back as the base of the next change. A file that is not valid, or a server that cannot be reached,
 * is `ok: false` with the reason, and the editor then shows no comments and writes none.
 */
export type CommentsAnswer = { ok: true; rev: string; comments: Comment[] } | { ok: false; message: string };

export type CommentsSaveResult =
  | { ok: true; rev: string; comments: Comment[] }
  /** The comments changed on disk after the editor read them; `rev` is what is there now. */
  | { ok: false; kind: "stale"; rev: string; message: string }
  | { ok: false; kind: "rejected" | "failed"; message: string };

/**
 * The review beside the deck as the server has it: the deck as it was last reviewed, and the ids of the changes the
 * agent made. `rev` is the revision to send back as the base of the next write, and `review` is undefined when nobody
 * has started a review. A file that is not valid, or a server that cannot be reached, is `ok: false` with the reason,
 * and the editor then lists no changes and writes nothing.
 */
export type ReviewAnswer =
  | { ok: true; rev: string; review: Review | undefined }
  | { ok: false; message: string };

export type ReviewSaveResult =
  | { ok: true; rev: string; review: Review }
  /** The review changed on disk after the editor read it; `rev` is what is there now. */
  | { ok: false; kind: "stale"; rev: string; message: string }
  | { ok: false; kind: "rejected" | "failed"; message: string };

/** Sent with a save: what the review needs to know that the files alone do not say. */
export interface SaveOptions {
  /** Changes the person reverted and then undid, so the server marks them as the agent's again and not as the person's. */
  keepAgent?: readonly string[];
}

/** What the editor needs from the server. A test can stand in for it. */
export interface Api {
  loadDeck(): Promise<DeckPayload>;
  save(files: Record<string, string>, baseRev: string, options?: SaveOptions): Promise<SaveResult>;
  /** Adds an image and returns its deck path, such as "assets/photo-1a2b3c4d.png". */
  uploadAsset(file: Blob, name: string): Promise<string>;
  /** The cues of a clip, named by its deck path such as "assets/intro.mp4". */
  loadCues(source: string): Promise<CueList>;
  /** Replaces a clip's cues. Rejects with a message the person can read when the server refuses the list. */
  saveCues(source: string, cues: readonly Cue[], clip?: ClipSize): Promise<{ cues: Cue[]; duration: number }>;
  /** What a render of the saved scene shows is wrong with it. Never rejects: a failure is `available: false`. */
  loadLayout(scene: string): Promise<LayoutAnswer>;
  /** The comments of the deck. Never rejects: a failure is `ok: false`. */
  loadComments(): Promise<CommentsAnswer>;
  /** Applies comment operations, all or none, against the revision the editor last read. */
  saveComments(ops: readonly CommentOp[], baseRev: string): Promise<CommentsSaveResult>;
  /** The review of the deck. Never rejects: a failure is `ok: false`. */
  loadReview(): Promise<ReviewAnswer>;
  /** Replaces the review, against the revision the editor last read. `"none"` is the revision of no review at all. */
  saveReview(review: Review, baseRev: string): Promise<ReviewSaveResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function body(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const messageOf = (answer: Record<string, unknown>, response: Response): string =>
  typeof answer.message === "string" ? answer.message : `The server answered ${response.status}.`;

const diagnosticsOf = (answer: Record<string, unknown>): ApiDiagnostic[] =>
  Array.isArray(answer.diagnostics) ? (answer.diagnostics as ApiDiagnostic[]) : [];

export function createApi(token: string, send: typeof fetch = (...args) => fetch(...args)): Api {
  const call = (path: string, init: RequestInit = {}) =>
    send(`/_depthcue/api/${path}`, {
      ...init,
      cache: "no-store",
      headers: { ...(init.headers as Record<string, string> | undefined), "X-Depthcue-Token": token },
    });

  return {
    async loadDeck() {
      const response = await call("deck");
      const answer = await body(response);
      if (!response.ok) {
        const first = diagnosticsOf(answer)[0];
        throw new Error(first ? `${first.at}: ${first.message}` : messageOf(answer, response));
      }
      return answer as unknown as DeckPayload;
    },

    async save(files, baseRev, options = {}) {
      let response: Response;
      const keepAgent = options.keepAgent ?? [];
      try {
        response = await call("save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseRev, files, ...(keepAgent.length > 0 ? { keepAgent } : {}) }),
        });
      } catch {
        return {
          ok: false,
          kind: "failed",
          message: "The editor could not reach the server. Is `depthcue edit` still running?",
          diagnostics: [],
        };
      }
      const answer = await body(response);
      if (response.ok) return { ok: true, rev: String(answer.rev) };
      if (response.status === 409) {
        return { ok: false, kind: "stale", rev: String(answer.rev), message: messageOf(answer, response) };
      }
      return {
        ok: false,
        kind: response.status === 422 ? "rejected" : "failed",
        message: messageOf(answer, response),
        diagnostics: diagnosticsOf(answer),
      };
    },

    async uploadAsset(file, name) {
      const response = await call(`asset?name=${encodeURIComponent(name)}`, { method: "POST", body: file });
      const answer = await body(response);
      if (!response.ok || typeof answer.asset !== "string") throw new Error(messageOf(answer, response));
      return answer.asset;
    },

    async loadCues(source) {
      const response = await call(`cues?source=${encodeURIComponent(source)}`);
      const answer = await body(response);
      if (!response.ok) throw new Error(messageOf(answer, response));
      return answer as unknown as CueList;
    },

    async saveCues(source, cues, clip) {
      let response: Response;
      try {
        response = await call("cues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, cues, clip }),
        });
      } catch {
        throw new Error("The editor could not reach the server. Is `depthcue edit` still running?");
      }
      const answer = await body(response);
      if (!response.ok || !Array.isArray(answer.cues)) throw new Error(messageOf(answer, response));
      return { cues: answer.cues as Cue[], duration: Number(answer.duration) };
    },

    async loadLayout(scene) {
      try {
        const response = await call(`layout?scene=${encodeURIComponent(scene)}`);
        const answer = await body(response);
        if (response.ok && answer.available === true && Array.isArray(answer.diagnostics)) {
          return { available: true, diagnostics: answer.diagnostics as ApiDiagnostic[] };
        }
        return { available: false, message: messageOf(answer, response) };
      } catch {
        return { available: false, message: "The editor could not reach the server." };
      }
    },

    async loadComments() {
      try {
        const response = await call("comments");
        const answer = await body(response);
        if (response.ok && typeof answer.rev === "string" && Array.isArray(answer.comments)) {
          return { ok: true, rev: answer.rev, comments: answer.comments as Comment[] };
        }
        return { ok: false, message: messageOf(answer, response) };
      } catch {
        return { ok: false, message: "The editor could not reach the server." };
      }
    },

    async saveComments(ops, baseRev) {
      let response: Response;
      try {
        response = await call("comments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseRev, ops }),
        });
      } catch {
        return {
          ok: false,
          kind: "failed",
          message: "The editor could not reach the server. Is `depthcue edit` still running?",
        };
      }
      const answer = await body(response);
      if (response.ok && typeof answer.rev === "string" && Array.isArray(answer.comments)) {
        return { ok: true, rev: answer.rev, comments: answer.comments as Comment[] };
      }
      if (response.status === 409) {
        return { ok: false, kind: "stale", rev: String(answer.rev), message: messageOf(answer, response) };
      }
      const first = diagnosticsOf(answer)[0];
      return {
        ok: false,
        kind: response.status === 422 ? "rejected" : "failed",
        message: first ? `${first.message}${first.fix ? ` ${first.fix}` : ""}` : messageOf(answer, response),
      };
    },

    async loadReview() {
      try {
        const response = await call("review");
        const answer = await body(response);
        if (response.ok && typeof answer.rev === "string") {
          return {
            ok: true,
            rev: answer.rev,
            review: isRecord(answer.review) ? (answer.review as unknown as Review) : undefined,
          };
        }
        return { ok: false, message: messageOf(answer, response) };
      } catch {
        return { ok: false, message: "The editor could not reach the server." };
      }
    },

    async saveReview(review, baseRev) {
      let response: Response;
      try {
        response = await call("review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseRev, review }),
        });
      } catch {
        return {
          ok: false,
          kind: "failed",
          message: "The editor could not reach the server. Is `depthcue edit` still running?",
        };
      }
      const answer = await body(response);
      if (response.ok && typeof answer.rev === "string" && isRecord(answer.review)) {
        return { ok: true, rev: answer.rev, review: answer.review as unknown as Review };
      }
      if (response.status === 409) {
        return { ok: false, kind: "stale", rev: String(answer.rev), message: messageOf(answer, response) };
      }
      return {
        ok: false,
        kind: response.status === 422 ? "rejected" : "failed",
        message: messageOf(answer, response),
      };
    },
  };
}
