import "./editor.css";
import { createApi } from "./api.ts";
import { mountEditor } from "./app.ts";
import { browserDraftStore, draftKey } from "./drafts.ts";
import { openStore } from "./store.ts";

/** The editor chrome follows the system light or dark setting; the preview keeps the deck's own theme. */
function followColorScheme() {
  const query = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.dataset.theme = query.matches ? "ink" : "paper";
  };
  apply();
  query.addEventListener("change", apply);
}

/** Entry for the page `depthcue edit` serves: the secret for write calls arrives in a meta tag. */
async function start(host: HTMLElement) {
  followColorScheme();
  const token = document.querySelector<HTMLMetaElement>('meta[name="depthcue-token"]')?.content ?? "";
  let store: Awaited<ReturnType<typeof openStore>>;
  try {
    store = await openStore(createApi(token), (id) => browserDraftStore(draftKey(id)));
  } catch (error) {
    host.textContent = `The deck could not be opened: ${(error as Error).message}`;
    host.classList.add("ed-failed");
    return;
  }
  mountEditor(host, store);

  const flush = () => store.flush();
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  if (typeof EventSource === "function") {
    const events = new EventSource("/_depthcue/events");
    events.addEventListener("change", () => void store.syncFromDisk());
    // A dropped connection can hide a change; look again when it comes back.
    events.addEventListener("open", () => void store.syncFromDisk());
  }
}

const host = document.getElementById("depthcue-editor");
if (host) void start(host);
