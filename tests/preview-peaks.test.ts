// Pure unit tests for the audio-peaks binning + cache-key (DESIGN-UI Phase 3b).
// The ffmpeg-driven `extractPeaks` is exercised by the real preview-serve smoke
// probe (frame/media I/O is never in vitest); here we lock the PURE half:
//   • binPeaks — mono PCM → per-bucket [min,max] pairs, exact length, tiling.
//   • peaksCacheKey — content-addressed by (path, mtime, size, bins).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { binPeaks, peaksCacheKey } from "../src/preview/peaks";

describe("binPeaks", () => {
  it("emits exactly 2·bins values (a [min,max] pair per bucket)", () => {
    const samples = new Float32Array([0.1, -0.2, 0.5, -0.9, 0.3, 0.0]);
    for (const bins of [1, 2, 3, 6]) {
      expect(binPeaks(samples, bins).length).toBe(bins * 2);
    }
  });

  it("takes the min and max of each bucket's slice", () => {
    // Two buckets over 4 samples: [0.1,-0.2] and [0.5,-0.9]. (Float32 stores 0.1 as
    // ~0.10000000149, so compare with tolerance — the shape is min,max per bucket.)
    const out = binPeaks(new Float32Array([0.1, -0.2, 0.5, -0.9]), 2);
    expect(out[0]).toBeCloseTo(-0.2, 5); // bucket 0 min
    expect(out[1]).toBeCloseTo(0.1, 5); // bucket 0 max
    expect(out[2]).toBeCloseTo(-0.9, 5); // bucket 1 min
    expect(out[3]).toBeCloseTo(0.5, 5); // bucket 1 max
  });

  it("collapses the whole stream into one [min,max] at bins=1", () => {
    const out = binPeaks(new Float32Array([0.1, -0.7, 0.9, -0.3]), 1);
    expect(out[0]).toBeCloseTo(-0.7, 5);
    expect(out[1]).toBeCloseTo(0.9, 5);
  });

  it("tiles buckets across the full stream — the last bucket reaches the tail", () => {
    // 5 samples into 2 buckets: bucket 0 = [0,1], bucket 1 = [2,3,4]. The last
    // bucket must include sample index 4 (no truncation drift dropping the tail).
    const out = binPeaks(new Float32Array([0, 0, 0, 0, 1]), 2);
    // Bucket 1 spans samples 2..4, whose max is the 1 at index 4.
    expect(out[3]).toBe(1);
  });

  it("pads empty buckets with [0,0] when bins exceed samples (length still 2·bins)", () => {
    const out = binPeaks(new Float32Array([0.5]), 3);
    expect(out.length).toBe(6);
    // Exactly one bucket holds the single sample (fractional tiling puts it in the
    // last bucket, whose slice reaches samples.length); the other two are empty
    // [0,0] pairs — no faked amplitude where there is no sample.
    const pairs = [
      [out[0], out[1]],
      [out[2], out[3]],
      [out[4], out[5]],
    ];
    const nonEmpty = pairs.filter(([lo, hi]) => lo !== 0 || hi !== 0);
    expect(nonEmpty.length).toBe(1);
    expect(nonEmpty[0]?.[0]).toBeCloseTo(0.5, 5);
    expect(nonEmpty[0]?.[1]).toBeCloseTo(0.5, 5);
  });

  it("returns all-zero pairs for an empty sample stream", () => {
    expect(binPeaks(new Float32Array(0), 3)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("clamps bins to at least 1", () => {
    expect(binPeaks(new Float32Array([0.2, -0.4]), 0).length).toBe(2);
  });
});

describe("peaksCacheKey", () => {
  it("is stable for the same file + bins, and varies with the bin count", () => {
    const dir = mkdtempSync(join(tmpdir(), "vean-peaks-key-"));
    const file = join(dir, "a.wav");
    writeFileSync(file, "some bytes");
    const k1 = peaksCacheKey(file, 1000);
    const k2 = peaksCacheKey(file, 1000);
    const k3 = peaksCacheKey(file, 500);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toBeTruthy();
  });

  it("changes when the file content (size/mtime) changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "vean-peaks-key-"));
    const file = join(dir, "b.wav");
    writeFileSync(file, "short");
    const before = peaksCacheKey(file, 100);
    writeFileSync(file, "a much longer set of bytes than before");
    const after = peaksCacheKey(file, 100);
    expect(before).not.toBe(after);
  });

  it("returns null for a missing file (uncacheable → caller re-extracts)", () => {
    expect(peaksCacheKey(join(tmpdir(), "definitely-not-here.wav"), 100)).toBeNull();
  });
});
