// inspect-timeline (Stream S3 / roadmap a.4) — the still-strip frame-sampling
// logic. The actual melt grabs are verified by render gates (never in vitest); here
// we lock the PURE `sampleFrames` math: even spacing, endpoint inclusion, the cap,
// and the de-dupe that stops a tiny range asking melt for the same frame twice.
import { describe, expect, it } from "vitest";
import { sampleFrames } from "../src/bridge/tools/read";

describe("sampleFrames (inspect-timeline still-strip)", () => {
  it("includes both endpoints and spreads the interior evenly", () => {
    // [0, 100], 5 samples → 0, 25, 50, 75, 100.
    expect(sampleFrames(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
  });

  it("rounds interior samples to exact integer frames (no floats)", () => {
    // [0, 10], 4 samples → 0, 3.33→3, 6.67→7, 10.
    const frames = sampleFrames(0, 10, 4);
    expect(frames).toEqual([0, 3, 7, 10]);
    for (const f of frames) expect(Number.isInteger(f)).toBe(true);
  });

  it("caps at maxFrames", () => {
    expect(sampleFrames(0, 1000, 3)).toEqual([0, 500, 1000]);
    expect(sampleFrames(0, 1000, 3)).toHaveLength(3);
  });

  it("never asks for more samples than there are distinct frames", () => {
    // A 3-frame range can yield at most 3 distinct frames even if maxFrames is 10.
    expect(sampleFrames(10, 12, 10)).toEqual([10, 11, 12]);
  });

  it("yields a single frame for a 1-frame range or maxFrames=1", () => {
    expect(sampleFrames(42, 42, 8)).toEqual([42]);
    expect(sampleFrames(0, 100, 1)).toEqual([0]);
  });

  it("de-dupes and sorts when rounding collides on a small range", () => {
    // [5, 6], 5 samples → would round to 5,5,6,6,6 → de-duped to [5, 6].
    expect(sampleFrames(5, 6, 5)).toEqual([5, 6]);
  });

  it("normalizes a reversed range (start > end) to ascending", () => {
    expect(sampleFrames(100, 0, 3)).toEqual([0, 50, 100]);
  });

  it("is monotonically non-decreasing for any valid request", () => {
    for (const [s, e, n] of [
      [0, 60, 4],
      [12, 240, 7],
      [3, 3, 5],
      [0, 1, 9],
    ] as const) {
      const frames = sampleFrames(s, e, n);
      for (let i = 1; i < frames.length; i++) {
        expect(frames[i]).toBeGreaterThan(frames[i - 1] as number);
      }
    }
  });
});
