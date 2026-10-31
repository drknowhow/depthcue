// Builds docs/demo/demo.json, the Kinescript scene for the demo video, from the brand tokens, the recorded transcript
// and the demo deck's demand scene. Nothing here is typed by hand: `pnpm demo:capture` records the inputs, this turns
// them into a scene, and `pnpm demo:render` turns the scene into docs/demo/demo.mp4.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildScene } from "./demo-scene.mjs";

const root = new URL("../", import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

/** The scene as the committed inputs describe it. */
export function sceneFromRepository() {
  return buildScene({
    tokens: json("brand/tokens.json"),
    transcript: json("docs/demo/transcript.json"),
    demand: json("fixtures/decks/demo/scenes/demand.json"),
  });
}

/** The text written to docs/demo/demo.json, which the test compares byte for byte. */
export function sceneText() {
  return `${JSON.stringify(sceneFromRepository(), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("docs/demo/demo.json", root), sceneText());
  console.log("demo: wrote docs/demo/demo.json");
}
