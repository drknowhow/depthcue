// `depthcue asset`: add, list, unused and remove from the command line, and `depthcue check` on a large image.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LARGE_ASSET_BYTES } from "../src/images.ts";
import { run } from "../src/index.ts";
import { temporaryFolders } from "./brand-import-fixtures.ts";
import { jpeg, png } from "./images-fixtures.ts";

const make = temporaryFolders();
const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

function deck(): string {
  const dir = make();
  cpSync(demo, dir, { recursive: true });
  return dir;
}

function file(name: string, bytes: Buffer): string {
  const path = join(make(), name);
  writeFileSync(path, bytes);
  return path;
}

describe("depthcue asset", () => {
  it("adds files, lists them with their size and use, and reports the unused ones", async () => {
    const dir = deck();
    const added = await cli(
      "asset",
      "add",
      dir,
      file("Team Photo.png", png(640, 480)),
      file("b.jpg", jpeg(30, 20)),
    );
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/assets\/team-photo-[0-9a-f]{8}\.png {2}640x480/);
    expect(added.out).toMatch(/assets\/b-[0-9a-f]{8}\.jpg {2}30x20/);

    const listed = JSON.parse((await cli("asset", "list", dir, "--json")).out);
    expect(listed.assets.map((a: { asset: string }) => a.asset)).toHaveLength(3);
    const method = listed.assets.find((a: { asset: string }) => a.asset === "assets/method.svg");
    expect(method.usedBy[0].scene).toBe("method");

    const unused = await cli("asset", "unused", dir);
    expect(unused.code).toBe(0);
    expect(unused.out).toContain("team-photo-");
    expect(unused.out).not.toContain("method.svg");
    expect((await cli("asset", "list", dir)).out).toContain("used 1 time: method");
  });

  it("adds the files it can and fails for the ones it cannot", async () => {
    const dir = deck();
    const folder = make();
    const refused = await cli(
      "asset",
      "add",
      dir,
      file("ok.png", png(2, 2)),
      folder,
      file("doc.txt", Buffer.from("hello")),
    );
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/ok-[0-9a-f]{8}\.png/);
    expect(refused.err).toContain("not a regular file");
    expect(refused.err).toContain("Only PNG, JPEG, GIF, WebP and plain SVG");
  });

  it("removes an unused image and refuses a used one", async () => {
    const dir = deck();
    const added = JSON.parse((await cli("asset", "add", dir, file("a.png", png(3, 3)), "--json")).out);
    const asset = added.added[0].asset as string;
    const used = await cli("asset", "remove", dir, "assets/method.svg");
    expect(used.code).toBe(1);
    expect(used.err).toContain("is used 1 time");
    expect(existsSync(join(dir, "assets/method.svg"))).toBe(true);

    expect((await cli("asset", "remove", dir, asset)).code).toBe(0);
    expect(existsSync(join(dir, asset))).toBe(false);
    expect((await cli("asset", "remove", dir, "assets/report.csv")).code).toBe(1);
  });

  it("asks for what it needs", async () => {
    const dir = deck();
    expect((await cli("asset")).code).toBe(2);
    expect((await cli("asset", "add", dir)).code).toBe(2);
    expect((await cli("asset", "remove", dir)).code).toBe(2);
    expect((await cli("asset", "list", dir, "--force")).code).toBe(2);
    expect((await cli("asset", "add", make(), file("a.png", png(2, 2)))).code).toBe(1);
  });

  it("makes check warn about a large image a scene uses, without failing", async () => {
    const dir = deck();
    const quiet = await cli("check", dir, "--json");
    expect(quiet.out).not.toContain("asset-large");
    const big = png(2, 2, LARGE_ASSET_BYTES + 100);
    writeFileSync(join(dir, "assets/big.png"), big);
    const scene = join(dir, "scenes/method.json");
    const text = JSON.parse(readFileSync(scene, "utf8"));
    text.blocks.find((b: { type: string }) => b.type === "image").asset = "assets/big.png";
    writeFileSync(scene, JSON.stringify(text));
    const checked = await cli("check", dir, "--json");
    expect(checked.code).toBe(0);
    expect(checked.out).toContain('"code": "asset-large"');
    expect(checked.out).toContain('"fix"');
  });
});
