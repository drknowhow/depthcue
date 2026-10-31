// Measures cold open, scene change, frame pacing, memory and bytes for the same 50-scene deck in Depthcue, Slidev and
// Stagecraft, on this machine, in headless Chrome. Run `node tools/trial/bench.mjs setup` once, then
// `node tools/trial/bench.mjs run [--tools a,b] [--runs N] [--out file]`. Needs a built CLI and Chrome.
//
// How each number is taken (docs/TRIAL.md repeats this next to the results):
// - Cold open: a fresh browser context with an empty cache, the reference network (10 Mbps, 50 ms), from the start
//   of navigation to the first frame in which the heading "Scene 1" is visible.
// - Scene change: from the keydown that asks for the next scene to the first frame after the new heading is visible.
// - Memory: after 49 key presses forward and a garbage collection, the JS heap and the resident size of every
//   renderer process; again after going back and forward once more.
// - Requests to any host other than the local server are blocked for every tool, because the Stagecraft starter asks
//   Google Fonts for a font and the trial measures the tools, not that network.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { evaluate } from "../budgets.mjs";
import { buildDepthcue, buildStagecraft, SCENES, slidevMarkdown } from "./fixtures.mjs";
import {
  describeMachine,
  launchChrome,
  repoPath,
  residentBytes,
  serveFolder,
  summary,
  throttle,
} from "./lib.mjs";

export const VERSIONS = { slidev: "53.0.0", slidevTheme: "0.25.0", vue: "3.5.44", stagecraft: "0.2.2" };
const work = repoPath("scratch/trial/bench");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const argument = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};

function setup() {
  mkdirSync(work, { recursive: true });
  const slidev = join(work, "slidev-project");
  mkdirSync(slidev, { recursive: true });
  writeFileSync(
    join(slidev, "package.json"),
    JSON.stringify({ name: "bench-slidev", private: true, type: "module" }),
  );
  const run = (command, args, cwd) =>
    execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  run(
    npm,
    [
      "install",
      "--no-audit",
      "--no-fund",
      `@slidev/cli@${VERSIONS.slidev}`,
      `@slidev/theme-default@${VERSIONS.slidevTheme}`,
      `vue@${VERSIONS.vue}`,
    ],
    slidev,
  );
  writeFileSync(join(slidev, "slides.md"), slidevMarkdown());
  run(npx, ["slidev", "build", "--out", "dist"], slidev);
  const stagecraft = join(work, "stagecraft-install");
  mkdirSync(stagecraft, { recursive: true });
  writeFileSync(
    join(stagecraft, "package.json"),
    JSON.stringify({ name: "bench-stagecraft", private: true }),
  );
  run(npm, ["install", "--no-audit", "--no-fund", `stagecraft@${VERSIONS.stagecraft}`], stagecraft);
  console.log("bench: setup done");
}

// The page-side helpers, installed before any page script runs.
const INIT = `(() => {
  if (window.top !== window) return;
  const find = (text) => {
    let found = null;
    for (const element of document.querySelectorAll("*")) {
      if (element.textContent.trim() !== text) continue;
      if ([...element.children].some((child) => child.textContent.trim() === text)) continue;
      found = element;
      break;
    }
    return found;
  };
  const visible = (element) => {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
    let opacity = 1;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      opacity *= Number(style.opacity);
    }
    return opacity > 0.01;
  };
  window.__dc = { find, visible, seen: (text) => visible(find(text)) };
  const poll = () => {
    if (window.__dc.seen(window.__ready ?? "Scene 1")) window.__coldOpen = performance.now();
    else requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
})();`;

async function openPage(browser, origin, { slow, ready, reduced }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.route(
    (url) => !url.href.startsWith(origin),
    (route) => route.abort(),
  );
  const page = await context.newPage();
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((text) => {
    window.__ready = text;
  }, ready);
  await page.addInitScript(INIT);
  if (slow) await throttle(page);
  return { context, page };
}

async function coldOpen(browser, origin, { ready, begin }) {
  const { context, page } = await openPage(browser, origin, { slow: true, ready });
  const bytes = { script: 0, stylesheet: 0, document: 0, font: 0, image: 0, other: 0, requests: 0 };
  page.on("response", (response) => {
    const length = Number(response.headers()["content-length"] ?? 0);
    const type = response.request().resourceType();
    const key = type in bytes ? type : "other";
    bytes[key] += length;
    bytes.requests += 1;
  });
  try {
    await page.goto(origin, { waitUntil: "commit" });
    await page.waitForFunction(() => window.__coldOpen !== undefined, undefined, {
      timeout: 30_000,
      polling: 50,
    });
    const ms = await page.evaluate(() => window.__coldOpen);
    // The time is taken. What else the page fetches while the first scene settles still counts as bytes.
    if (begin) await page.keyboard.press(begin);
    await page.waitForTimeout(2000);
    return { ms, bytes };
  } catch (error) {
    return { ms: null, bytes, error: String(error.message).split("\n")[0] };
  } finally {
    await context.close();
  }
}

/** One key press and the time to the first frame in which the named heading is visible. */
async function change(page, key, target) {
  const before = await page.evaluate((text) => window.__dc.seen(text), target);
  await page.evaluate((text) => {
    window.__next = new Promise((resolve) => {
      const onKey = () => {
        removeEventListener("keydown", onKey, true);
        const start = performance.now();
        const poll = () => {
          if (window.__dc.seen(text))
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
          else requestAnimationFrame(poll);
        };
        poll();
      };
      addEventListener("keydown", onKey, true);
    });
  }, target);
  await page.keyboard.press(key);
  const ms = await Promise.race([
    page.evaluate(() => window.__next),
    new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  return { ms, alreadyVisible: before };
}

async function memory(browser, page) {
  const session = await page.context().newCDPSession(page);
  await session.send("HeapProfiler.collectGarbage");
  await session.send("HeapProfiler.collectGarbage");
  const { usedSize: heap } = await session.send("Runtime.getHeapUsage");
  const browserSession = await browser.newBrowserCDPSession();
  const { processInfo } = await browserSession.send("SystemInfo.getProcessInfo");
  const renderers = processInfo
    .filter((entry) => entry.type === "renderer")
    .map((entry) => residentBytes(entry.id));
  return {
    jsHeapMB: heap / 1024 ** 2,
    rendererMB: renderers.reduce((sum, value) => sum + value, 0) / 1024 ** 2,
  };
}

async function traverse(origin, { ready, begin, reduced }) {
  const browser = await launchChrome();
  try {
    const { context, page } = await openPage(browser, origin, { slow: false, ready, reduced });
    await page.goto(origin, { waitUntil: "commit" });
    await page.waitForFunction(() => window.__coldOpen !== undefined, undefined, {
      timeout: 30_000,
      polling: 50,
    });
    await page.waitForTimeout(800);
    // A deck that opens on a welcome screen needs one key before its first scene shows.
    const beginMs = begin ? (await change(page, begin, "Scene 1")).ms : null;
    if (begin) await page.waitForTimeout(800);
    await page.evaluate(() => {
      window.__frames = [];
      window.__keys = [];
      addEventListener("keydown", () => window.__keys.push(performance.now()), true);
      const tick = (now) => {
        window.__frames.push(now);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const changes = [];
    for (let n = 2; n <= SCENES; n++) {
      changes.push(await change(page, "ArrowRight", `Scene ${n}`));
      await page.waitForTimeout(450);
    }
    const frames = await page.evaluate(() => ({ frames: window.__frames, keys: window.__keys }));
    const afterForward = await memory(browser, page);
    for (let n = 1; n < SCENES; n++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(120);
    }
    for (let n = 1; n < SCENES; n++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(500);
    const afterRound = await memory(browser, page);
    await context.close();
    // Frame intervals in the 400 ms after each key press, where a scene change is being drawn.
    const intervals = [];
    for (const key of frames.keys) {
      const inside = frames.frames.filter((time) => time >= key && time <= key + 400);
      for (let i = 1; i < inside.length; i++) intervals.push(inside[i] - inside[i - 1]);
    }
    return { changes, beginMs, intervals, afterForward, afterRound, version: browser.version() };
  } finally {
    await browser.close();
  }
}

async function benchTool(name, folder, runs, opening) {
  const server = await serveFolder(folder);
  try {
    console.log(`bench: ${name}: cold open x${runs}`);
    const browser = await launchChrome();
    const cold = [];
    let bytes;
    try {
      for (let i = 0; i < runs; i++) {
        const result = await coldOpen(browser, server.origin, opening);
        cold.push(result);
        bytes ??= result.bytes;
      }
    } finally {
      await browser.close();
    }
    const traversals = [];
    for (let i = 0; i < 3; i++) {
      console.log(`bench: ${name}: traversal ${i + 1}/3`);
      traversals.push(await traverse(server.origin, opening));
    }
    const ok = cold.filter((entry) => entry.ms !== null).map((entry) => entry.ms);
    const times = traversals.flatMap((run) =>
      run.changes.filter((entry) => entry.ms !== null).map((entry) => entry.ms),
    );
    const intervals = traversals.flatMap((run) => run.intervals);
    return {
      coldOpenMs: {
        ...summary(ok),
        failed: cold.length - ok.length,
        errors: [...new Set(cold.map((entry) => entry.error).filter(Boolean))],
      },
      sceneChangeMs: {
        ...summary(times),
        missed: traversals.reduce(
          (sum, run) => sum + run.changes.filter((entry) => entry.ms === null).length,
          0,
        ),
        alreadyVisible: traversals.reduce(
          (sum, run) => sum + run.changes.filter((entry) => entry.alreadyVisible).length,
          0,
        ),
      },
      frameIntervalMs: {
        ...summary(intervals),
        over20: intervals.filter((value) => value > 20).length,
        over50: intervals.filter((value) => value > 50).length,
      },
      memoryAfter50: {
        jsHeapMB: summary(traversals.map((run) => run.afterForward.jsHeapMB)).p50,
        rendererMB: summary(traversals.map((run) => run.afterForward.rendererMB)).p50,
      },
      memoryAfterRound: {
        jsHeapMB: summary(traversals.map((run) => run.afterRound.jsHeapMB)).p50,
        rendererMB: summary(traversals.map((run) => run.afterRound.rendererMB)).p50,
      },
      beginMs: opening.begin
        ? summary(traversals.map((run) => run.beginMs).filter((ms) => ms !== null))
        : undefined,
      wireBytes: bytes,
      chrome: traversals[0]?.version,
    };
  } finally {
    await server.close();
  }
}

/**
 * What counts as open. The Stagecraft starter opens on a welcome screen that waits for a key, so its cold open
 * is the time to that screen (the heading "My Deck") and the key that starts the deck is measured on its own.
 */
const OPENING = {
  depthcue: {},
  slidev: {},
  stagecraft: { ready: "My Deck", begin: "Space" },
};

const FOLDERS = {
  depthcue: () => buildDepthcue(work),
  slidev: () => join(work, "slidev-project", "dist"),
  stagecraft: () => buildStagecraft(work, join(work, "stagecraft-install")),
};

async function run() {
  const wanted = argument("tools", "depthcue,slidev,stagecraft").split(",");
  const runs = Number(argument("runs", "20"));
  const out = argument("out", repoPath("docs/trial/bench.json"));
  mkdirSync(work, { recursive: true });
  const folders = FOLDERS;
  const results = {};
  for (const name of wanted) results[name] = await benchTool(name, folders[name](), runs, OPENING[name]);
  const browser = await launchChrome();
  const machine = describeMachine(browser.version());
  await browser.close();
  const report = {
    measuredAt: new Date().toISOString().slice(0, 10),
    machine,
    network: "10 Mbps, 50 ms latency",
    scenes: SCENES,
    versions: VERSIONS,
    runs,
    results,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`bench: wrote ${out}`);
}

/**
 * Two more readings, added to the report `run` wrote. An empty page's memory shows what Chrome itself costs, so the
 * decks' memory can be read as the part they add. Scene changes with the browser asked for reduced motion show how
 * much of the time is the tool's own transition.
 */
async function extras() {
  const out = argument("out", repoPath("docs/trial/bench.json"));
  const report = JSON.parse(readFileSync(out, "utf8"));
  const browser = await launchChrome();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await page.goto("about:blank");
    await page.waitForTimeout(500);
    report.emptyPage = await memory(browser, page);
  } finally {
    await browser.close();
  }
  // The size budgets CI gates, read from the build this benchmark measured.
  const config = JSON.parse(readFileSync(repoPath("budgets.json"), "utf8"));
  report.gates = evaluate(config.budgets, (file) =>
    existsSync(repoPath(file)) ? readFileSync(repoPath(file)) : null,
  ).map(({ name, metric, limitBytes, actual, ok }) => ({ name, metric, limitBytes, actual, ok }));
  report.commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoPath("."),
    encoding: "utf8",
  }).trim();
  for (const name of Object.keys(report.results)) {
    const server = await serveFolder(FOLDERS[name]());
    try {
      const runs = [];
      for (let i = 0; i < 3; i++) {
        console.log(`bench: ${name}: reduced-motion traversal ${i + 1}/3`);
        runs.push(await traverse(server.origin, { ...OPENING[name], reduced: true }));
      }
      const all = runs.flatMap((run) => run.changes);
      report.results[name].sceneChangeReducedMotionMs = {
        ...summary(all.filter((entry) => entry.ms !== null).map((entry) => entry.ms)),
        missed: all.filter((entry) => entry.ms === null).length,
      };
    } finally {
      await server.close();
    }
  }
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`bench: added extras to ${out}`);
}

const command = process.argv[2];
if (command === "setup") setup();
else if (command === "run") await run();
else if (command === "extras") await extras();
else {
  console.error(
    "Usage: node tools/trial/bench.mjs setup | run [--tools a,b] [--runs N] [--out file] | extras [--out file]",
  );
  process.exit(2);
}
