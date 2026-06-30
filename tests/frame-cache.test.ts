import { describe, expect, it } from "vitest";
// The decoded-frame LRU + decode-ahead cache (DESIGN-LIVE-PREVIEW §5, §6 Tier 2a,
// §8.3, §9 step 5). Ported from OpenReel's `frame-cache.ts` with vean's identity
// (`(producerUUID, INTEGER sourceFrame)`) and the load-bearing §8.3 lifetime
// discipline: every evicted/replaced bitmap is `close()`d. That discipline is the
// dominant OOM failure mode for the live decode path, so it is GOLDEN-TESTED here
// against a fake closable bitmap — the same way resolveLayers is unit-gated. The
// module is pure ESM (imports only `ImageBitmap`), so vitest exercises it directly
// even though the viewer is otherwise a separate Vite app.
import { FrameCache, frameKey } from "../viewer/src/decode/frameCache";

/** A fake `ImageBitmap` that records whether `close()` was called and counts as
 *  `4·w·h` bytes — exactly what the cache's byte accounting assumes (§8.3). */
function fakeBitmap(width = 100, height = 100): ImageBitmap & { closed: boolean } {
  const bmp = {
    width,
    height,
    closed: false,
    close() {
      bmp.closed = true;
    },
  };
  return bmp as unknown as ImageBitmap & { closed: boolean };
}

const bytesOf = (w: number, h: number) => w * h * 4;

describe("FrameCache — identity + hit/miss", () => {
  it("keys by (uuid, sourceFrame), survives reposition (same key hits)", () => {
    const c = new FrameCache();
    const b = fakeBitmap();
    c.set("uuidA", 42, b);
    // A ripple/trim that only MOVES the clip resolves the same (uuid, sourceFrame),
    // so the decoded frame is reused — the whole point of the source-identity key.
    expect(c.get("uuidA", 42)).toBe(b);
    expect(c.has("uuidA", 42)).toBe(true);
    expect(c.get("uuidA", 99)).toBeNull(); // a different source frame misses
    expect(frameKey("uuidA", 42)).toBe("uuidA@42");
  });

  it("tracks hitRate over get() calls", () => {
    const c = new FrameCache();
    c.set("u", 0, fakeBitmap());
    c.get("u", 0); // hit
    c.get("u", 1); // miss
    c.get("u", 0); // hit
    const s = c.getStats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(2 / 3, 5);
  });
});

describe("FrameCache — §8.3 lifetime: close() on evict + replace", () => {
  it("byte-bounded eviction close()s the least-recently-used bitmap", () => {
    // Budget holds exactly TWO 100×100 frames (40000 B each = 80000 B).
    const c = new FrameCache({ maxSizeBytes: 2 * bytesOf(100, 100) });
    const b0 = fakeBitmap();
    const b1 = fakeBitmap();
    const b2 = fakeBitmap();
    c.set("u", 0, b0);
    c.set("u", 1, b1);
    // Touch frame 0 so frame 1 becomes the LRU victim.
    c.get("u", 0);
    c.set("u", 2, b2); // over budget → evict the LRU (frame 1)

    expect(b1.closed).toBe(true); // THE load-bearing release (§8.3)
    expect(b0.closed).toBe(false);
    expect(b2.closed).toBe(false);
    expect(c.has("u", 1)).toBe(false);
    expect(c.has("u", 0)).toBe(true);
    expect(c.has("u", 2)).toBe(true);
    expect(c.sizeBytes).toBe(2 * bytesOf(100, 100));
    expect(c.getStats().evictions).toBe(1);
  });

  it("replacing a key close()s the OLD bitmap (close-on-replace)", () => {
    const c = new FrameCache();
    const oldB = fakeBitmap();
    const newB = fakeBitmap();
    c.set("u", 5, oldB);
    c.set("u", 5, newB); // re-decode of the same source frame
    expect(oldB.closed).toBe(true);
    expect(newB.closed).toBe(false);
    expect(c.get("u", 5)).toBe(newB);
    // Bytes accounted exactly once (no double-count of the replaced frame).
    expect(c.sizeBytes).toBe(bytesOf(100, 100));
  });

  it("clear() close()s every resident bitmap and zeroes bytes", () => {
    const c = new FrameCache();
    const bs = [fakeBitmap(), fakeBitmap(), fakeBitmap()];
    bs.forEach((b, i) => c.set("u", i, b));
    c.clear();
    expect(bs.every((b) => (b as unknown as { closed: boolean }).closed)).toBe(true);
    expect(c.sizeBytes).toBe(0);
  });

  it("clearClip() close()s only that clip's frames", () => {
    const c = new FrameCache();
    const a = fakeBitmap();
    const b = fakeBitmap();
    c.set("clipA", 0, a);
    c.set("clipB", 0, b);
    c.clearClip("clipA");
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(c.has("clipA", 0)).toBe(false);
    expect(c.has("clipB", 0)).toBe(true);
  });

  it("delete() close()s a single frame", () => {
    const c = new FrameCache();
    const b = fakeBitmap();
    c.set("u", 7, b);
    c.delete("u", 7);
    expect(b.closed).toBe(true);
    expect(c.has("u", 7)).toBe(false);
    expect(c.sizeBytes).toBe(0);
  });

  it("a single frame larger than the whole budget is close()d, never leaked", () => {
    const c = new FrameCache({ maxSizeBytes: 1000 });
    const huge = fakeBitmap(100, 100); // 40000 B > budget
    c.set("u", 0, huge);
    expect(huge.closed).toBe(true); // closed immediately, not leaked
    expect(c.has("u", 0)).toBe(false);
    expect(c.sizeBytes).toBe(0);
  });

  it("bounded memory across a long scrub: never exceeds the byte budget", () => {
    // The §6 Tier-2 memory gate, in miniature: decode 200 distinct frames into a
    // cap that holds ~10, and assert resident bytes stay bounded and evictions
    // exactly account for the overflow (no leak).
    const cap = 10 * bytesOf(100, 100);
    const c = new FrameCache({ maxSizeBytes: cap });
    const bitmaps: Array<ImageBitmap & { closed: boolean }> = [];
    for (let f = 0; f < 200; f++) {
      const b = fakeBitmap();
      bitmaps.push(b);
      c.set("u", f, b);
      expect(c.sizeBytes).toBeLessThanOrEqual(cap); // bounded at every step
    }
    expect(c.getStats().entries).toBe(10);
    // 200 inserted, 10 resident → 190 evicted, all close()d.
    expect(c.getStats().evictions).toBe(190);
    const closedCount = bitmaps.filter((b) => b.closed).length;
    expect(closedCount).toBe(190);
  });
});

describe("FrameCache — decode-ahead missing-set (§5)", () => {
  it("returns the missing source frames around the playhead, nearest-first", () => {
    const c = new FrameCache({ maxSizeBytes: 1 << 30, preloadAhead: 3, preloadBehind: 2 });
    // Window around source frame 10 over a clip spanning [0, 100]:
    //   behind 2 .. ahead 3  → {8,9,10,11,12,13}
    const missing = c.missingPreloadFrames("u", 10, 0, 100);
    expect(new Set(missing)).toEqual(new Set([8, 9, 10, 11, 12, 13]));
    // Nearest-first: the playhead frame (10) is first.
    expect(missing[0]).toBe(10);
  });

  it("excludes already-cached frames from the missing set", () => {
    const c = new FrameCache({ maxSizeBytes: 1 << 30, preloadAhead: 3, preloadBehind: 2 });
    c.set("u", 11, fakeBitmap());
    c.set("u", 9, fakeBitmap());
    const missing = c.missingPreloadFrames("u", 10, 0, 100);
    expect(missing).not.toContain(11);
    expect(missing).not.toContain(9);
    expect(new Set(missing)).toEqual(new Set([8, 10, 12, 13]));
  });

  it("clamps the window to the clip's source range [in, out]", () => {
    const c = new FrameCache({ maxSizeBytes: 1 << 30, preloadAhead: 5, preloadBehind: 5 });
    // At source frame 2 over a clip spanning only [0, 4]: no negatives, no >4.
    const missing = c.missingPreloadFrames("u", 2, 0, 4);
    expect(new Set(missing)).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(missing.every((f) => f >= 0 && f <= 4)).toBe(true);
  });
});

describe("FrameCache — getNearest (the playback HOLD primitive)", () => {
  it("returns the closest decoded frame for the clip within maxDistance", () => {
    const c = new FrameCache();
    const b18 = fakeBitmap();
    const b25 = fakeBitmap();
    c.set("u", 18, b18);
    c.set("u", 25, b25);
    // Exact frame 22 is not resident; 25 is dist 3, 18 is dist 4 — so 25 wins.
    expect(c.getNearest("u", 22, 90)).toBe(b25);
    // Frame 20: 18 (dist 2) beats 25 (dist 5).
    expect(c.getNearest("u", 20, 90)).toBe(b18);
    // An exact hit returns itself (dist 0 short-circuits).
    expect(c.getNearest("u", 18, 90)).toBe(b18);
  });

  it("respects maxDistance and clip identity (no cross-clip hold, no over-stale hold)", () => {
    const c = new FrameCache();
    c.set("u", 10, fakeBitmap());
    c.set("other", 50, fakeBitmap());
    // The only "u" frame is at 10 (dist 40 from 50) — beyond maxDistance 30 → no hold.
    expect(c.getNearest("u", 50, 30)).toBeNull();
    // Within maxDistance it holds.
    expect(c.getNearest("u", 50, 50)).not.toBeNull();
    // Never returns ANOTHER clip's frame, and a clip with nothing decoded holds null.
    expect(c.getNearest("missing", 50, 90)).toBeNull();
  });
});
