/**
 * `pnpm check:pptx-pages`: another reader of the PowerPoint files must find one page per slide. Exports every fixture
 * deck as it is, with --pictures and with --steps, using the built CLI, then has LibreOffice convert each file to PDF,
 * one at a time and each with a profile of its own, and compares the PDF's pages with the slides the export reported.
 *
 * It is a script and not a test: LibreOffice running beside the editor's real-browser tests on Windows made
 * edit-e2e's "moves freely while Alt is held" fail. Run it after the tests, never beside them. CI does not run it.
 *
 * Exit 0 when every file matches, 1 when one does not or an export or conversion fails, 2 when it cannot run here (no
 * LibreOffice, or the CLI is not built). DEPTHCUE_SOFFICE names LibreOffice's soffice when it is somewhere else.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = join(repo, "packages", "cli", "dist", "main.js");
const decks = join(repo, "fixtures", "decks");

const soffice = [
  process.env.DEPTHCUE_SOFFICE,
  "C:/Program Files/LibreOffice/program/soffice.exe",
  "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/usr/local/bin/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
].find((path) => path && existsSync(path));

if (!soffice) {
  console.log(
    "LibreOffice is not installed here (or set DEPTHCUE_SOFFICE to its soffice), so nothing was checked.",
  );
  process.exit(2);
}
if (!existsSync(cli)) {
  console.log(`The CLI is not built (${cli} is missing). Run pnpm build first.`);
  process.exit(2);
}

const MODES = [
  { name: "plain", flags: [] },
  { name: "pictures", flags: ["--pictures"] },
  { name: "steps", flags: ["--steps"] },
];

const work = mkdtempSync(join(tmpdir(), "depthcue-pptx-pages-"));
let failed = 0;
let checked = 0;
let total = 0;
try {
  const names = readdirSync(decks, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(decks, entry.name, "deck.json")))
    .map((entry) => entry.name)
    .sort();
  for (const deck of names) {
    for (const mode of MODES) {
      total++;
      const label = `${deck} (${mode.name})`;
      const out = join(work, `${deck}-${mode.name}.pptx`);
      const exported = spawnSync(
        process.execPath,
        [cli, "export", join(decks, deck), "--format", "pptx", "--out", out, "--json", ...mode.flags],
        { encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
      );
      let summary;
      try {
        summary = JSON.parse(exported.stdout);
      } catch {
        summary = undefined;
      }
      if (exported.status !== 0 || !summary?.ok) {
        failed++;
        console.log(
          `${label}: the export failed (exit ${exported.status}): ${(exported.stdout || exported.stderr).trim().slice(0, 400)}`,
        );
        continue;
      }
      const slides = summary.slides.length;
      // One conversion at a time, each with its own profile, so no two LibreOffice processes share or race on one.
      const profile = join(work, `profile-${deck}-${mode.name}`);
      const pdfDir = join(work, `pdf-${deck}-${mode.name}`);
      mkdirSync(pdfDir, { recursive: true });
      const converted = spawnSync(
        soffice,
        [
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          pdfDir,
          out,
        ],
        { encoding: "utf8", timeout: 300_000 },
      );
      const pdf = join(pdfDir, `${basename(out, ".pptx")}.pdf`);
      if (!existsSync(pdf)) {
        failed++;
        console.log(
          `${label}: LibreOffice made no PDF (exit ${converted.status}): ${(converted.stderr || converted.stdout).trim().slice(0, 400)}`,
        );
        continue;
      }
      const pages = (readFileSync(pdf, "latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
      checked++;
      const ok = pages === slides;
      if (!ok) failed++;
      console.log(`${label}: ${slides} slides, ${pages} pages${ok ? "" : " (MISMATCH)"}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(
  failed === 0
    ? `All ${checked} files open in LibreOffice with one page per slide.`
    : `${failed} of ${total} files failed: an export, a conversion, or pages that are not one per slide.`,
);
process.exitCode = failed === 0 ? 0 : 1;
