// Pure frame math for logged ranges — no DB, no bun:sqlite, so it unit-tests in
// vitest directly (mirrors the driver/probe pure-projection split). The DB writes
// that consume these live in media-ranges.ts. Frames are integers in the asset's
// OWN rational fps, never seconds — per the frame-exact invariant.

/** Probed frame count in the asset's own rational fps, or null when underivable
 *  (unprobed, still image, or fps-less audio). floor — a partial trailing frame
 *  is not addressable. */
export function assetFrameCount(
  durationSec: number | null,
  fpsNum: number | null,
  fpsDen: number | null,
): number | null {
  if (durationSec == null || fpsNum == null || !fpsDen) return null;
  return Math.max(0, Math.floor((durationSec * fpsNum) / fpsDen));
}

/** Order + clamp a requested [in,out] to the asset's bounds. `in>out` is swapped.
 *  With a known `frameCount`, both ends clamp to [0, frameCount-1] and a range that
 *  starts entirely past the last frame throws (a genuine mistake, not clampable).
 *  `frameCount` null (unprobed / image / fps-less audio) = accept as given (floor 0). */
export function clampRange(
  inFrame: number,
  outFrame: number,
  frameCount: number | null,
): { in: number; out: number } {
  let lo = Math.min(inFrame, outFrame);
  let hi = Math.max(inFrame, outFrame);
  if (frameCount != null && frameCount > 0) {
    const last = frameCount - 1;
    if (lo > last) throw new Error(`in-point ${lo} is past the asset's last frame ${last}`);
    lo = Math.max(0, Math.min(lo, last));
    hi = Math.max(lo, Math.min(hi, last));
  } else {
    lo = Math.max(0, lo);
    hi = Math.max(lo, hi);
  }
  return { in: lo, out: hi };
}
