import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIT_FILE,
  type AuditDraft,
  type AuditEntry,
  auditLine,
  type ReadAudit,
  readAudit,
} from "@depthcue/core";

/** Past this size the log moves to `audit.1.jsonl`, replacing the one there, and a new log starts. */
export const AUDIT_MAX_BYTES = 1024 * 1024;
const ROLLED_FILE = "audit.1.jsonl";

/**
 * Reads `audit.jsonl` from the deck folder. No file is a deck with no history. This is the only place the CLI opens
 * it: `loadDeckDir` does not list it, the servers do not serve it and `export` does not copy it.
 */
export function loadAuditDir(dir: string): ReadAudit {
  const path = join(dir, AUDIT_FILE);
  return readAudit(existsSync(path) ? readFileSync(path, "utf8") : undefined);
}

/**
 * Adds entries to the log, one line each, in a single append so two writers never interleave inside a line. It never
 * throws and never blocks the change it describes, which has already happened: when the log cannot be written it
 * returns false.
 */
export function appendAudit(
  dir: string,
  drafts: readonly AuditDraft[],
  now: () => string = () => new Date().toISOString(),
): boolean {
  if (drafts.length === 0) return true;
  try {
    const path = join(dir, AUDIT_FILE);
    if (existsSync(path) && statSync(path).size > AUDIT_MAX_BYTES) renameSync(path, join(dir, ROLLED_FILE));
    const time = now();
    const lines = drafts.map((draft, i): string => {
      const entry: AuditEntry = {
        id: `${Date.now().toString(36)}${i}${randomBytes(3).toString("hex")}`,
        time,
        ...draft,
      };
      return auditLine(entry);
    });
    appendFileSync(path, lines.join(""));
    return true;
  } catch {
    return false;
  }
}
