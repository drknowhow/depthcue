// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

let host: HTMLElement;
let editor: Editor;

beforeEach(async () => {
  const store = await openStore(new FakeServer(), () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
});
afterEach(() => editor.destroy());

const footer = () => host.querySelector(".ed-footer") as HTMLElement;
const part = (name: string) => footer().querySelector(`[data-footer='${name}']`) as HTMLButtonElement;

describe("the footer", () => {
  it("holds the controls for moving between slides and zooming", () => {
    expect(footer().querySelector(".ed-view")).not.toBeNull();
    expect(footer().closest(".ed-stage")).toBeNull();
    expect(footer().querySelector("[data-view='where']")?.textContent).toMatch(/^\d+ \/ \d+$/);
  });

  it("says what the slide on show holds, and follows the choice of slide", () => {
    editor.select("demand");
    expect(footer().querySelector(".ed-footer-where")?.textContent).toMatch(/^Slide 2 of 3 · /);
    expect(footer().querySelector("[data-footer='steps']")?.textContent).toBe("2 steps");
    editor.select("method");
    expect(footer().querySelector("[data-footer='steps']")?.textContent).toBe("No steps");
    expect(part("reading").hasAttribute("data-on")).toBe(true);
    expect(part("notes").hasAttribute("data-on")).toBe(false);
  });

  it("opens the script from the notes, the reading version and the voice-over", () => {
    editor.select("method");
    for (const name of ["notes", "reading", "voice"]) {
      part(name).click();
      expect(host.querySelector<HTMLElement>(".ed-script")?.hidden).toBe(false);
      part(name).click();
      expect(host.querySelector<HTMLElement>(".ed-script")?.hidden).toBe(true);
    }
  });
});
