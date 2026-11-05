import type { AuditEntry } from "@depthcue/core";
import type { Api } from "./api.ts";

export interface AuditState {
  /** Oldest first, as the file has them. */
  entries: readonly AuditEntry[];
  /** Lines of the file that were not entries. */
  skipped: number;
  /** True once an answer has come, good or not. */
  ready: boolean;
  /** Why the log cannot be shown, when the server did not give it. */
  problem?: string;
}

export interface AuditBook {
  readonly state: AuditState;
  subscribe(listener: () => void): () => void;
  /** Reads the log again, and from then on `refresh` does the same. */
  sync(): Promise<void>;
  /** Reads the log again when it has been read before, for the server's word that it changed. Does nothing before that. */
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * The audit log beside the deck: a file of its own, read-only here. Nothing is read until the History list is first
 * opened, because most sessions never open it; after that the server's word that it changed reads it again.
 */
export function createAuditBook(api: Pick<Api, "loadAudit">): AuditBook {
  let state: AuditState = { entries: [], skipped: 0, ready: false };
  let started = false;
  let disposed = false;
  /** Counts reads, so an answer that a newer read overtook is thrown away. */
  let latest = 0;
  const listeners = new Set<() => void>();

  async function sync() {
    started = true;
    const mine = ++latest;
    const answer = await api.loadAudit();
    if (disposed || mine !== latest) return;
    state = answer.ok
      ? { entries: answer.entries, skipped: answer.skipped, ready: true }
      : { entries: [], skipped: 0, ready: true, problem: answer.message };
    for (const listener of [...listeners]) listener();
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync,
    refresh: () => (started ? sync() : Promise.resolve()),
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
