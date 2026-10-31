import { describe, expect, it } from "vitest";
import {
  applyOps,
  type BuildTarget,
  buildOf,
  type Doc,
  type Placed,
  placeInBuild,
  revealable,
  revisionOf,
  type Scene,
  STEPS_MAX,
} from "../src/index.ts";
import { demoDoc } from "./helpers.ts";

const text = (id: string) => ({ id, type: "text", role: "body", text: id });

const lab = {
  id: "b-lab",
  title: "Lab",
  layout: "claim-evidence",
  summary: { id: "b-claim", text: "A claim", evidenceIds: ["b-one"] },
  blocks: [text("b-one"), text("b-two"), text("b-three"), text("b-four")],
  steps: [
    { id: "b-s1", reveal: ["b-claim"] },
    { id: "b-s2", reveal: ["b-one", "b-two"] },
    { id: "b-s3", reveal: ["b-three"] },
  ],
};
const plain = { id: "b-plain", title: "Plain", layout: "title", blocks: [text("p-one"), text("p-two")] };
const tricky = {
  id: "b-tricky",
  title: "Tricky",
  layout: "title",
  blocks: [text("b-tricky-step-1"), text("t-two")],
};
const twice = {
  id: "b-twice",
  title: "Twice",
  layout: "title",
  blocks: [text("w-one"), text("w-two")],
  steps: [
    { id: "w-s1", reveal: ["w-one"] },
    { id: "w-s2", reveal: ["w-one", "w-two"] },
  ],
};
// The most steps. A scene holds 12 blocks, so an agent reaches that many only by naming a block in more than one step:
// 11 blocks cycle through 24 steps, one block each, and a twelfth is named by none.
const full = {
  id: "b-full",
  title: "Full",
  layout: "title",
  blocks: [...Array.from({ length: 11 }, (_, i) => text(`f-${i}`)), text("f-extra")],
  steps: Array.from({ length: STEPS_MAX }, (_, i) => ({ id: `f-step-${i}`, reveal: [`f-${i % 11}`] })),
};

function deckWith(...scenes: object[]): Doc {
  const doc = demoDoc();
  const result = applyOps(
    doc,
    scenes.map((scene) => ({ op: "scene.add", scene })),
    revisionOf(doc),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.doc;
}

const doc = deckWith(lab, plain, tricky, twice, full);
const sceneOf = (id: string) => doc.scenes[id] as Scene;
const stepsOf = (scene: Scene) => (scene.steps ?? []).map((step) => [step.id, ...step.reveal]);

/** Moves a part and applies the result to the deck, which holds the scene. */
function placed(scene: Scene, id: string, to: BuildTarget) {
  const answer: Placed = placeInBuild(scene, id, to);
  if (!answer.ok) throw new Error(answer.message);
  if (answer.ops.length === 0) return { ops: answer.ops, scene };
  const result = applyOps(doc, answer.ops, revisionOf(doc));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return { ops: answer.ops, scene: result.doc.scenes[scene.id] as Scene };
}

const refusal = (scene: Scene, id: string, to: BuildTarget) => {
  const answer = placeInBuild(scene, id, to);
  if (answer.ok) throw new Error("expected a refusal");
  return answer.message;
};

describe("the order a scene builds in", () => {
  it("lists the claim and then every block, which are what a step can reveal", () => {
    expect(revealable(sceneOf("b-lab"))).toEqual(["b-claim", "b-one", "b-two", "b-three", "b-four"]);
    expect(revealable(sceneOf("b-plain"))).toEqual(["p-one", "p-two"]);
  });

  it("says which step shows each part, counted from 1, and none for what is there from the start", () => {
    expect(buildOf(sceneOf("b-lab"))).toEqual([
      { id: "b-claim", step: 1 },
      { id: "b-one", step: 2 },
      { id: "b-two", step: 2 },
      { id: "b-three", step: 3 },
      { id: "b-four", step: undefined },
    ]);
  });

  it("puts a part some steps name more than once at the first of them", () => {
    expect(buildOf(sceneOf("b-twice"))).toEqual([
      { id: "w-one", step: 1 },
      { id: "w-two", step: 2 },
    ]);
  });

  it("agrees with the player on what is there from the start, on the demo deck", () => {
    const scene = sceneOf("demand");
    const started = buildOf(scene)
      .filter((entry) => entry.step === undefined)
      .map((entry) => entry.id);
    const gated = new Set((scene.steps ?? []).flatMap((step) => step.reveal));
    expect(started).toEqual(revealable(scene).filter((id) => !gated.has(id)));
  });
});

describe("moving a part to another point of the build", () => {
  const lines = (scene: Scene) => stepsOf(scene);

  it("takes it out of its step, to the start, as one scene.set", () => {
    const { ops, scene } = placed(sceneOf("b-lab"), "b-two", "start");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "scene.set", id: "b-lab" });
    expect(lines(scene)).toEqual([
      ["b-s1", "b-claim"],
      ["b-s2", "b-one"],
      ["b-s3", "b-three"],
    ]);
  });

  it("puts it with another step, at the end of what that step reveals", () => {
    const { scene } = placed(sceneOf("b-lab"), "b-one", 3);
    expect(lines(scene)).toEqual([
      ["b-s1", "b-claim"],
      ["b-s2", "b-two"],
      ["b-s3", "b-three", "b-one"],
    ]);
  });

  it("brings a part that was there from the start into a step", () => {
    const { scene } = placed(sceneOf("b-lab"), "b-four", 1);
    expect(lines(scene)[0]).toEqual(["b-s1", "b-claim", "b-four"]);
  });

  it("leaves no empty step behind, and the steps after it count one less", () => {
    const { scene } = placed(sceneOf("b-lab"), "b-claim", 3);
    expect(lines(scene)).toEqual([
      ["b-s2", "b-one", "b-two"],
      ["b-s3", "b-three", "b-claim"],
    ]);
    expect(buildOf(scene).find((entry) => entry.id === "b-claim")?.step).toBe(2);
  });

  it("takes the step number as the scene has it now, before anything leaves", () => {
    // The claim is alone in step 1, which goes when it leaves; step 3 is still "step 3" to the one asking.
    const { scene } = placed(sceneOf("b-lab"), "b-claim", 2);
    expect(lines(scene)).toEqual([
      ["b-s2", "b-one", "b-two", "b-claim"],
      ["b-s3", "b-three"],
    ]);
  });

  it("clears the steps of a scene whose last part goes back to the start", () => {
    const one = placed(sceneOf("b-lab"), "b-claim", "start").scene;
    const two = placed(one, "b-one", "start").scene;
    const three = placed(two, "b-two", "start").scene;
    const four = placed(three, "b-three", "start").scene;
    expect(four.steps).toBeUndefined();
  });

  it("gives a part a step of its own, after the last, with an id of its own", () => {
    const { scene } = placed(sceneOf("b-lab"), "b-one", "new");
    expect(lines(scene)).toEqual([
      ["b-s1", "b-claim"],
      ["b-s2", "b-two"],
      ["b-s3", "b-three"],
      ["b-lab-step-4", "b-one"],
    ]);
  });

  it("starts a build on a scene that has none", () => {
    const { scene } = placed(sceneOf("b-plain"), "p-two", "new");
    expect(lines(scene)).toEqual([["b-plain-step-1", "p-two"]]);
  });

  it("does not take the id of a block for a new step", () => {
    const { scene } = placed(sceneOf("b-tricky"), "t-two", "new");
    expect(lines(scene)).toEqual([["b-tricky-step-2", "t-two"]]);
  });

  it("keeps a part in the first step it was named in, and out of the later one it left", () => {
    const { scene } = placed(sceneOf("b-twice"), "w-one", 1);
    expect(lines(scene)).toEqual([
      ["w-s1", "w-one"],
      ["w-s2", "w-two"],
    ]);
  });

  it("changes nothing, with no operations, when the part is already there", () => {
    expect(placeInBuild(sceneOf("b-lab"), "b-two", 2)).toEqual({ ok: true, ops: [] });
    expect(placeInBuild(sceneOf("b-lab"), "b-four", "start")).toEqual({ ok: true, ops: [] });
    expect(placeInBuild(sceneOf("b-plain"), "p-one", "start")).toEqual({ ok: true, ops: [] });
    expect(placeInBuild(sceneOf("b-lab"), "b-three", "new")).toEqual({ ok: true, ops: [] });
  });

  it("does not shuffle the parts of a step when it is moved to where it already is", () => {
    expect(placeInBuild(sceneOf("b-lab"), "b-one", 2)).toEqual({ ok: true, ops: [] });
  });
});

describe("what is refused", () => {
  it("names a part the scene does not have", () => {
    expect(refusal(sceneOf("b-lab"), "nope", "start")).toMatch(/nothing called "nope"/);
  });

  it("names a step the scene does not have", () => {
    expect(refusal(sceneOf("b-lab"), "b-one", 4)).toBe("This scene has no step 4.");
    expect(refusal(sceneOf("b-lab"), "b-one", 0)).toBe("This scene has no step 0.");
    expect(refusal(sceneOf("b-lab"), "b-one", 1.5)).toBe("This scene has no step 1.5.");
    expect(refusal(sceneOf("b-plain"), "p-one", 1)).toBe("This scene has no step 1.");
  });

  it("stops at the most steps a scene holds, and says to share one", () => {
    expect(refusal(sceneOf("b-full"), "f-extra", "new")).toMatch(/at most 24 steps/);
    expect(placed(sceneOf("b-full"), "f-extra", 24).scene.steps?.at(-1)?.reveal).toEqual(["f-1", "f-extra"]);
  });

  it("lets a part leave the steps it is named in for a new one, though the scene holds the most", () => {
    // f-3 is named in step 4 and step 15, each its alone, so both go and one new step comes.
    const { scene } = placed(sceneOf("b-full"), "f-3", "new");
    expect(scene.steps).toHaveLength(STEPS_MAX - 1);
    expect(scene.steps?.at(-1)?.reveal).toEqual(["f-3"]);
  });
});

describe("every move that is allowed", () => {
  const targets = (scene: Scene): BuildTarget[] => [
    "start",
    "new",
    ...(scene.steps ?? []).map((_, index) => index + 1),
  ];

  for (const id of ["b-lab", "b-plain", "b-tricky", "b-twice"]) {
    it(`leaves ${id} a valid deck with each part where it was sent`, () => {
      const scene = sceneOf(id);
      let moved = 0;
      for (const part of revealable(scene)) {
        for (const to of targets(scene)) {
          const answer = placeInBuild(scene, part, to);
          if (!answer.ok) continue;
          moved += 1;
          if (answer.ops.length === 0) continue;
          const result = applyOps(doc, answer.ops, revisionOf(doc));
          if (!result.ok) throw new Error(`${part} ${to}: ${JSON.stringify(result.diagnostics)}`);
          const next = result.doc.scenes[id] as Scene;
          const now = buildOf(next).find((entry) => entry.id === part)?.step;
          if (to === "start") expect(now).toBeUndefined();
          else if (to === "new") expect(now).toBe(next.steps?.length);
          else expect(next.steps?.[(now as number) - 1]?.id).toBe(scene.steps?.[to - 1]?.id);
          // No other part moved to a different point of the build.
          const other = (entry: { id: string }) => entry.id !== part;
          const before = buildOf(scene)
            .filter(other)
            .map((entry) => entry.step !== undefined);
          const after = buildOf(next)
            .filter(other)
            .map((entry) => entry.step !== undefined);
          expect(after).toEqual(before);
        }
      }
      expect(moved).toBeGreaterThan(0);
    });
  }
});
