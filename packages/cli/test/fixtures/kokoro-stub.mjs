// A stand-in for Python with Kokoro, so the voice tests run where neither is installed. It is run as
// `node kokoro-stub.mjs -I <helper.py> --voice <v> --text-file <f> --out <wav> --words <json>` and for the
// `-c "import <module>"` checks that `voice doctor` makes. Behaviour comes from the environment: STUB_LOG (file
// to append each call's arguments to), STUB_MISSING (a module name that cannot be imported), STUB_FAIL (exit 4
// with a message).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const env = process.env;
if (env.STUB_LOG) appendFileSync(env.STUB_LOG, `${JSON.stringify(args)}\n`);

if (args[0] === "-c") {
  const module = args[1]?.replace(/^import /, "");
  process.exit(module === env.STUB_MISSING ? 1 : 0);
}

const after = (flag) => args[args.indexOf(flag) + 1];
if (env.STUB_MISSING) {
  process.stderr.write(`missing module: ${env.STUB_MISSING}\n`);
  process.exit(3);
}
if (env.STUB_FAIL) {
  process.stderr.write("stub: Kokoro failed on purpose\n");
  process.exit(4);
}
const text = readFileSync(after("--text-file"), "utf8");
const words = text
  .split(/\s+/)
  .filter(Boolean)
  .map((word, i) => ({ text: word, start: i * 0.4, end: i * 0.4 + 0.35 }));
writeFileSync(after("--out"), `wav ${after("--voice")} ${text}`);
writeFileSync(
  after("--words"),
  JSON.stringify({ format: "depthcue-words/1", duration: words.length * 0.4, words }),
);
