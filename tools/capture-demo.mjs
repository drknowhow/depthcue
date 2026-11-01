// Records the footage for docs/demo: the slides drawn by `depthcue render`, the player, the editor and an exported
// folder in headless Chrome, the brand mark, and the CLI's own output. It writes docs/demo/assets/ and
// docs/demo/transcript.json, and starts servers only on loopback ports the system picks. Needs a built CLI and Chrome
// or Edge (DEPTHCUE_BROWSER for another).
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROLS } from "./demo-scene.mjs";
import { CLI, DECK, depthcue, transcript } from "./demo-transcript.mjs";

const root = new URL("../", import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));
const assets = path("docs/demo/assets");
const { chromium } = createRequire(path("packages/cli/package.json"))("playwright-core");

mkdirSync(assets, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "depthcue-capture-"));
const servers = [];

/** Starts `depthcue <command> <deck>` on a free port and returns its address. */
async function start(command, deck) {
  const child = spawn(process.execPath, [CLI, command, deck, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  return await new Promise((resolve, reject) => {
    let text = "";
    const read = (chunk) => {
      text += chunk;
      const found = text.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (found) resolve(found[0]);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", () =>
      reject(new Error(`depthcue ${command} stopped before it printed an address:\n${text}`)),
    );
    setTimeout(
      () => reject(new Error(`depthcue ${command} did not print an address in 20 s:\n${text}`)),
      20_000,
    );
  });
}

const browser = await chromium.launch(
  process.env.DEPTHCUE_BROWSER ? { executablePath: process.env.DEPTHCUE_BROWSER } : { channel: "chrome" },
);
try {
  const copy = join(scratch, "demo");
  cpSync(DECK, copy, { recursive: true });

  // The brand mark for dark surfaces, drawn from the SVG at a size that stays sharp when the video zooms in.
  const mark = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await mark.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style>${readFileSync(
      path("brand/mark-on-dark.svg"),
      "utf8",
    )}`,
  );
  await mark.screenshot({ path: join(assets, "mark.png"), omitBackground: true });
  await mark.close();

  // The demand scene as `render` draws it, with no player controls.
  const drawn = join(scratch, "render");
  const rendered = depthcue(scratch, ["render", copy, "--out", drawn, "--width", "1920", "--height", "1080"]);
  if (rendered.code !== 0) throw new Error(`depthcue render failed:\n${rendered.text}`);
  copyFileSync(join(drawn, "demand.png"), join(assets, "demand.png"));

  // Twice the pixel density, so a crop of the controls stays sharp when the video enlarges it. Whole pages are saved
  // at their CSS size, 1920 by 1080.
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const shot = async (name) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(assets, `${name}.png`), scale: "css" });
  };
  // The right-hand end of the player's control bar, where the presenter chips and the hand-over button are.
  const controls = async (name) => {
    await page.waitForTimeout(700);
    await page.screenshot({
      path: join(assets, `${name}.png`),
      scale: "device",
      clip: { x: CONTROLS.x, y: CONTROLS.y, width: CONTROLS.w, height: CONTROLS.h },
    });
  };

  // The player: the demand scene, the chart sorted by a click, and the scene handed to an agent.
  const player = await start("serve", copy);
  await page.goto(player);
  await page.getByRole("button", { name: "Hand to agent" }).waitFor();
  for (let step = 0; step < 3; step++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(250);
  }
  await shot("player-demand");
  await page.getByRole("button", { name: "Sort by value" }).click();
  await shot("player-sorted");
  await controls("controls-person");
  await page.getByRole("button", { name: "Hand to agent" }).click();
  await shot("player-handoff");
  await controls("controls-agent");

  // The editor on the demand scene, which the agent leads, so the lead buttons in the top bar show it.
  const editor = await start("edit", copy);
  await page.goto(editor);
  await page.locator(".ed-canvas-host .dc-view").first().waitFor();
  await page.locator(".ed-scene").nth(1).click();
  await page.locator(".ed-frame .dc-bar").first().waitFor();
  await shot("editor");

  // An exported folder, opened from the file system as a double-click would.
  const exported = join(scratch, "demo-export");
  const made = depthcue(scratch, ["export", copy, "--out", exported]);
  if (made.code !== 0) throw new Error(`depthcue export failed:\n${made.text}`);
  await page.goto(new URL(`file:///${join(exported, "index.html").replaceAll("\\", "/")}`).href);
  await page.waitForTimeout(500);
  await shot("exported");
} finally {
  await browser.close();
  for (const child of servers) child.kill();
  rmSync(scratch, { recursive: true, force: true });
}

writeFileSync(
  path("docs/demo/transcript.json"),
  `${JSON.stringify(transcript({ delivery: true }), null, 2)}\n`,
);
console.log("demo: wrote docs/demo/assets and docs/demo/transcript.json");
