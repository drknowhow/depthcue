#!/usr/bin/env node
/**
 * Draws packages/cli/icons/depthcue.ico, the icon Windows shows on .dcue files: the mark from brand/mark.svg on a
 * paper tile, so it reads on light and dark folders alike, rendered in Chrome or Edge at each icon size and packed as
 * PNG images in one .ico. Usage: node tools/build-icon.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(`../${relative}`, import.meta.url));
const { chromium } = createRequire(path("packages/cli/package.json"))("playwright-core");

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const tokens = JSON.parse(readFileSync(path("brand/tokens.json"), "utf8"));
const paper = tokens.color.brand.paper.$value;
const mark = readFileSync(path("brand/mark.svg"), "utf8");
const inner = mark.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="1" y="1" width="62" height="62" rx="12" fill="${paper}" stroke="#14161B" stroke-opacity="0.18" stroke-width="1"/><g transform="translate(8 7) scale(0.75)">${inner}</g></svg>`;

async function launch() {
  for (const options of [{ channel: "chrome" }, { channel: "msedge" }]) {
    try {
      return await chromium.launch(options);
    } catch {
      // Try the next browser.
    }
  }
  throw new Error("Needs Chrome or Edge installed.");
}

const browser = await launch();
const images = [];
try {
  const page = await browser.newPage();
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${tile}`,
    );
    images.push({ size, png: await page.screenshot({ omitBackground: true, type: "png" }) });
  }
} finally {
  await browser.close();
}

// ICONDIR, one ICONDIRENTRY per size, then the PNG files themselves. A size of 256 is written as 0.
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, png }, index) => {
  const at = 6 + 16 * index;
  header.writeUInt8(size >= 256 ? 0 : size, at);
  header.writeUInt8(size >= 256 ? 0 : size, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(png.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
const out = path("packages/cli/icons/depthcue.ico");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, ...images.map(({ png }) => png)]));
console.log(`icon: wrote packages/cli/icons/depthcue.ico (${SIZES.join(", ")} px)`);
