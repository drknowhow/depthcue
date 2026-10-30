import { describe, expect, it } from "vitest";
import {
  clampPosition,
  formatRoute,
  gatedIds,
  nextPosition,
  parseRoute,
  previousPosition,
  progress,
  revealedIds,
  stepCount,
} from "../src/model.ts";
import { demoSource } from "./helpers.ts";

const { scenes } = demoSource();
// opening has no steps, demand has two, method has none
const [opening, demand] = scenes as [(typeof scenes)[0], (typeof scenes)[0]];

describe("steps", () => {
  it("counts a scene's steps and the ids they reveal", () => {
    expect(stepCount(opening)).toBe(0);
    expect(stepCount(demand)).toBe(2);
    expect([...gatedIds(demand)]).toEqual(["claim-shift", "chart-demand"]);
    expect(gatedIds(opening).size).toBe(0);
  });

  it("reveals nothing at step 0 and accumulates after that", () => {
    expect(revealedIds(demand, 0).size).toBe(0);
    expect([...revealedIds(demand, 1)]).toEqual(["claim-shift"]);
    expect([...revealedIds(demand, 2)]).toEqual(["claim-shift", "chart-demand"]);
    expect(revealedIds(demand, 9).size).toBe(2);
  });
});

describe("moving", () => {
  it("walks forward through steps and then into the next scene", () => {
    expect(nextPosition(scenes, { scene: 0, step: 0 })).toEqual({ scene: 1, step: 0 });
    expect(nextPosition(scenes, { scene: 1, step: 0 })).toEqual({ scene: 1, step: 1 });
    expect(nextPosition(scenes, { scene: 1, step: 2 })).toEqual({ scene: 2, step: 0 });
    expect(nextPosition(scenes, { scene: 2, step: 0 })).toBeNull();
  });

  it("walks back and lands on the earlier scene fully revealed", () => {
    expect(previousPosition(scenes, { scene: 2, step: 0 })).toEqual({ scene: 1, step: 2 });
    expect(previousPosition(scenes, { scene: 1, step: 1 })).toEqual({ scene: 1, step: 0 });
    expect(previousPosition(scenes, { scene: 0, step: 0 })).toBeNull();
  });

  it("clamps any position into the deck", () => {
    expect(clampPosition(scenes, { scene: 99, step: 99 })).toEqual({ scene: 2, step: 0 });
    expect(clampPosition(scenes, { scene: -3, step: -3 })).toEqual({ scene: 0, step: 0 });
    expect(clampPosition(scenes, { scene: 1, step: 7 })).toEqual({ scene: 1, step: 2 });
  });

  it("reports progress from 0 to 1", () => {
    expect(progress(scenes, { scene: 0, step: 0 })).toBe(0);
    expect(progress(scenes, { scene: 2, step: 0 })).toBe(1);
    const middle = progress(scenes, { scene: 1, step: 1 });
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(1);
  });

  it("calls a single-state deck complete", () => {
    expect(progress([opening], { scene: 0, step: 0 })).toBe(1);
  });
});

describe("routes", () => {
  it("round-trips every position through its hash", () => {
    for (const scene of [0, 1, 2]) {
      for (let step = 0; step <= stepCount(scenes[scene] ?? opening); step++) {
        const position = { scene, step };
        const hash = formatRoute(scenes, { kind: "scene", position });
        expect(parseRoute(scenes, hash)).toEqual({ kind: "scene", position });
      }
    }
  });

  it("writes short hashes", () => {
    expect(formatRoute(scenes, { kind: "scene", position: { scene: 1, step: 0 } })).toBe("#/demand");
    expect(formatRoute(scenes, { kind: "scene", position: { scene: 1, step: 2 } })).toBe("#/demand/2");
    expect(formatRoute(scenes, { kind: "read" })).toBe("#/read");
  });

  it("reads the reading view and rejects what it does not know", () => {
    expect(parseRoute(scenes, "#/read")).toEqual({ kind: "read" });
    expect(parseRoute(scenes, "")).toBeNull();
    expect(parseRoute(scenes, "#/nope")).toBeNull();
    expect(parseRoute(scenes, "#/demand/two")).toBeNull();
    expect(parseRoute(scenes, "#/demand/1.5")).toBeNull();
  });

  it("clamps a step that is out of range instead of failing", () => {
    expect(parseRoute(scenes, "#/demand/9")).toEqual({ kind: "scene", position: { scene: 1, step: 2 } });
    expect(parseRoute(scenes, "#/demand/-1")).toEqual({ kind: "scene", position: { scene: 1, step: 0 } });
  });
});
