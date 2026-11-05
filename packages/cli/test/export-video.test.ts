import { describe, expect, it } from "vitest";
import { concatList, shotsOf, wavSeconds } from "../src/export-video.ts";

function wav(seconds: number, rate = 24000): Uint8Array {
  const data = seconds * rate * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, data, true);
  return bytes;
}

describe("wavSeconds", () => {
  it("reads the length of a PCM file from its header", () => {
    expect(wavSeconds(wav(3.5))).toBeCloseTo(3.5, 5);
  });

  it("skips chunks it does not know before the data", () => {
    const plain = wav(1);
    const extra = new Uint8Array(plain.length + 12);
    extra.set(plain.subarray(0, 36));
    extra.set(new TextEncoder().encode("LIST"), 36);
    new DataView(extra.buffer).setUint32(40, 4, true);
    extra.set(plain.subarray(36), 48);
    expect(wavSeconds(extra)).toBeCloseTo(1, 5);
  });

  it("gives nothing for a file that is not a WAV", () => {
    expect(
      wavSeconds(new TextEncoder().encode("not a recording at all, just text that is long enough")),
    ).toBe(undefined);
  });
});

describe("shotsOf", () => {
  it("is one picture of everything for a scene with no marks", () => {
    expect(shotsOf(2, [], 4)).toEqual([{ step: 2, seconds: 4 }]);
  });

  it("brings in step N at mark N and shows every step in the last picture", () => {
    expect(shotsOf(3, [1, 2.5], 6)).toEqual([
      { step: 0, seconds: 1 },
      { step: 1, seconds: 1.5 },
      { step: 3, seconds: 3.5 },
    ]);
  });

  it("holds the whole scene when the marks are all that is said and a step has none", () => {
    expect(shotsOf(1, [2], 5)).toEqual([
      { step: 0, seconds: 2 },
      { step: 1, seconds: 3 },
    ]);
  });

  it("ignores marks past the end and marks beyond the steps", () => {
    expect(shotsOf(1, [1, 2, 99], 5)).toEqual([
      { step: 0, seconds: 1 },
      { step: 1, seconds: 4 },
    ]);
  });

  it("adds up to the length of the scene", () => {
    const total = shotsOf(4, [0.7, 1.9, 3.1, 4.4], 6.3).reduce((sum, shot) => sum + shot.seconds, 0);
    expect(total).toBeCloseTo(6.3, 9);
  });
});

describe("concatList", () => {
  it("names the last picture again after its duration, and quotes paths", () => {
    expect(
      concatList([
        { file: "C:\\tmp\\a b.png", seconds: 1.5 },
        { file: "/tmp/it's.png", seconds: 2 },
      ]),
    ).toBe(
      "file 'C:/tmp/a b.png'\nduration 1.500\nfile '/tmp/it'\\''s.png'\nduration 2.000\nfile '/tmp/it'\\''s.png'\n",
    );
  });
});

describe("shotsOf with captions", () => {
  const track = {
    edges: [0.5, 2, 3, 4.5],
    at: (time: number) => (time >= 0.5 && time < 2 ? "one" : time >= 3 && time < 4.5 ? "two" : undefined),
  };

  it("cuts where a caption comes and goes, and names the caption in each picture", () => {
    expect(shotsOf(0, [], 6, track)).toEqual([
      { step: 0, seconds: 0.5 },
      { step: 0, seconds: 1.5, caption: "one" },
      { step: 0, seconds: 1 },
      { step: 0, seconds: 1.5, caption: "two" },
      { step: 0, seconds: 1.5 },
    ]);
  });

  it("also cuts at the marks, and keeps one picture where nothing changes", () => {
    const shots = shotsOf(2, [1, 2.5], 6, track);
    expect(shots.map((shot) => [shot.step, shot.caption])).toEqual([
      [0, undefined],
      [0, "one"],
      [1, "one"],
      [1, undefined],
      [2, undefined],
      [2, "two"],
      [2, undefined],
    ]);
    expect(shots.reduce((sum, shot) => sum + shot.seconds, 0)).toBeCloseTo(6, 9);
  });

  it("is the same as no captions when the track says nothing", () => {
    expect(shotsOf(2, [1], 5, { edges: [], at: () => undefined })).toEqual(shotsOf(2, [1], 5));
  });
});
