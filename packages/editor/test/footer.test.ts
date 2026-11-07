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
  it("holds the zoom, and no pager", () => {
    expect(footer().querySelector(".ed-view")).not.toBeNull();
    expect(footer().closest(".ed-stage")).toBeNull();
    expect(footer().querySelector("[data-view='where']")).toBeNull();
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

  it("opens the script on the tab of the steps, the notes, the reading version or the voice-over", () => {
    editor.select("method");
    const drawer = () => host.querySelector<HTMLElement>(".ed-script") as HTMLElement;
    const selected = () =>
      drawer().querySelector("[role='tab'][aria-selected='true']")?.getAttribute("data-tab");
    for (const name of ["steps", "notes", "reading", "voice"]) {
      part(name).click();
      expect(drawer().hidden).toBe(false);
      expect(selected()).toBe(name);
      expect(drawer().querySelector<HTMLElement>(`[data-part='${name}']`)?.hidden).toBe(false);
      part(name).click();
      expect(drawer().hidden).toBe(true);
    }
    // Open on one tab, another part of the footer moves to its tab and leaves the drawer open.
    part("notes").click();
    part("voice").click();
    expect(drawer().hidden).toBe(false);
    expect(selected()).toBe("voice");
  });
});

describe("the script drawer", () => {
  const drawer = () => host.querySelector<HTMLElement>(".ed-script") as HTMLElement;
  const tab = (name: string) =>
    drawer().querySelector<HTMLElement>(`[role='tab'][data-tab='${name}']`) as HTMLElement;
  const key = (target: Element, name: string) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

  it("is a list of four tabs, one shown at a time, that the arrows move along", () => {
    editor.select("method");
    part("notes").click();
    const names = [...drawer().querySelectorAll("[role='tab']")].map((node) => node.getAttribute("data-tab"));
    expect(names).toEqual(["notes", "steps", "reading", "voice"]);
    expect(drawer().querySelector("[role='tablist']")).not.toBeNull();
    expect(tab("notes").getAttribute("aria-controls")).toBe("ed-script-notes");
    expect(drawer().querySelectorAll("[role='tabpanel']:not([hidden])")).toHaveLength(1);
    tab("notes").focus();
    key(tab("notes"), "ArrowRight");
    expect(document.activeElement).toBe(tab("steps"));
    expect(tab("steps").getAttribute("aria-selected")).toBe("true");
    expect(tab("notes").tabIndex).toBe(-1);
    key(tab("steps"), "ArrowLeft");
    key(tab("notes"), "ArrowLeft");
    expect(document.activeElement).toBe(tab("voice"));
    key(tab("voice"), "Home");
    expect(document.activeElement).toBe(tab("notes"));
  });

  it("reads the reveal order step by step, and sends the person to the steps to change it", () => {
    editor.select("demand");
    part("steps").click();
    const items = [...drawer().querySelectorAll(".ed-script-steps li")].map((node) => node.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/^Step 1/);
    expect(tab("steps").querySelector(".ed-tb-n")?.textContent).toBe("2");
    drawer().querySelector<HTMLElement>("[data-action='edit-steps']")?.click();
    expect(host.querySelector(".ed-scene-tools [data-tb='scene']")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    editor.select("method");
    expect(drawer().querySelector<HTMLElement>(".ed-script-steps")?.hidden).toBe(true);
    expect(drawer().querySelector("[data-part='steps'] .ed-hint-text")?.textContent).toMatch(
      /everything at once/,
    );
  });
});
