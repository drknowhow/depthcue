// Builds the same 50-scene deck for each tool, so the speed measurements compare like with like: a heading
// "Scene N" and three short lines on every scene, no images, no charts. docs/TRIAL.md says what that leaves out.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "./lib.mjs";

export const SCENES = 50;
const pad = (n) => String(n).padStart(2, "0");
const lines = (n) => [`Point A of scene ${n}`, `Point B of scene ${n}`, `Point C of scene ${n}`];

/** A Depthcue deck folder, exported to a folder that opens from a static host. Returns the exported folder. */
export function buildDepthcue(work) {
  const deck = join(work, "depthcue-deck");
  rmSync(deck, { recursive: true, force: true });
  mkdirSync(join(deck, "scenes"), { recursive: true });
  const ids = Array.from({ length: SCENES }, (_, i) => `scene-${pad(i + 1)}`);
  writeFileSync(
    join(deck, "deck.json"),
    JSON.stringify(
      { schemaVersion: "0.1", id: "bench", title: "Bench deck", language: "en", theme: "paper", scenes: ids },
      null,
      2,
    ),
  );
  ids.forEach((id, index) => {
    const n = index + 1;
    writeFileSync(
      join(deck, "scenes", `${id}.json`),
      JSON.stringify(
        {
          schemaVersion: "0.1",
          id,
          title: `Scene ${n}`,
          layout: "title",
          lead: "human",
          blocks: [
            { id: `${id}-title`, type: "text", role: "heading", text: `Scene ${n}` },
            { id: `${id}-body`, type: "text", role: "body", text: lines(n).join(". ") + "." },
          ],
          reading: { text: lines(n).join(". ") + "." },
          notes: `Notes for scene ${n}.`,
        },
        null,
        2,
      ),
    );
  });
  const out = join(work, "depthcue-site");
  const cli = repoPath("packages/cli/dist/main.js");
  const check = spawnSync(process.execPath, [cli, "check", deck], { encoding: "utf8" });
  if (check.status !== 0)
    throw new Error(`The generated Depthcue deck does not pass check:\n${check.stdout}${check.stderr}`);
  const exported = spawnSync(process.execPath, [cli, "export", deck, "--out", out], { encoding: "utf8" });
  if (exported.status !== 0) throw new Error(`depthcue export failed:\n${exported.stdout}${exported.stderr}`);
  return out;
}

/** The Slidev project's markdown for the bench deck. */
export function slidevMarkdown() {
  const slides = Array.from({ length: SCENES }, (_, i) => {
    const n = i + 1;
    return `# Scene ${n}\n\n${lines(n)
      .map((line) => `- ${line}`)
      .join("\n")}\n`;
  });
  return `---\ntheme: default\ntitle: Bench deck\n---\n\n${slides.join("\n---\n\n")}`;
}

/** A Stagecraft project folder: the starter's page, its runtime and one slide file per scene. */
export function buildStagecraft(work, installed) {
  const project = join(work, "stagecraft-site");
  rmSync(project, { recursive: true, force: true });
  mkdirSync(join(project, "slides"), { recursive: true });
  mkdirSync(join(project, "node_modules", "stagecraft"), { recursive: true });
  cpSync(
    join(installed, "node_modules", "stagecraft", "dist"),
    join(project, "node_modules", "stagecraft", "dist"),
    {
      recursive: true,
    },
  );
  const starter = join(installed, "node_modules", "stagecraft", "starter");
  cpSync(join(starter, "index.html"), join(project, "index.html"));
  const slides = [];
  for (let n = 1; n <= SCENES; n++) {
    const file = `slides/${pad(n)}.js`;
    slides.push(`    { src: '${file}' }`);
    writeFileSync(
      join(project, file),
      `'use strict';\n\nStage.register(Stage.KineticText({\n  section: ${n},\n  title: 'Part ${n}',\n  pace: 300,\n  lines: [\n    { text: 'Scene ${n}', color: 'fg' },\n${lines(
        n,
      )
        .map((line) => `    { text: '${line}', color: 'dim' }`)
        .join(",\n")}\n  ]\n}));\n`,
    );
  }
  writeFileSync(
    join(project, "stagecraft.config.js"),
    `'use strict';\n\nStage.deck({\n  theme: 'phosphor',\n  slides: [\n${slides.join(",\n")}\n  ]\n});\n`,
  );
  return project;
}
