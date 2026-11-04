import { type ApplyResult, applyOps, type Op } from "./apply.ts";
import { type Doc, revisionOf, withBrandFile } from "./doc.ts";

export type SessionEventType = "apply" | "undo" | "redo" | "reset" | "saved" | "assets" | "files";

export interface SessionEvent {
  type: SessionEventType;
  rev: string;
  prevRev: string;
}

export interface ApplyOptions {
  /** Defaults to the current revision, which is right for the editor. Agents pass the one they read. */
  baseRev?: string;
  /** Edits sharing a key and made back to back become one undo step, such as typing into one field. */
  coalesce?: string;
}

export interface Session {
  readonly doc: Doc;
  readonly rev: string;
  /** Revision at the last load or `markSaved`. */
  readonly savedRev: string;
  /** True when the document differs from what was last saved. */
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  apply(ops: readonly Op[], options?: ApplyOptions): ApplyResult;
  undo(): boolean;
  redo(): boolean;
  /** Replaces the document and clears history, for a reload from disk or a recovered draft. */
  reset(doc: Doc, options?: { dirty?: boolean }): void;
  /** Records that `rev` (default: the present revision) is what is on disk now. */
  markSaved(rev?: string): void;
  /**
   * Makes newly added files under assets/ available to references, in the present document and in every undo
   * and redo state, without touching the revision, the history or the dirty flag.
   */
  addAssets(paths: readonly string[]): void;
  /**
   * Takes a file off under assets/ once it is deleted, in the present document and in every undo and redo state, so
   * undoing cannot bring a name back that no file answers to. Like `addAssets` it leaves the revision, the history and
   * the dirty flag alone, and it gives each document a set of its own rather than changing one they may share.
   */
  dropAsset(path: string): void;
  /**
   * Takes in a brand file the server added or replaced (`hash`) or removed (null), as an upload's answer names it, in
   * the present document and in every undo and redo state. The revisions change with it. A session saved at the
   * revision the disk had before (`prevRev`) is saved at the one after (`rev`), so the upload alone leaves it clean,
   * and unsaved edits stay unsaved.
   */
  brandFile(path: string, hash: string | null, revs: { prevRev: string; rev: string }): void;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

interface Snapshot {
  doc: Doc;
  rev: string;
}

/**
 * The one authoritative copy of an open deck. The editor, the CLI and agent tools all change it through
 * `apply`, so they share atomic transactions, stale-revision rejection and one undo history. Undo is linear:
 * it reverts the latest change, whoever made it.
 */
export function createSession(initial: Doc, options: { historyLimit?: number } = {}): Session {
  const limit = options.historyLimit ?? 200;
  const snapshotOf = (doc: Doc): Snapshot => ({ doc, rev: revisionOf(doc) });
  let present = snapshotOf(initial);
  let savedRev = present.rev;
  let past: Snapshot[] = [];
  let future: Snapshot[] = [];
  let lastCoalesce: string | undefined;
  const listeners = new Set<(event: SessionEvent) => void>();

  const emit = (type: SessionEventType, prevRev: string) => {
    for (const listener of [...listeners]) listener({ type, rev: present.rev, prevRev });
  };
  const every = (change: (snapshot: Snapshot) => Snapshot) => {
    present = change(present);
    past = past.map(change);
    future = future.map(change);
  };

  return {
    get doc() {
      return present.doc;
    },
    get rev() {
      return present.rev;
    },
    get savedRev() {
      return savedRev;
    },
    get dirty() {
      return present.rev !== savedRev;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    apply(ops, applyOptions = {}) {
      const result = applyOps(present.doc, ops, applyOptions.baseRev ?? present.rev);
      if (!result.ok || result.rev === present.rev) return result;
      const joins =
        applyOptions.coalesce !== undefined && applyOptions.coalesce === lastCoalesce && past.length > 0;
      if (!joins) {
        past.push(present);
        if (past.length > limit) past = past.slice(past.length - limit);
      }
      lastCoalesce = applyOptions.coalesce;
      future = [];
      const prevRev = present.rev;
      present = { doc: result.doc, rev: result.rev };
      emit("apply", prevRev);
      return result;
    },
    undo() {
      const previous = past.pop();
      if (!previous) return false;
      future.push(present);
      const prevRev = present.rev;
      present = previous;
      lastCoalesce = undefined;
      emit("undo", prevRev);
      return true;
    },
    redo() {
      const next = future.pop();
      if (!next) return false;
      past.push(present);
      const prevRev = present.rev;
      present = next;
      lastCoalesce = undefined;
      emit("redo", prevRev);
      return true;
    },
    reset(doc, resetOptions = {}) {
      const prevRev = present.rev;
      present = snapshotOf(doc);
      if (!resetOptions.dirty) savedRev = present.rev;
      past = [];
      future = [];
      lastCoalesce = undefined;
      emit("reset", prevRev);
    },
    markSaved(rev) {
      savedRev = rev ?? present.rev;
      emit("saved", present.rev);
    },
    addAssets(paths) {
      if (paths.every((path) => present.doc.assets.has(path))) return;
      every((snapshot) => ({
        rev: snapshot.rev,
        doc: { ...snapshot.doc, assets: new Set([...snapshot.doc.assets, ...paths]) },
      }));
      emit("assets", present.rev);
    },
    dropAsset(path) {
      // Every state lists the files the present one does (`addAssets` and this change them all), so it is asked alone.
      if (!present.doc.assets.has(path)) return;
      every((snapshot) => ({
        rev: snapshot.rev,
        doc: { ...snapshot.doc, assets: new Set([...snapshot.doc.assets].filter((name) => name !== path)) },
      }));
      emit("assets", present.rev);
    },
    brandFile(path, hash, revs) {
      const prevRev = present.rev;
      every(({ doc }) => snapshotOf(withBrandFile(doc, path, hash)));
      if (savedRev === revs.prevRev) savedRev = revs.rev;
      emit("files", prevRev);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
