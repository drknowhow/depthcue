import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyCommentOps,
  applyOps,
  type CommentOp,
  type CommentsFile,
  type Cue,
  checkCues,
  commentsRevision,
  cueMapPath,
  docToFiles,
  emptyComments,
  foldEdit,
  loadDoc,
  type Op,
  type Review,
  readReview,
  recordAgentEdit,
  reviewRevision,
  reviewToText,
  revisionOf,
  startReview,
} from "@depthcue/core";
import type {
  Api,
  ApiDiagnostic,
  ClipSize,
  CommentsAnswer,
  CommentsSaveResult,
  CueList,
  DeckPayload,
  LayoutAnswer,
  ReviewAnswer,
  ReviewSaveResult,
  SaveOptions,
  SaveResult,
} from "../src/api.ts";
import { loadParts } from "../src/lazy.ts";

// The tests that drive the editor start with every part it fetches on first use already in, as in a session that has
// used them all, so what they check is what the part does. lazy.test.ts drives the fetch, and what a failed one does.
await loadParts();

// happy-dom replaces the global URL, so the path is built from dirname rather than from import.meta.url.
// The old sample deck: three scenes, all schema 0.1. Tests read this copy, so the sample deck in
// fixtures/decks/demo can show new features without moving them.
export const demoDir = resolve(import.meta.dirname, "../../../fixtures/decks/v0-1");

function readDemo(): { text: Record<string, string>; assets: string[] } {
  const text: Record<string, string> = { "deck.json": readFileSync(join(demoDir, "deck.json"), "utf8") };
  for (const name of readdirSync(join(demoDir, "scenes"))) {
    text[`scenes/${name}`] = readFileSync(join(demoDir, "scenes", name), "utf8");
  }
  return { text, assets: readdirSync(join(demoDir, "assets")).map((name) => `assets/${name}`) };
}

/** A stand-in for `depthcue edit`: it keeps the deck's files in memory and answers like the real server. */
export class FakeServer implements Api {
  text: Record<string, string>;
  assets: string[];
  saves: Array<{ files: Record<string, string>; baseRev: string; options: SaveOptions | undefined }> = [];
  uploads: string[] = [];
  loads = 0;
  /** Makes the next save answer with this instead of running. */
  nextSave: SaveResult | undefined;
  /** Makes loadDeck throw while true, like a file caught half-written. */
  loadFails = false;
  /** Runs inside a save before it answers, so a test can change the world mid-request. */
  duringSave: (() => void) | undefined;
  /** Holds loadDeck's answer, which is read when the call is made, until this settles. */
  loadGate: Promise<void> | undefined;
  /** Cue maps by video path, as `depthcue clip build` or the editor left them. */
  cueMaps: Record<string, { duration: number; width: number; height: number; cues: Cue[] }> = {};
  /** Videos whose cue file is there but is not a cue map. */
  brokenCues = new Set<string>();
  cueLoads: string[] = [];
  cueSaves: Array<{ source: string; cues: Cue[]; clip: ClipSize | undefined }> = [];
  /** Makes loadCues throw while true, like a server that cannot be reached. */
  cueLoadFails = false;
  /** Makes the next saveCues refuse with this message. */
  nextCueSaveFails: string | undefined;
  /** Holds loadCues' answers, which are read when the call is made, until this settles. */
  cueGate: Promise<void> | undefined;
  /** The scenes a render was asked about, in order. */
  layoutCalls: string[] = [];
  /** What a render finds wrong with a scene. Nothing, unless a test says so. */
  layouts: Record<string, ApiDiagnostic[]> = {};
  /** Makes loadLayout answer that no render can be made, like a machine with no browser. */
  noRender = false;
  /** Holds loadLayout's answers until this settles. */
  layoutGate: Promise<void> | undefined;
  /** The comments file, as the server keeps it. It is `undefined` until a comment is written, like a missing file. */
  comments: CommentsFile = emptyComments();
  /** Makes loadComments answer that the file cannot be read, with this message, like a comments.json that is not valid. */
  commentsBroken: string | undefined;
  commentLoads = 0;
  commentSaves: Array<{ ops: CommentOp[]; baseRev: string }> = [];
  /** Makes the next saveComments answer with this instead of running. */
  nextCommentSave: CommentsSaveResult | undefined;
  /** Runs inside a comment save before it answers, so a test can change the comments mid-request. */
  duringCommentSave: (() => void) | undefined;
  /** Holds loadComments' answers, which are read when the call is made, until this settles. */
  commentGate: Promise<void> | undefined;
  /** The time written into a new message. A test sets it to know what it will read back. */
  clock = "2026-11-01T10:00:00.000Z";
  /** The review file, as the server keeps it. `undefined` is no file: nobody has started a review. */
  review: Review | undefined;
  /** Makes loadReview answer that the file cannot be read, with this message, like a review.json that is not valid. */
  reviewBroken: string | undefined;
  reviewLoads = 0;
  reviewSaves: Array<{ review: Review; baseRev: string }> = [];
  /** Makes the next saveReview answer with this instead of running. */
  nextReviewSave: ReviewSaveResult | undefined;
  /** Runs inside a review save before it answers, so a test can change the review mid-request. */
  duringReviewSave: (() => void) | undefined;
  /** Holds loadReview's answers, which are read when the call is made, until this settles. */
  reviewGate: Promise<void> | undefined;

  constructor() {
    const demo = readDemo();
    this.text = demo.text;
    this.assets = demo.assets;
  }

  get rev(): string {
    const { doc } = loadDoc({ text: this.text, assets: this.assets });
    if (!doc) throw new Error("the fake server's deck should be valid");
    return revisionOf(doc);
  }

  /** An edit made behind the editor's back, as an agent would make it. */
  external(ops: Op[]): string {
    const { doc } = loadDoc({ text: this.text, assets: this.assets });
    if (!doc) throw new Error("the fake server's deck should be valid");
    const result = applyOps(doc, ops, revisionOf(doc));
    if (!result.ok) throw new Error(`the external edit was refused: ${result.diagnostics[0]?.message}`);
    this.text = docToFiles(result.doc);
    return result.rev;
  }

  /**
   * An edit made through the agent's tools: the files change and the review marks what changed as the agent's, the way
   * `deck_apply` leaves them. A review is started from the deck as it was if nobody had.
   */
  agentEdit(ops: Op[]): string {
    const { doc } = loadDoc({ text: this.text, assets: this.assets });
    if (!doc) throw new Error("the fake server's deck should be valid");
    const rev = this.external(ops);
    const { doc: after } = loadDoc({ text: this.text, assets: this.assets });
    if (!after) throw new Error("the fake server's deck should be valid");
    this.review = recordAgentEdit(this.review ?? startReview(doc), doc, after);
    return rev;
  }

  get reviewRev(): string {
    return this.review ? reviewRevision(this.review) : "none";
  }

  async loadReview(): Promise<ReviewAnswer> {
    this.reviewLoads += 1;
    const answer: ReviewAnswer =
      this.reviewBroken === undefined
        ? { ok: true, rev: this.reviewRev, review: this.review && structuredClone(this.review) }
        : { ok: false, message: this.reviewBroken };
    await this.reviewGate;
    return answer;
  }

  async saveReview(review: Review, baseRev: string): Promise<ReviewSaveResult> {
    this.reviewSaves.push({ review: structuredClone(review), baseRev });
    this.duringReviewSave?.();
    if (this.nextReviewSave) {
      const answer = this.nextReviewSave;
      this.nextReviewSave = undefined;
      return answer;
    }
    if (baseRev !== this.reviewRev) {
      return { ok: false, kind: "stale", rev: this.reviewRev, message: "The review changed on disk." };
    }
    // The server reads what it is sent as it would the file, so a review that would not load is refused.
    const read = readReview(reviewToText(review));
    if (!read.ok || !read.review) {
      return {
        ok: false,
        kind: "rejected",
        message: read.ok ? "Empty." : (read.diagnostics[0]?.message ?? "Refused."),
      };
    }
    this.review = read.review;
    return { ok: true, rev: this.reviewRev, review: structuredClone(read.review) };
  }

  async loadDeck(): Promise<DeckPayload> {
    this.loads += 1;
    if (this.loadFails) throw new Error("scenes/opening.json: not valid JSON");
    const answer = { rev: this.rev, text: { ...this.text }, assets: [...this.assets], warnings: [] };
    await this.loadGate;
    return answer;
  }

  async save(files: Record<string, string>, baseRev: string, options?: SaveOptions): Promise<SaveResult> {
    this.saves.push({ files, baseRev, options });
    this.duringSave?.();
    if (this.nextSave) {
      const answer = this.nextSave;
      this.nextSave = undefined;
      return answer;
    }
    if (baseRev !== this.rev) {
      return { ok: false, kind: "stale", rev: this.rev, message: "The deck changed on disk." };
    }
    const before = loadDoc({ text: this.text, assets: this.assets }).doc;
    const loaded = loadDoc({ text: files, assets: this.assets });
    if (!loaded.doc) {
      return { ok: false, kind: "rejected", message: "Invalid.", diagnostics: [] };
    }
    this.text = docToFiles(loaded.doc);
    // A person's save is theirs to have made, so the review takes it in, as the real server does.
    if (this.review && before)
      this.review = foldEdit(this.review, before, loaded.doc, options?.keepAgent ?? []);
    return { ok: true, rev: revisionOf(loaded.doc) };
  }

  async uploadAsset(_file: Blob, name: string): Promise<string> {
    const path = `assets/${name.toLowerCase().replace(/[^a-z0-9.]+/g, "-")}`;
    this.uploads.push(path);
    if (!this.assets.includes(path)) this.assets.push(path);
    return path;
  }

  async loadCues(source: string): Promise<CueList> {
    this.cueLoads.push(source);
    if (this.cueLoadFails) throw new Error("The server could not be reached.");
    const map = this.cueMaps[source];
    const answer: CueList = this.brokenCues.has(source)
      ? { state: "broken", cues: [] }
      : map
        ? { state: "ok", cues: structuredClone(map.cues), duration: map.duration }
        : { state: "none", cues: [] };
    await this.cueGate;
    return answer;
  }

  async saveCues(source: string, cues: readonly Cue[], clip?: ClipSize) {
    this.cueSaves.push({ source, cues: structuredClone([...cues]), clip });
    if (this.nextCueSaveFails !== undefined) {
      const message = this.nextCueSaveFails;
      this.nextCueSaveFails = undefined;
      throw new Error(message);
    }
    if (this.brokenCues.has(source)) throw new Error("That is not a cue map the editor can read.");
    const size = this.cueMaps[source] ?? clip;
    if (!size)
      throw new Error("This clip has no cue map yet. Send its duration, width and height to start one.");
    const checked = checkCues(cues, size.duration);
    if (!checked.ok) throw new Error(checked.message);
    const { duration, width, height } = size;
    this.cueMaps[source] = { duration, width, height, cues: checked.cues };
    // The real server lists every file under assets/, so the cue map shows up in the next read of the deck.
    if (!this.assets.includes(cueMapPath(source))) this.assets.push(cueMapPath(source));
    return { cues: structuredClone(checked.cues), duration };
  }

  async loadLayout(scene: string): Promise<LayoutAnswer> {
    this.layoutCalls.push(scene);
    const answer: LayoutAnswer = this.noRender
      ? { available: false, message: "No browser to render in." }
      : { available: true, diagnostics: structuredClone(this.layouts[scene] ?? []) };
    await this.layoutGate;
    return answer;
  }

  get commentsRev(): string {
    return commentsRevision(this.comments);
  }

  /** A comment made behind the editor's back, as the agent's tool would make it. Returns the revision it left. */
  externalComment(ops: CommentOp[]): string {
    const { doc } = loadDoc({ text: this.text, assets: this.assets });
    if (!doc) throw new Error("the fake server's deck should be valid");
    const result = applyCommentOps(this.comments, ops, this.commentsRev, { doc, now: () => this.clock });
    if (!result.ok) throw new Error(`the external comment was refused: ${result.diagnostics[0]?.message}`);
    this.comments = result.file;
    return result.rev;
  }

  async loadComments(): Promise<CommentsAnswer> {
    this.commentLoads += 1;
    const answer: CommentsAnswer =
      this.commentsBroken === undefined
        ? { ok: true, rev: this.commentsRev, comments: structuredClone(this.comments.comments) }
        : { ok: false, message: this.commentsBroken };
    await this.commentGate;
    return answer;
  }

  async saveComments(ops: readonly CommentOp[], baseRev: string): Promise<CommentsSaveResult> {
    this.commentSaves.push({ ops: structuredClone([...ops]), baseRev });
    this.duringCommentSave?.();
    if (this.nextCommentSave) {
      const answer = this.nextCommentSave;
      this.nextCommentSave = undefined;
      return answer;
    }
    const { doc } = loadDoc({ text: this.text, assets: this.assets });
    if (!doc) throw new Error("the fake server's deck should be valid");
    const result = applyCommentOps(this.comments, ops, baseRev, { doc, now: () => this.clock });
    if (!result.ok) {
      const first = result.diagnostics[0];
      return result.code === "stale-revision"
        ? { ok: false, kind: "stale", rev: result.rev, message: first?.message ?? "Stale." }
        : { ok: false, kind: "rejected", message: first?.message ?? "Refused." };
    }
    this.comments = result.file;
    return { ok: true, rev: result.rev, comments: structuredClone(result.file.comments) };
  }
}

export const retitle = (text: string): Op => ({
  op: "block.set",
  scene: "opening",
  id: "opening-title",
  set: { text },
});

export const openingTitle = (doc: {
  scenes: Readonly<Record<string, { blocks: ReadonlyArray<unknown> }>>;
}) => {
  const block = doc.scenes.opening?.blocks.find(
    (candidate) => (candidate as { id: string }).id === "opening-title",
  );
  return (block as { text: string } | undefined)?.text;
};
