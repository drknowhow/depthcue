// Renders docs/demo/demo.json to docs/demo/demo.mp4 with Kinescript, then records which scene the video was made from
// in docs/demo/demo.sha256, so tools/demo.test.mjs can tell when the scene has changed and the video has not.
// Kinescript is a separate Python tool. Set KINE to its `kine` executable, or have `kine` on the PATH.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));
const kine = process.env.KINE || "kine";

const scene = path("docs/demo/demo.json");
const video = path("docs/demo/demo.mp4");

const checked = spawnSync(kine, ["check", scene], { encoding: "utf8" });
if (checked.error || checked.status !== 0) {
  console.error(
    checked.error
      ? `Could not run ${kine}: ${checked.error.message}\nInstall Kinescript or set KINE to its kine executable.`
      : `kine check failed:\n${checked.stdout}${checked.stderr}`,
  );
  process.exit(1);
}
const report = JSON.parse(checked.stdout);
if (!report.ok || report.warnings > 0) {
  console.error(
    `kine check found ${report.errors} errors and ${report.warnings} warnings. Fix the scene first.`,
  );
  process.exit(1);
}

const rendered = spawnSync(kine, ["render", scene, "-o", video], { stdio: "inherit" });
if (rendered.status !== 0) process.exit(rendered.status ?? 1);

const sum = createHash("sha256").update(readFileSync(scene)).digest("hex");
writeFileSync(path("docs/demo/demo.sha256"), `${sum}\n`);
console.log(`demo: rendered docs/demo/demo.mp4 from scene ${sum.slice(0, 12)}`);
