// @vitest-environment happy-dom
import { memoryDraftStore, voiceKey } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { voiceStanding } from "../src/panels.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

beforeEach(async () => {
  server = new FakeServer();
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select("method");
});
afterEach(() => editor.destroy());

const chip = () => host.querySelector<HTMLButtonElement>(".ed-quick [data-tb='notes']") as HTMLButtonElement;
const pop = () => host.querySelector<HTMLElement>(".ed-script") as HTMLElement;
const open = () => {
  chip().click();
  return pop();
};
const field = (key: string) => pop().querySelector(`[data-field="${key}"]`) as HTMLTextAreaElement;
const typeInto = (node: HTMLTextAreaElement | HTMLInputElement, text: string) => {
  node.focus();
  node.value = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
};
const make = () => pop().querySelector<HTMLButtonElement>("[data-field='voice:make']") as HTMLButtonElement;
const voiceover = () => store.session.doc.scenes.method?.voiceover;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the Voice panel", () => {
  it("sits in the Script drawer, and the Make audio button waits for some text", () => {
    open();
    expect(make().disabled).toBe(true);
  });

  it("writes what is typed as the scene's voice-over, and clears it when it is emptied", () => {
    open();
    typeInto(field("panel:voice-text"), "Channel B now leads.");
    expect(voiceover()).toEqual({ text: "Channel B now leads." });
    expect(make().disabled).toBe(false);
    typeInto(field("panel:voice-text"), "");
    expect(voiceover()).toBeUndefined();
  });

  it("keeps the voice a person chose when the text changes, and drops it when it is emptied", () => {
    open();
    typeInto(field("panel:voice-text"), "One two.");
    typeInto(field("panel:voice-name"), "bf_emma");
    expect(voiceover()).toEqual({ text: "One two.", voice: "bf_emma" });
    typeInto(field("panel:voice-text"), "One two three.");
    expect(voiceover()?.voice).toBe("bf_emma");
    typeInto(field("panel:voice-name"), "");
    expect(voiceover()).toEqual({ text: "One two three." });
  });

  it("asks the server to make the audio for this scene and voice, and shows why it could not", async () => {
    open();
    typeInto(field("panel:voice-text"), "Channel B now leads.");
    typeInto(field("panel:voice-name"), "bf_emma");
    make().click();
    await tick();
    await tick();
    expect(server.voiceCalls).toEqual([{ scene: "method", voice: "bf_emma" }]);
    expect(pop().querySelector("[data-voice='problem']")?.textContent).toBe("Kokoro is not installed.");
  });

  it("saves the typed text before the server reads the files", async () => {
    open();
    typeInto(field("panel:voice-text"), "Saved first.");
    make().click();
    await tick();
    await tick();
    expect(server.saves.length).toBeGreaterThan(0);
    const sent = JSON.parse(server.saves.at(-1)?.files["scenes/method.json"] as string);
    expect(sent.voiceover.text).toBe("Saved first.");
  });

  it("warns when the text has more marks than the scene has steps", () => {
    open();
    typeInto(field("panel:voice-text"), "One {step} two {step} three {step} four {step} five.");
    expect(pop().querySelector("[data-voice='status']")?.textContent).toMatch(/marks but the scene has/);
  });
});

describe("the step marks", () => {
  const mark = () => pop().querySelector<HTMLButtonElement>("[data-field='voice:mark']") as HTMLButtonElement;
  const demand = () => store.session.doc.scenes.demand?.voiceover?.text;

  it("are put where the cursor is, up to one for each step", () => {
    editor.select("demand");
    open();
    typeInto(field("panel:voice-text"), "First point. Second point. Third point.");
    const box = field("panel:voice-text");
    box.setSelectionRange("First point.".length, "First point.".length);
    mark().click();
    expect(demand()).toBe("First point. {step} Second point. Third point.");
    const next = field("panel:voice-text");
    next.setSelectionRange(next.value.length, next.value.length);
    mark().click();
    expect(demand()).toBe("First point. {step} Second point. Third point. {step}");
    expect(pop().querySelector("[data-voice='marks']")?.textContent).toBe("2 of 2 steps marked");
    expect(mark().disabled).toBe(true);
  });

  it("have no button to press in a scene without steps", () => {
    open();
    expect(mark().disabled).toBe(true);
    expect(pop().querySelector("[data-voice='marks']")?.textContent).toBe("This scene has no steps to mark.");
  });
});

describe("voiceStanding", () => {
  const scene = (voiceover?: Record<string, unknown>) => ({ voiceover }) as never;
  it("tells a recording that matches from one that does not", () => {
    expect(voiceStanding(scene())).toBe("none");
    expect(voiceStanding(scene({ text: "Hi." }))).toBe("missing");
    const made = { text: "Hi.", audio: "assets/a.voice.wav", words: "assets/a.voice.words.json" };
    expect(voiceStanding(scene({ ...made, key: voiceKey("Hi.", "af_heart") }))).toBe("current");
    expect(voiceStanding(scene({ ...made, key: voiceKey("Hi.", "bf_emma") }))).toBe("stale");
    expect(voiceStanding(scene({ ...made, voice: "bf_emma", key: voiceKey("Hi.", "bf_emma") }))).toBe(
      "current",
    );
  });
});
