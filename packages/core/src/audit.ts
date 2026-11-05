import type { CommentOp, CommentsFile } from "./comments.ts";
import { type Doc, revisionOf } from "./doc.ts";
import { type Difference, describeChange, diffDocs } from "./review.ts";

/** The audit log beside the deck. Like `comments.json` and `review.json` it is not part of the deck. */
export const AUDIT_FILE = "audit.jsonl";

/** The most entries one write adds. A larger change adds these and one entry that counts the rest. */
export const AUDIT_WRITE_MAX = 50;

/** `outside` is a change made to the files by hand, which nobody's tools recorded. */
export type AuditBy = "you" | "agent" | "outside";

export type AuditKind = "edit" | "comment" | "reply" | "resolve" | "reopen" | "delete" | "accept" | "revert";

const BYS: readonly string[] = ["you", "agent", "outside"];
const KINDS: readonly string[] = [
  "edit",
  "comment",
  "reply",
  "resolve",
  "reopen",
  "delete",
  "accept",
  "revert",
];

/** What happened, before the writer gives it an id and a time. */
export interface AuditDraft {
  by: AuditBy;
  kind: AuditKind;
  summary: string;
  scene?: string;
  block?: string;
  field?: string;
  /** The comment it concerns. */
  comment?: string;
  /** The deck's revision after an edit. */
  rev?: string;
}

export interface AuditEntry extends AuditDraft {
  /** Unique, and not an order: the order is the file's. */
  id: string;
  /** ISO time. */
  time: string;
}

export interface ReadAudit {
  entries: AuditEntry[];
  /** Lines that were not entries. They are left in the file and left out here. */
  skipped: number;
}

const where = (d: { scene?: string; block?: string; field?: string }) => ({
  ...(d.scene === undefined ? {} : { scene: d.scene }),
  ...(d.block === undefined ? {} : { block: d.block }),
  ...(d.field === undefined ? {} : { field: d.field }),
});

/** Keeps a write to `AUDIT_WRITE_MAX` entries, the last one saying how many were left out. */
function capped(drafts: AuditDraft[]): AuditDraft[] {
  const first = drafts[0];
  if (first === undefined || drafts.length <= AUDIT_WRITE_MAX) return drafts;
  const left = drafts.length - (AUDIT_WRITE_MAX - 1);
  return [
    ...drafts.slice(0, AUDIT_WRITE_MAX - 1),
    { by: first.by, kind: first.kind, summary: `and ${left} more changes` },
  ];
}

/** One entry for each property of the deck that changed from `before` to `after`. */
export function editDrafts(by: AuditBy, before: Doc, after: Doc): AuditDraft[] {
  const rev = revisionOf(after);
  return capped(
    diffDocs(before, after).map((d) => ({
      by,
      kind: "edit" as const,
      summary: describeChange(d),
      ...where(d),
      rev,
    })),
  );
}

/** One entry for each change a person accepted or reverted. */
export function reviewDrafts(kind: "accept" | "revert", changes: readonly Difference[]): AuditDraft[] {
  return capped(
    changes.map((d) => ({
      by: "you" as const,
      kind,
      summary: `${kind === "accept" ? "Accepted" : "Reverted"}: ${describeChange(d)}`,
      ...where(d),
    })),
  );
}

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
};

/**
 * One entry for each operation that changed the comments from `before` to `after`. `by` signs the operations that
 * name no author: resolve, reopen and delete. A comment added without an id is matched to the new one in file order.
 */
export function commentDrafts(
  ops: unknown,
  before: CommentsFile,
  after: CommentsFile,
  by: AuditBy,
): AuditDraft[] {
  if (!Array.isArray(ops)) return [];
  const was = new Map(before.comments.map((c) => [c.id, c]));
  const now = new Map(after.comments.map((c) => [c.id, c]));
  const named = new Set(
    (ops as CommentOp[]).flatMap((op) => (op.op === "comment.add" && op.id ? [op.id] : [])),
  );
  const fresh = after.comments.map((c) => c.id).filter((id) => !was.has(id) && !named.has(id));
  const out: AuditDraft[] = [];
  for (const op of ops as CommentOp[]) {
    const found = op.op === "comment.add" ? undefined : (was.get(op.id) ?? now.get(op.id));
    const at = (scene: string, block: string) => ({ scene, block });
    switch (op.op) {
      case "comment.add": {
        const id = op.id ?? fresh.shift();
        out.push({
          by: op.author,
          kind: "comment",
          summary: `${op.ask === true ? "Asked the agent" : "Commented"} on block "${op.block}": ${excerpt(op.text)}`,
          ...at(op.scene, op.block),
          ...(id === undefined ? {} : { comment: id }),
        });
        break;
      }
      case "comment.reply":
        if (found === undefined) break;
        out.push({
          by: op.author,
          kind: "reply",
          summary: `Replied on block "${found.block}": ${excerpt(op.text)}`,
          ...at(found.scene, found.block),
          comment: op.id,
        });
        break;
      case "comment.resolve":
      case "comment.reopen": {
        const resolving = op.op === "comment.resolve";
        if (found === undefined || (was.get(op.id)?.resolved === true) === resolving) break;
        out.push({
          by,
          kind: resolving ? "resolve" : "reopen",
          summary: `${resolving ? "Resolved" : "Reopened"} comment ${op.id} on block "${found.block}"`,
          ...at(found.scene, found.block),
          comment: op.id,
        });
        break;
      }
      case "comment.delete":
        if (found === undefined) break;
        out.push({
          by,
          kind: "delete",
          summary: `Deleted comment ${op.id} on block "${found.block}"`,
          ...at(found.scene, found.block),
          comment: op.id,
        });
        break;
    }
  }
  return capped(out);
}

const isEntry = (value: unknown): value is AuditEntry => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.time === "string" &&
    typeof v.summary === "string" &&
    typeof v.by === "string" &&
    BYS.includes(v.by) &&
    typeof v.kind === "string" &&
    KINDS.includes(v.kind)
  );
};

export const auditLine = (entry: AuditEntry): string => `${JSON.stringify(entry)}\n`;

/** Reads the log. A line that is not an entry is counted and skipped, so one bad line never hides the rest. */
export function readAudit(text: string | undefined): ReadAudit {
  const entries: AuditEntry[] = [];
  let skipped = 0;
  for (const line of (text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isEntry(value)) entries.push(value);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

export interface AuditQuery {
  scene?: string;
  by?: AuditBy;
  kind?: AuditKind;
  /** An entry id: only what was written after it. An id the log does not have gives everything. */
  since?: string;
  /** The latest this many, after the other filters. */
  limit?: number;
}

export function filterAudit(entries: readonly AuditEntry[], query: AuditQuery): AuditEntry[] {
  const seen = query.since === undefined ? -1 : entries.findIndex((e) => e.id === query.since);
  const out = entries
    .slice(seen + 1)
    .filter(
      (e) =>
        (query.scene === undefined || e.scene === query.scene) &&
        (query.by === undefined || e.by === query.by) &&
        (query.kind === undefined || e.kind === query.kind),
    );
  return query.limit === undefined ? out : out.slice(Math.max(0, out.length - query.limit));
}
