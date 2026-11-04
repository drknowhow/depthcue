// Draws the photo-like picture the demo deck uses (a street of shops at dusk, 1600 by 1000) and saves it as a JPEG, so the
// file can be made again. There is no network download and no image generator in this repository, so the picture is drawn
// in headless Chrome from SVG, with film grain and a soft vignette, and photographed with a screenshot.
//
//   node tools/make-demo-photo.mjs [out.jpg]
//
// Without an argument it writes tools/demo-photo.jpg next to this script. Name it `shopfront-photo.jpg` and add it to the deck with
// `depthcue asset add fixtures/decks/demo shopfront-photo.jpg`, which gives it the hashed name the scenes use. Chrome or Edge is needed;
// set DEPTHCUE_BROWSER for another browser. The picture is deterministic: the same Chrome draws the same pixels.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const { chromium } = createRequire(fileURLToPath(new URL("packages/cli/package.json", root)))(
  "playwright-core",
);

const WIDTH = 1600;
const HEIGHT = 1000;

/** A small seeded generator, so the windows and the stars are the same on every run. */
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}
const rand = random(20260);

/** Lit windows in a grid on a wall: x, y, width and height of the wall, then the columns and rows. */
function windows(x, y, w, h, cols, rows, lit) {
  const cw = w / cols;
  const ch = h / rows;
  let out = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const on = rand() < lit;
      const fill = on ? (rand() < 0.5 ? "#ffd27a" : "#ffe9b0") : "#1c2740";
      out += `<rect x="${(x + c * cw + cw * 0.18).toFixed(1)}" y="${(y + r * ch + ch * 0.2).toFixed(1)}" width="${(cw * 0.64).toFixed(1)}" height="${(ch * 0.6).toFixed(1)}" fill="${fill}"${on ? ' filter="url(#glow)"' : ""}/>`;
    }
  }
  return out;
}

const building = (x, w, top, color) =>
  `<rect x="${x}" y="${top}" width="${w}" height="${700 - top}" fill="${color}"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2a55"/>
      <stop offset="0.45" stop-color="#8a5a8c"/>
      <stop offset="0.72" stop-color="#f09a5c"/>
      <stop offset="1" stop-color="#ffd28a"/>
    </linearGradient>
    <linearGradient id="road" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a3f52"/>
      <stop offset="1" stop-color="#14161f"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.55"/>
    </radialGradient>
    <radialGradient id="lamp" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffe6a8" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#ffe6a8" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.2"/></filter>
    <filter id="soft"><feGaussianBlur stdDeviation="1.1"/></filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.9 -0.28"/>
    </filter>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>
  <ellipse cx="1120" cy="560" rx="620" ry="190" fill="#ffc47a" opacity="0.35" filter="url(#soft)"/>
  <g filter="url(#soft)">
    <path d="M0 520 L90 470 L180 505 L300 430 L420 495 L560 450 L700 500 L820 440 L960 495 L1100 455 L1240 500 L1380 440 L1500 490 L1600 460 L1600 700 L0 700 Z" fill="#4a3f66"/>
    ${building(0, 210, 400, "#2b2b45")}
    ${building(210, 150, 330, "#34324f")}
    ${building(360, 260, 450, "#2b2b45")}
    ${building(1200, 180, 360, "#34324f")}
    ${building(1380, 220, 420, "#2b2b45")}
    ${windows(8, 420, 194, 270, 4, 7, 0.45)}
    ${windows(216, 350, 138, 340, 3, 8, 0.4)}
    ${windows(368, 470, 244, 220, 5, 5, 0.5)}
    ${windows(1208, 380, 164, 310, 4, 7, 0.5)}
    ${windows(1388, 440, 204, 250, 4, 6, 0.4)}
  </g>
  <rect x="0" y="680" width="${WIDTH}" height="320" fill="url(#road)"/>
  <!-- the first shop, on the left, closed -->
  <rect x="640" y="430" width="300" height="290" fill="#3d3a5c"/>
  <rect x="660" y="520" width="260" height="180" fill="#1f2640"/>
  <rect x="640" y="430" width="300" height="46" fill="#6b4a6e"/>
  <rect x="690" y="560" width="90" height="140" fill="#2a3252"/>
  <rect x="800" y="560" width="90" height="140" fill="#2a3252"/>
  <!-- the shop that is lit, on the right: awning, window, door, the goods on a table -->
  <rect x="980" y="380" width="360" height="340" fill="#5a3b48"/>
  <path d="M960 450 L1360 450 L1330 380 L990 380 Z" fill="#d9503f"/>
  <path d="M990 380 L1030 450 M1070 380 L1110 450 M1150 380 L1190 450 M1230 380 L1270 450 M1310 380 L1350 450" stroke="#f3e3c8" stroke-width="22" opacity="0.9"/>
  <rect x="1000" y="470" width="230" height="200" fill="#ffd991"/>
  <rect x="1000" y="470" width="230" height="200" fill="url(#lamp)"/>
  <rect x="1250" y="480" width="70" height="240" fill="#2a1d28"/>
  <rect x="1262" y="496" width="46" height="120" fill="#ffd991" opacity="0.8"/>
  <rect x="1020" y="610" width="190" height="14" fill="#8a5a3c"/>
  <g>
    <circle cx="1050" cy="590" r="20" fill="#e4572e"/><circle cx="1095" cy="596" r="18" fill="#f2a541"/>
    <circle cx="1138" cy="592" r="21" fill="#e4572e"/><circle cx="1180" cy="597" r="17" fill="#f2a541"/>
    <rect x="1030" y="520" width="60" height="70" fill="#6bb36b" opacity="0.9"/>
    <rect x="1110" y="510" width="70" height="80" fill="#4f8fbf" opacity="0.9"/>
  </g>
  <!-- a lamp post and its light on the road -->
  <rect x="560" y="360" width="10" height="340" fill="#15161f"/>
  <circle cx="565" cy="352" r="16" fill="#ffe6a8"/>
  <circle cx="565" cy="352" r="90" fill="url(#lamp)"/>
  <ellipse cx="1120" cy="800" rx="380" ry="46" fill="#ffd991" opacity="0.28" filter="url(#soft)"/>
  <ellipse cx="565" cy="820" rx="150" ry="26" fill="#ffe6a8" opacity="0.22" filter="url(#soft)"/>
  <!-- two people walking past the lit shop -->
  <g fill="#10121b">
    <ellipse cx="1008" cy="640" rx="19" ry="21"/><rect x="988" y="660" width="40" height="120" rx="14"/>
    <ellipse cx="1072" cy="648" rx="17" ry="19"/><rect x="1054" y="666" width="36" height="112" rx="13"/>
  </g>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#vignette)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" filter="url(#grain)" opacity="0.22"/>
</svg>`;

const out = process.argv[2] ? process.argv[2] : fileURLToPath(new URL("demo-photo.jpg", import.meta.url));
const browser = await chromium.launch(
  process.env.DEPTHCUE_BROWSER ? { executablePath: process.env.DEPTHCUE_BROWSER } : { channel: "chrome" },
);
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.setContent(`<style>html,body{margin:0;background:#000}svg{display:block}</style>${svg}`);
  const bytes = await page.screenshot({ type: "jpeg", quality: 78 });
  writeFileSync(out, bytes);
  console.log(`${out}: ${WIDTH} by ${HEIGHT}, ${bytes.length} bytes`);
} finally {
  await browser.close();
}
