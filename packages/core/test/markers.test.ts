import { describe, expect, it } from "vitest";
import {
  CUE_MAP_FORMAT,
  type Cue,
  checkCues,
  isMarker,
  keepMarkers,
  MARKER_TYPE,
  MAX_CUES,
  newMarker,
  nextMarkerId,
  readCueMap,
  roundedSeconds,
} from "../src/cues.ts";

const layer = (id: string, start: number, end = start + 1): Cue => ({
  id,
  type: "circle",
  in: start,
  out: end,
});
const marker = (id: string, start: number, end = 10): Cue => ({ id, type: MARKER_TYPE, in: start, out: end });

describe("markers", () => {
  it("are the cues of type marker, and no others", () => {
    expect(isMarker(marker("marker-1", 1))).toBe(true);
    expect(isMarker(layer("dot", 0))).toBe(false);
  });

  it("get the first id of the form marker-N that no cue has", () => {
    expect(nextMarkerId([])).toBe("marker-1");
    expect(nextMarkerId([marker("marker-1", 1), layer("marker-3", 2)])).toBe("marker-2");
    expect(nextMarkerId([marker("marker-2", 1)])).toBe("marker-1");
    expect(nextMarkerId([marker("marker-1", 1), marker("marker-2", 2), marker("marker-4", 3)])).toBe(
      "marker-3",
    );
  });

  it("are made at a time inside the clip and run to its end", () => {
    expect(newMarker([], 2.34567, 10)).toEqual({ id: "marker-1", type: "marker", in: 2.346, out: 10 });
    expect(newMarker([], -3, 10)?.in).toBe(0);
    expect(newMarker([], 99, 10)).toMatchObject({ in: 10, out: 10 });
  });

  it("round to whole milliseconds", () => {
    expect(roundedSeconds(1.23456)).toBe(1.235);
    expect(roundedSeconds(2)).toBe(2);
  });
});

describe("checkCues", () => {
  const ok = (given: unknown, duration = 10) => {
    const checked = checkCues(given, duration);
    if (!checked.ok) throw new Error(checked.message);
    return checked.cues;
  };
  const bad = (given: unknown, duration = 10) => {
    const checked = checkCues(given, duration);
    if (checked.ok) throw new Error("the cues should have been refused");
    return checked.message;
  };

  it("takes a good list and puts it in time order", () => {
    expect(ok([layer("b", 4), marker("marker-1", 1)]).map((cue) => cue.id)).toEqual(["marker-1", "b"]);
    expect(ok([])).toEqual([]);
  });

  it("refuses what is not a list, a list that is too long, and a cue that is not usable, by number", () => {
    expect(bad("nope")).toBe("The cues must be a list.");
    expect(bad(Array.from({ length: MAX_CUES + 1 }, (_, i) => layer(`c-${i}`, i)))).toContain(
      `at most ${MAX_CUES} cues`,
    );
    expect(bad([layer("a", 0), { id: "", type: "x", in: 0, out: 1 }])).toContain("Cue 2 is not usable");
    expect(bad([null])).toContain("Cue 1 is not usable");
    expect(bad([{ id: "a", in: 3, out: 1 }])).toContain("Cue 1 is not usable");
  });

  it("refuses two cues with one id, rather than dropping one without saying so", () => {
    expect(bad([layer("a", 0), marker("a", 1)])).toBe('Two cues are called "a". Ids must differ.');
  });

  it("refuses a marker that starts after the clip ends, and leaves the cues of the scene alone", () => {
    expect(bad([marker("marker-1", 11, 12)])).toContain("after the clip ends at 10 s");
    expect(ok([layer("late", 12)]).map((cue) => cue.id)).toEqual(["late"]);
  });
});

describe("keepMarkers", () => {
  const map = (cues: Cue[]) =>
    readCueMap({
      format: CUE_MAP_FORMAT,
      source: "assets/intro.mp4",
      duration: 4.2,
      width: 960,
      height: 540,
      fps: 30,
      cues,
    });

  it("keeps the markers of the earlier build next to what the scene says now", () => {
    const kept = keepMarkers([layer("dot", 0)], map([layer("old", 0), marker("marker-1", 2)]), 4.2);
    expect(kept.map((cue) => cue.id)).toEqual(["dot", "marker-1"]);
  });

  it("drops a marker past the end of the new video", () => {
    expect(keepMarkers([layer("dot", 0)], map([marker("marker-1", 9)]), 4.2).map((cue) => cue.id)).toEqual([
      "dot",
    ]);
  });

  it("gives way to a cue the scene now has under the same id", () => {
    const kept = keepMarkers([layer("marker-1", 0)], map([marker("marker-1", 2)]), 4.2);
    expect(kept).toEqual([layer("marker-1", 0)]);
  });

  it("is just the built cues when there was no earlier build", () => {
    expect(keepMarkers([layer("b", 1), layer("a", 0)], undefined, 4.2).map((cue) => cue.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
