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

/** What the editor needs from the server. A test can stand in for it. */
export interface Api {
  loadDeck(): Promise<DeckPayload>;
  save(files: Record<string, string>, baseRev: string): Promise<SaveResult>;
  /** Adds an image and returns its deck path, such as "assets/photo-1a2b3c4d.png". */
  uploadAsset(file: Blob, name: string): Promise<string>;
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

    async save(files, baseRev) {
      let response: Response;
      try {
        response = await call("save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseRev, files }),
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
  };
}
