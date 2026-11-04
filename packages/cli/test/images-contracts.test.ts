// Schema 0.6 from the command line, on copies of the Tidewell deck: `depthcue apply` writes what the editor's session
// writes for the same image and background changes, and `depthcue check` reports a background picture that is not there.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, type Doc, docToFiles, loadDoc, type Op, revisionOf } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";
import { temporaryFolders } from "./brand-import-fixtures.ts";

const make = temporaryFolders();
const fixture = fileURLToPath(new URL("../../../fixtures/decks/tidewell-press", import.meta.url));

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

function copy(): string {
  const dir = make();
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

function docAt(dir: string): Doc {
  const { doc, diagnostics } = loadDoc(loadDeckDir(dir));
  if (!doc) throw new Error(JSON.stringify(diagnostics));
  return doc;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

/** A crop, a fit and a focus; a decorative picture without alt text; a scene's own background picture. */
const OPS = [
  {
    op: "block.set",
    scene: "launch-day",
    id: "launch-day-picture",
    set: { fit: "cover", crop: { x: 10, y: 5, w: 80, h: 70 }, focus: { x: 40, y: 60 } },
  },
  { op: "block.set", scene: "shore-guide", id: "shore-guide-picture", set: { decorative: true, alt: null } },
  {
    op: "scene.set",
    id: "part-one",
    set: { background: { asset: "assets/shoreline.svg", scrim: 60, color: "text", alt: "A low shore." } },
  },
] as Op[];
const CHANGED = ["scenes/launch-day.json", "scenes/shore-guide.json", "scenes/part-one.json"];

describe("schema 0.6, two ways in", () => {
  it("writes the same files from `depthcue apply` as the editor's session for the same changes", async () => {
    const agent = copy();
    const opsFile = join(make(), "ops.json");
    writeFileSync(opsFile, JSON.stringify(OPS));
    const applied = await cli("apply", agent, opsFile, "--base-rev", revisionOf(docAt(agent)));
    expect(applied.code, applied.err).toBe(0);

    const session = createSession(docAt(copy()));
    const result = session.apply(OPS);
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    const files = docToFiles(session.doc);
    for (const path of CHANGED) expect(read(agent, path), path).toBe(files[path]);
    expect(session.rev).toBe(revisionOf(docAt(agent)));

    const launch = JSON.parse(read(agent, "scenes/launch-day.json"));
    expect(launch.schemaVersion).toBe("0.6");
    expect(launch.blocks[0]).toMatchObject({
      fit: "cover",
      crop: { x: 10, y: 5, w: 80, h: 70 },
      focus: { x: 40, y: 60 },
    });
    const decorative = JSON.parse(read(agent, "scenes/shore-guide.json")).blocks.find(
      (block: { id: string }) => block.id === "shore-guide-picture",
    );
    expect(decorative).toMatchObject({ decorative: true });
    expect(decorative.alt).toBeUndefined();
    expect(JSON.parse(read(agent, "scenes/part-one.json")).schemaVersion).toBe("0.6");
    // A scene the operations did not touch keeps its file and its version.
    expect(read(agent, "scenes/cover.json")).toBe(read(fixture, "scenes/cover.json"));
    expect((await cli("check", agent)).code).toBe(0);
  });

  it("reports a background picture that is not there, at its path, and fails the check", async () => {
    const dir = copy();
    const path = join(dir, "scenes", "cover.json");
    const scene = JSON.parse(readFileSync(path, "utf8"));
    const background = { asset: "assets/gone.jpg", scrim: 50, decorative: true };
    writeFileSync(path, JSON.stringify({ ...scene, schemaVersion: "0.6", background }, null, 2));
    const checked = await cli("check", dir);
    expect(checked.code).toBe(1);
    expect(`${checked.out}\n${checked.err}`).toContain("assets/gone.jpg does not exist.");
    expect(`${checked.out}\n${checked.err}`).toContain("/background/asset");
  });
});
