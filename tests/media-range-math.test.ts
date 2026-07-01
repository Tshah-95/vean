// Pure frame-math for logged ranges — no DB, no spawn. Pins the rational
// frame-count derivation and the in/out clamp the media.log-range / media.label
// actions rely on. The DB writes + CLI surface are covered by cli-media-ranges.test.ts.
import { describe, expect, it } from "vitest";
import { assetFrameCount, clampRange } from "../src/state/media-range-math";

describe("assetFrameCount — rational frame count", () => {
  it("floors duration × fps, keeping fps rational (29.97 as 30000/1001)", () => {
    expect(assetFrameCount(10.01, 30000, 1001)).toBe(300); // 10.01 * 29.97 = 300.0
    expect(assetFrameCount(2, 25, 1)).toBe(50);
    expect(assetFrameCount(1.04, 24, 1)).toBe(24); // 24.96 floors to 24 — no partial frame
  });

  it("returns null when it can't be derived (unprobed, image, or fps-less audio)", () => {
    expect(assetFrameCount(null, 30, 1)).toBeNull(); // unprobed duration
    expect(assetFrameCount(42.5, null, null)).toBeNull(); // audio, no fps
    expect(assetFrameCount(10, 30, 0)).toBeNull(); // guard against /0
  });
});

describe("clampRange — order + bounds", () => {
  it("swaps an inverted range and leaves an in-bounds range untouched", () => {
    expect(clampRange(10, 20, 300)).toEqual({ in: 10, out: 20 });
    expect(clampRange(20, 10, 300)).toEqual({ in: 10, out: 20 }); // in>out swapped
  });

  it("clamps the out-point to the asset's last frame", () => {
    expect(clampRange(0, 999, 300)).toEqual({ in: 0, out: 299 }); // last = count-1
    expect(clampRange(290, 999, 300)).toEqual({ in: 290, out: 299 });
  });

  it("throws when the whole range starts past the last frame (a real mistake)", () => {
    expect(() => clampRange(400, 500, 300)).toThrow(/past the asset's last frame 299/);
  });

  it("accepts any non-negative range when the frame count is unknown", () => {
    expect(clampRange(0, 100, null)).toEqual({ in: 0, out: 100 });
    expect(clampRange(-5, 100, null)).toEqual({ in: 0, out: 100 }); // negative floored to 0
  });

  it("represents a marker as a zero-length range", () => {
    expect(clampRange(90, 90, 300)).toEqual({ in: 90, out: 90 });
  });
});
