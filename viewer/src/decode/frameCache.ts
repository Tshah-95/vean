// The DECODED-FRAME LRU + DECODE-AHEAD cache (DESIGN-LIVE-PREVIEW §5, §6 Tier 2a,
// §8.3, §9 step 5). Ported near-verbatim from OpenReel's
// `packages/core/src/video/frame-cache.ts` (LRU + preload-range), with vean's
// load-bearing identity and lifetime disciplines welded in.
//
// ── WHAT CHANGED FROM THE REFERENCE (and why) ────────────────────────────────
//  • KEY is `(producerUUID, INTEGER sourceFrame)` — NOT timeline-time and NOT a
//    rounded `media-time` float (OpenReel keyed by `mediaId:time.toFixed(4)`).
//    vean's invariant is frame-exact integer time, and decode identity is the
//    clip's stable producer UUID (§4 step 2), so the cache survives ripple/trim
//    edits that only reposition a clip — a moved clip resolves the SAME
//    `(uuid, sourceFrame)` and hits.
//  • BYTE-BOUNDED LRU with `close()` ON EVICT AND ON REPLACE. Forgetting
//    `ImageBitmap.close()` is the dominant failure mode (§8.3): every decoded
//    frame is GPU-resident and refcounted; an unclosed evict OOMs the GPU /
//    stalls the decoder within seconds of scrubbing. This cache OWNS the bitmaps
//    it holds and is the SINGLE place they are released.
//  • DECODE-AHEAD over integer source frames: `preloadFrames(currentFrame, ahead,
//    behind)` returns the missing `(uuid, sourceFrame)` set around the playhead so
//    the caller can warm the pool before the user scrubs there (the seek-lag
//    killer, §5). The reference's `getPreloadRange` did this in float media-time;
//    here it is exact integer frames.
//
// FRAMEWORK-AGNOSTIC: depends only on `ImageBitmap`. No React, no mediabunny, no
// DOM beyond the bitmap. Unit-testable in isolation (the byte accounting +
// eviction are pure given a fake closable bitmap).

import type { MediaResourceLedger } from "../test-bridge/resourceLedger";

/** A cached decoded footage frame. The cache owns `bitmap` until eviction. */
export interface CachedFrame {
  /** `${uuid}@${sourceFrame}` — the composite key (see {@link frameKey}). */
  key: string;
  /** The clip's stable producer UUID — the decode/seek identity (§4 step 2). */
  uuid: string;
  /** Integer SOURCE frame (NOT timeline frame; survives reposition edits). */
  sourceFrame: number;
  /** The decoded frame. GPU-resident, refcounted — `close()`d on evict/replace. */
  bitmap: ImageBitmap;
  /** `4 · w · h` bytes (RGBA) — the eviction accounting unit (§8.3). */
  bytes: number;
  /** Monotonic last-access tick for LRU ordering (a counter, not wall-clock, so
   *  ties never collide and a paused tab never skews recency). */
  lastUsed: number;
}

export interface FrameCacheConfig {
  /** Hard cap on total resident frame BYTES (§8.3 — bound by bytes, the GPU
   *  pressure is VRAM, not entry count). ~4·w·h per frame; 500MB holds a generous
   *  scrub window of 1080p frames. */
  maxSizeBytes: number;
  /** Frames to warm AHEAD of the playhead (decode-ahead; §5). */
  preloadAhead: number;
  /** Frames to keep BEHIND the playhead (for short back-scrubs). */
  preloadBehind: number;
}

export interface FrameCacheStats {
  entries: number;
  sizeBytes: number;
  maxSizeBytes: number;
  hits: number;
  misses: number;
  /** `hits / (hits+misses)` — 0 when no requests yet. */
  hitRate: number;
  /** Bitmaps explicitly `close()`d on evict/replace (the §8.3 health signal — a
   *  bounded scrub must show evicts ≈ inserts past the cap, never a leak). */
  evictions: number;
}

const DEFAULT_CONFIG: FrameCacheConfig = {
  maxSizeBytes: 500 * 1024 * 1024, // 500MB (§8.3)
  preloadAhead: 30, // ~1s at 30fps (OpenReel default)
  preloadBehind: 10,
};

/** The composite cache key for a decoded frame: the producer UUID + integer
 *  source frame. Exported so the caller (FootageStage) and the cache agree on the
 *  exact key, and so a decode-completion can address the frame it just produced. */
export function frameKey(uuid: string, sourceFrame: number): string {
  return `${uuid}@${sourceFrame}`;
}

export class FrameCache {
  private cache = new Map<string, CachedFrame>();
  private config: FrameCacheConfig;
  private totalBytes = 0;
  private tick = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private readonly ledger?: MediaResourceLedger;

  constructor(config: Partial<FrameCacheConfig> = {}, ledger?: MediaResourceLedger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ledger = ledger;
  }

  /** Look up the decoded frame for `(uuid, sourceFrame)`. Bumps recency on a hit.
   *  Returns the LIVE bitmap (the cache keeps owning it) or null on a miss. */
  get(uuid: string, sourceFrame: number): ImageBitmap | null {
    const entry = this.cache.get(frameKey(uuid, sourceFrame));
    if (entry) {
      entry.lastUsed = ++this.tick;
      this.hits++;
      return entry.bitmap;
    }
    this.misses++;
    return null;
  }

  /** Is `(uuid, sourceFrame)` resident? (No recency bump — used by decode-ahead to
   *  compute the missing set without disturbing LRU order.) */
  has(uuid: string, sourceFrame: number): boolean {
    return this.cache.has(frameKey(uuid, sourceFrame));
  }

  /**
   * The decoded frame for `uuid` whose source frame is CLOSEST to `sourceFrame`,
   * within `maxDistance` frames — or null if nothing for this clip is that close.
   * This is the PLAYBACK HOLD lever: during real-time multi-source playback the
   * decode pool can lag a layer's exact frame, and dropping that layer (showing the
   * layer below / black through it) makes the composite FLICKER between subsets of
   * the z-stack. Holding the nearest already-decoded frame for the clip instead
   * keeps every covering layer on screen (a few frames stale at worst, replaced the
   * instant the exact frame lands) — stable beats frame-exact for a moving playhead.
   * Bumps recency (the held frame is in active use). O(resident frames), and the
   * cache is byte-bounded (~tens of 1080p frames), so this is cheap per composite.
   */
  getNearest(uuid: string, sourceFrame: number, maxDistance: number): ImageBitmap | null {
    let best: CachedFrame | null = null;
    let bestDist = maxDistance + 1;
    for (const e of this.cache.values()) {
      if (e.uuid !== uuid) continue;
      const dist = Math.abs(e.sourceFrame - sourceFrame);
      if (dist < bestDist) {
        bestDist = dist;
        best = e;
        if (dist === 0) break;
      }
    }
    if (!best) return null;
    best.lastUsed = ++this.tick;
    return best.bitmap;
  }

  /**
   * Insert (or replace) the decoded frame for `(uuid, sourceFrame)`. The cache
   * TAKES OWNERSHIP of `bitmap` and is responsible for `close()`ing it on evict or
   * replace (§8.3). Inserting evicts the least-recently-used frames until the new
   * frame fits the byte budget.
   *
   * If a frame already exists at this key (a re-decode of the same source frame),
   * the OLD bitmap is `close()`d before the new one is stored — close-on-replace,
   * the other half of the §8.3 discipline.
   */
  set(uuid: string, sourceFrame: number, bitmap: ImageBitmap): void {
    const key = frameKey(uuid, sourceFrame);
    const bytes = bitmap.width * bitmap.height * 4;

    const existing = this.cache.get(key);
    if (existing) {
      existing.bitmap.close(); // close-on-replace (§8.3)
      this.ledger?.close("image-bitmap", existing.key);
      this.totalBytes -= existing.bytes;
      this.cache.delete(key);
    }

    // A single frame larger than the whole budget can't be cached — close it
    // immediately so we never leak it, and skip insertion (the caller already drew
    // it; the next pull re-decodes). Defensive: with a sane budget this never hits.
    if (bytes > this.config.maxSizeBytes) {
      bitmap.close();
      return;
    }

    this.evictTo(this.config.maxSizeBytes - bytes);

    this.cache.set(key, {
      key,
      uuid,
      sourceFrame,
      bitmap,
      bytes,
      lastUsed: ++this.tick,
    });
    this.ledger?.open("image-bitmap", key);
    this.totalBytes += bytes;
  }

  /** Drop + `close()` one frame (e.g. a clip removed from the timeline). */
  delete(uuid: string, sourceFrame: number): void {
    this.deleteKey(frameKey(uuid, sourceFrame));
  }

  /** Drop + `close()` every cached frame for a clip (its decode resources were
   *  released, so its bitmaps are dead). */
  clearClip(uuid: string): void {
    const dead: string[] = [];
    for (const [key, e] of this.cache) if (e.uuid === uuid) dead.push(key);
    for (const key of dead) this.deleteKey(key);
  }

  /** Release EVERY frame (on unmount / project switch). The single teardown path —
   *  after this the cache holds no GPU memory. */
  clear(): void {
    for (const e of this.cache.values()) {
      e.bitmap.close();
      this.ledger?.close("image-bitmap", e.key);
    }
    this.cache.clear();
    this.totalBytes = 0;
  }

  /**
   * Decode-ahead (§5): the set of `(uuid, sourceFrame)` around `currentFrame` that
   * is NOT yet resident, for ONE clip whose source spans `[inFrame, outFrame]`.
   * `currentSourceFrame` is the source frame live at the playhead; the window is
   * `[−preloadBehind, +preloadAhead]` clamped to the clip's source range. The
   * caller feeds these to the decoder pool (priority by distance to the playhead),
   * with a generation/abort so a fresh seek cancels stale preload work.
   *
   * Integer-frame throughout (vean's invariant) — no float media-time rounding.
   */
  missingPreloadFrames(
    uuid: string,
    currentSourceFrame: number,
    inFrame: number,
    outFrame: number,
  ): number[] {
    const start = Math.max(inFrame, currentSourceFrame - this.config.preloadBehind);
    const end = Math.min(outFrame, currentSourceFrame + this.config.preloadAhead);
    const missing: number[] = [];
    // Emit nearest-first (the playhead frame, then alternating ahead/behind) so the
    // caller can prioritize by queue order: the frames the user is about to reach
    // decode before the ones they just left.
    for (let d = 0; start + d <= end || currentSourceFrame - d >= start; d++) {
      const ahead = currentSourceFrame + d;
      if (ahead <= end && !this.has(uuid, ahead)) missing.push(ahead);
      if (d > 0) {
        const behind = currentSourceFrame - d;
        if (behind >= start && !this.has(uuid, behind)) missing.push(behind);
      }
      // Bound the loop: once both directions are exhausted, stop.
      if (currentSourceFrame + d > end && currentSourceFrame - d < start) break;
    }
    return missing;
  }

  getStats(): FrameCacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      sizeBytes: this.totalBytes,
      maxSizeBytes: this.config.maxSizeBytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      evictions: this.evictions,
    };
  }

  /** Live resident byte count — for the perf gate's bounded-memory assertion. */
  get sizeBytes(): number {
    return this.totalBytes;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private deleteKey(key: string): void {
    const e = this.cache.get(key);
    if (!e) return;
    e.bitmap.close(); // THE load-bearing release (§8.3)
    this.ledger?.close("image-bitmap", e.key);
    this.totalBytes -= e.bytes;
    this.cache.delete(key);
  }

  /** Evict least-recently-used frames until `totalBytes <= budget`. Each eviction
   *  `close()`s the bitmap (§8.3) and bumps the eviction counter (the leak signal).
   *  Single-pass sort: cheap relative to a decode, and eviction is bursty (a scrub
   *  past the cap), not per-frame steady-state. */
  private evictTo(budget: number): void {
    if (this.totalBytes <= budget) return;
    const byAge = [...this.cache.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of byAge) {
      if (this.totalBytes <= budget) break;
      e.bitmap.close();
      this.ledger?.close("image-bitmap", e.key);
      this.totalBytes -= e.bytes;
      this.cache.delete(e.key);
      this.evictions++;
    }
  }
}
