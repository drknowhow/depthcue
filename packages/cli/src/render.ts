import type { Diagnostic } from "@depthcue/core";
import type { Browser, LaunchOptions } from "playwright-core";
import { openDeck } from "./deck-api.ts";
import { type LayoutMeasure, layoutDiagnostics, measureLayout } from "./layout.ts";
import { builtPlayerDir, type RunningServer, startServer } from "./serve.ts";

export interface RenderOptions {
  /** Stage size in CSS pixels; the audience's screen. Default 1280x720. */
  width?: number;
  height?: number;
  /** Steps shown, 0 for none. Default: all of them, since that is the fullest the scene gets. */
  step?: number;
  /** Take a PNG of the stage. Default true. */
  screenshot?: boolean;
  /** Smallest readable text in CSS pixels. Default 12. */
  minFontPx?: number;
}

export interface SceneRender {
  scene: string;
  step: number;
  viewport: { width: number; height: number };
  /** PNG bytes of the stage, with the player's controls hidden. */
  png: Buffer | undefined;
  /** Layout and contrast problems, each an error. Empty when the scene fits. */
  diagnostics: Diagnostic[];
  measure: LayoutMeasure;
}

export interface Renderer {
  render(scene: string, options?: RenderOptions): Promise<SceneRender>;
  close(): Promise<void>;
}

export class RenderError extends Error {}

/** Nothing on a screenshot should move or fade, and the controls are not part of the slide. */
const CLEAN_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.dc-controls { display: none !important; }
`;

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const attempts: Array<{ label: string; options: LaunchOptions }> = [];
  const custom = process.env.DEPTHCUE_BROWSER;
  if (custom) attempts.push({ label: custom, options: { executablePath: custom } });
  attempts.push(
    { label: "Chrome", options: { channel: "chrome" } },
    { label: "Edge", options: { channel: "msedge" } },
    { label: "Playwright's Chromium", options: {} },
  );
  // A CI container often cannot create the browser's sandbox. The page is our own loopback player, so CI and an
  // explicit opt-in may turn it off; an ordinary run keeps it.
  const noSandbox = Boolean(process.env.CI || process.env.DEPTHCUE_NO_SANDBOX);
  const failures: string[] = [];
  for (const { label, options } of attempts) {
    try {
      return await chromium.launch({
        headless: true,
        ...(noSandbox ? { args: ["--no-sandbox"] } : {}),
        ...options,
      });
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  throw new RenderError(
    `No browser could be started. Install Chrome or Edge, or set DEPTHCUE_BROWSER to a Chromium executable.\n${failures.join("\n")}`,
  );
}

/**
 * Starts a private copy of the player on a loopback port and a headless browser, and renders scenes one at a
 * time. The deck is read from disk on each render, so an edit made between renders shows up. Call `close()`.
 */
export async function openRenderer(folder: string): Promise<Renderer> {
  const server: RunningServer = await startServer({ folder, playerDir: builtPlayerDir(), port: 0 });
  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    await server.close();
    throw error;
  }

  return {
    async render(scene, options = {}) {
      const opened = openDeck(folder);
      if (!opened.ok) {
        throw new RenderError(
          `The deck has errors and cannot be rendered: ${opened.diagnostics
            .filter((d) => d.severity === "error")
            .map((d) => `${d.file}${d.path} ${d.message}`)
            .join("; ")}`,
        );
      }
      const target = opened.doc.scenes[scene];
      if (!target) {
        throw new RenderError(
          `There is no scene "${scene}". Scenes are: ${opened.doc.deck.scenes.join(", ")}.`,
        );
      }
      const total = target.steps?.length ?? 0;
      const step = Math.min(Math.max(options.step ?? total, 0), total);
      const width = options.width ?? 1280;
      const height = options.height ?? 720;

      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
        colorScheme: "light",
        bypassCSP: true,
        serviceWorkers: "block",
      });
      try {
        const page = await context.newPage();
        const problems: string[] = [];
        page.on("pageerror", (error) => problems.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") problems.push(message.text());
        });
        await page.goto(`${server.url}#/${scene}${step > 0 ? `/${step}` : ""}`, { waitUntil: "load" });
        await page.addStyleTag({ content: CLEAN_CSS });
        try {
          await page.waitForSelector(`.dc-scene[data-scene="${scene}"]`, { timeout: 10_000 });
        } catch {
          throw new RenderError(
            `The player did not show scene "${scene}".${problems.length > 0 ? ` Page errors: ${problems.join("; ")}` : ""}`,
          );
        }
        // Modules hydrate a moment after the scene shows; measure and photograph the settled page.
        await page.evaluate(() =>
          (window as { depthcue?: { settled(): Promise<void> } }).depthcue?.settled(),
        );
        const measure = await page.evaluate(measureLayout);
        const png =
          options.screenshot === false
            ? undefined
            : await page.locator(".dc-stage").screenshot({ type: "png", animations: "disabled" });
        return {
          scene,
          step,
          viewport: { width, height },
          png,
          diagnostics: layoutDiagnostics(
            target,
            measure,
            options.minFontPx === undefined ? {} : { minFontPx: options.minFontPx },
          ),
          measure,
        };
      } finally {
        await context.close();
      }
    },
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

/** One scene, one render. Use `openRenderer` to render several without restarting the browser. */
export async function renderScene(
  folder: string,
  scene: string,
  options: RenderOptions = {},
): Promise<SceneRender> {
  const renderer = await openRenderer(folder);
  try {
    return await renderer.render(scene, options);
  } finally {
    await renderer.close();
  }
}
