// Checks what an agent delivered for the trial's task 4, the same way for every tool: open index.html from the
// folder in headless Chrome with every network request blocked, walk the deck with the right-arrow key, and look at
// what a viewer would see. It reports; it does not grade. Usage:
//   node tools/trial/verify.mjs <depthcue|slidev|stagecraft> <deliver-folder> <source-folder> [out.json]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchChrome } from "./lib.mjs";

const LONG_HEADING =
  "Three things could change the picture, and each one is worth a conversation before anyone acts on the Channel B number on the second slide";

const PAGE_HELPERS = `(() => {
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
    return opacity > 0.05;
  };
  window.__snapshot = () => {
    const lines = [];
    const off = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.replace(/\\s+/g, " ").trim();
      if (!text) continue;
      const parent = node.parentElement;
      if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName) || !visible(parent)) continue;
      lines.push(text);
      const rect = parent.getBoundingClientRect();
      if (rect.left < -2 || rect.top < -2 || rect.right > innerWidth + 2 || rect.bottom > innerHeight + 2)
        off.push(text.slice(0, 60));
    }
    return { text: lines.join(" | "), off };
  };
})();`;

/** Every text file under a folder, joined, so notes can be looked for in what was delivered. */
function folderText(folder) {
  let all = "";
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === "node_modules") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(html|js|mjs|css|json|md|txt|map)$/i.test(name) && statSync(full).size < 20_000_000) {
        all += `\n${readFileSync(full, "utf8")}`;
      }
    }
  };
  if (existsSync(folder)) walk(folder);
  return all;
}

/** The speaker notes the agent wrote in its source, found the way each tool stores them. */
function notesOf(tool, source) {
  const notes = [];
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
  if (tool === "depthcue") {
    const scenes = join(source, "scenes");
    if (existsSync(scenes)) {
      for (const name of readdirSync(scenes)) {
        const note = JSON.parse(read(join(scenes, name))).notes;
        if (typeof note === "string" && note.trim()) notes.push(note.trim());
      }
    }
  } else if (tool === "slidev") {
    for (const match of read(join(source, "slides.md")).matchAll(/<!--([\s\S]*?)-->/g)) {
      const note = match[1].trim();
      if (note) notes.push(note);
    }
  } else if (tool === "stagecraft") {
    const slides = join(source, "slides");
    if (existsSync(slides)) {
      for (const name of readdirSync(slides)) {
        for (const match of read(join(slides, name)).matchAll(/\bnotes?\s*:\s*(['"`])([\s\S]*?)\1/g)) {
          if (match[2].trim()) notes.push(match[2].trim());
        }
      }
    }
  }
  return notes;
}

async function walkDeck(page) {
  const seen = [];
  let unchanged = 0;
  let previous = "";
  for (let step = 0; step < 30 && unchanged < 3; step++) {
    await page.waitForTimeout(step === 0 ? 2500 : 1100);
    const snapshot = await page.evaluate(() => window.__snapshot());
    seen.push(snapshot);
    unchanged = snapshot.text === previous ? unchanged + 1 : 0;
    previous = snapshot.text;
    await page.keyboard.press("ArrowRight");
  }
  return seen;
}

export async function verify(tool, deliver, source) {
  const entry = join(deliver, "index.html");
  if (!existsSync(entry)) return { tool, opens: false, reason: "no index.html in the deliver folder" };
  const browser = await launchChrome();
  const blocked = [];
  const failed = [];
  const problems = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await context.route(
      (url) => url.protocol !== "file:",
      (route) => {
        blocked.push(route.request().url());
        route.abort();
      },
    );
    const page = await context.newPage();
    page.on("requestfailed", (request) => failed.push(request.url()));
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    await page.addInitScript(PAGE_HELPERS);
    await page.goto(pathToFileURL(entry).href, { waitUntil: "load" });
    const seen = await walkDeck(page);
    const text = seen.map((snapshot) => snapshot.text).join(" || ");
    const has = (needle) => text.includes(needle);
    const notes = notesOf(tool, source);
    const delivered = folderText(deliver);
    const quoted = (note) => delivered.includes(note.slice(0, 40));
    const result = {
      tool,
      opens: seen.some((snapshot) => snapshot.text.length > 0),
      snapshots: seen.length,
      blockedRequests: blocked.length,
      failedRequests: failed.length,
      problems: [...new Set(problems)].slice(0, 5),
      content: {
        title: has("Channel B now leads demand"),
        titleLine: has("A five-minute walk through the numbers, the method, and what to check next."),
        chartHeadingRevised: has("Channel B leads demand, 55 to 45"),
        staleHeadingVisible: has("60 to 40"),
        staleTextInFolder: delivered.includes("60 to 40"),
        chartNumbers: has("45") && has("55"),
        chartLabel: has("Units sold, Q3 (thousands)"),
        sourceLine: has("Source: Q3 demand survey, n = 1,204"),
        method: [
          "How we measured it",
          "Survey of 1,204 buyers in September",
          "Weighted to the sales mix by region",
          "Demand means stated intent within 90 days",
        ].every(has),
        risksHeading: has("Three things could change the picture"),
        risksHeadingExact: has(LONG_HEADING),
        risksPoints: [
          "The sample leans toward web buyers",
          "Stated intent is not purchase",
          "Q4 promotions may move both channels",
        ].every(has),
        nextSteps: [
          "What to check next",
          "Re-weight the sample by store traffic",
          "Compare stated intent with Q3 orders",
          "Repeat the survey after the Q4 promotions",
        ].every(has),
        sources: [
          "Sources",
          "Q3 demand survey, internal, n = 1,204",
          "Q3 orders export, finance, October",
        ].every(has),
      },
      offViewport: seen
        .filter((snapshot) => snapshot.off.length > 0)
        .map((snapshot) => snapshot.off.slice(0, 3)),
      notes: {
        found: notes.length,
        inDeliverable: notes.filter(quoted).length,
        visibleOnSlides: notes.filter((note) => has(note.slice(0, 40))).length,
      },
    };
    await context.close();
    return result;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tool, deliver, source, out] = process.argv.slice(2);
  if (!tool || !deliver || !source) {
    console.error(
      "Usage: node tools/trial/verify.mjs <depthcue|slidev|stagecraft> <deliver-folder> <source-folder> [out.json]",
    );
    process.exit(2);
  }
  const result = await verify(tool, deliver, source);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  console.log(text);
}
