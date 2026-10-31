// A stand-in for the `kine` program, so the clip tests run where Kinescript is not installed.
// It answers the four calls Depthcue makes and writes small files where the real one writes media.
// Behaviour comes from the environment: STUB_LOG (file to append each call's arguments to),
// STUB_VERSION, STUB_FAIL (a command name that exits 3), STUB_SLOW (render waits until killed),
// STUB_PID (file to write this process's id to when rendering starts), STUB_NOISE (a count: a failure prints
// that many lines first), STUB_NO_OUTPUT (render reports success without writing the video).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const [command] = args;
const env = process.env;

if (env.STUB_LOG) appendFileSync(env.STUB_LOG, `${JSON.stringify(args)}\n`);

const after = (flag) => args[args.indexOf(flag) + 1];
const fail = (message) => {
  for (let line = 1; line <= Number(env.STUB_NOISE ?? 0); line += 1)
    process.stderr.write(`stub noise ${line}\n`);
  process.stderr.write(`${message}\n`);
  process.exit(3);
};

if (command === "--version") {
  process.stdout.write(`${env.STUB_VERSION ?? "kinescript 9.9.9-stub"}\n`);
} else if (env.STUB_FAIL === command) {
  fail(`stub: ${command} failed on purpose`);
} else if (command === "probe") {
  const scene = JSON.parse(readFileSync(args[1], "utf8"));
  if (!scene.probe) fail("stub: the scene has no probe field");
  process.stdout.write(`${JSON.stringify(scene.probe)}\n`);
} else if (command === "render") {
  if (env.STUB_PID) writeFileSync(env.STUB_PID, String(process.pid));
  if (env.STUB_SLOW) {
    setInterval(() => {}, 1000);
  } else {
    const out = after("-o");
    if (!env.STUB_NO_OUTPUT) writeFileSync(out, `video ${args.join(" ")}`);
    process.stdout.write(
      `${JSON.stringify({ ok: true, out, w: 960, h: 540, fps: 30, frames: 126, seconds: 4.2 })}\n`,
    );
  }
} else if (command === "still") {
  const out = after("-o");
  writeFileSync(out, `poster ${args.join(" ")}`);
  process.stdout.write(
    `${JSON.stringify({ ok: true, out, frame: 63, at: Number(after("--at")), w: 960, h: 540 })}\n`,
  );
} else {
  fail(`stub: unknown command ${command}`);
}
