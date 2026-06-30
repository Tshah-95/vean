// The RESOLVE-VISIBLE-SET walk — the read-side mirror of the serializer's track
// walk (`src/ir/serialize.ts:walkTrack`), but EVALUATED AT A FRAME instead of
// emitted as XML (DESIGN-LIVE-PREVIEW.md §4 step 1, §6 Tier 0).
//
// This is the heart of Tier 0 liveness: given the in-memory working IR and an
// integer playhead frame, it answers "which source clip is live at this frame, and
// at what SOURCE frame?" — the question the proxy-render round-trip used to answer
// by re-rendering the whole timeline through `melt`. Here it is a pure function of
// `(timeline, frame)`, so an edit (which mutates the IR) immediately changes the
// answer with NO save, NO file round-trip — that IS the liveness.
//
// FRAME-EXACT INTEGER MATH (vean's load-bearing invariant): timeline positions and
// source in/out are integer frames throughout; we never coerce a float fps. The
// only frames→seconds conversion happens at the decode boundary in the caller
// (`FootageStage`), via the exact rational `frame * fps[1] / fps[0]` the clock
// already uses (`clock.ts:secondsForFrame`).
//
// TIER-0 SCOPE (deliberately the cheapest real win): single-clip-at-a-time footage,
// cuts, trims, ripple, track layout. Multi-track OVERLAP compositing and the real
// crossfade through a transition are Tier 1 (the WebGL `renderFrame` compositor).
// Until then, the TOPMOST covering footage clip wins (higher video-track index =
// higher z, the live equivalent of `qtblend`'s over-composite). Graphic (Remotion)
// clips are skipped here — they are drawn by the `@remotion/player` overlay ON TOP
// of the footage, exactly as today (`OverlayPlayer.tsx`).
import { type Item, type Timeline, isGraphicClip, placeItems } from "./types";

/** The footage clip that is LIVE at the resolved frame, with its source frame. */
export interface VisibleClip {
  /** The clip's stable producer uuid — the decode/seek identity (NOT the timeline
   *  index), so the resolved source survives ripple/trim edits that only move the
   *  clip on the timeline (DESIGN §4 step 2). */
  uuid: string;
  /** The clip's source `resource` (absolute path the `<video>`/decoder points at). */
  resource: string;
  /** The SOURCE frame to seek to = `clip.in + (frame - clipStart)`, clamped to the
   *  clip's `[in, out]` window. Integer. */
  sourceFrame: number;
  /** The 0-based `tracks.video` index this clip lives on (its z-order). */
  trackIndex: number;
  /** The clip's source `[in, out]` window (for clamping / diagnostics). */
  in: number;
  out: number;
}

/** Is this a footage clip (a decodable source), as opposed to a blank, dissolve,
 *  or Remotion graphic overlay? Graphics are drawn by the overlay Player, not the
 *  footage stage, so they are NOT part of the footage visible set. */
function isFootageClip(item: Item): boolean {
  return item.kind === "clip" && !isGraphicClip(item);
}

/**
 * Resolve which FOOTAGE clip covers integer `frame` on `trackIndex` (a 0-based
 * `tracks.video` index), and at what source frame. Returns `null` when the frame
 * falls on a blank, a graphic clip, a dissolve gap, or past the track's end.
 *
 * Mirrors `placeItems` (the same cursor walk the strip + serializer use), so the
 * timeline-frame placement is byte-identical to what `melt` would render. A
 * dissolve item occupies `frames` timeline frames; in Tier 0 we treat that region
 * as covered by NEITHER solo clip (the real crossfade is Tier 1) — the playhead
 * inside a dissolve shows whichever clip the topmost track resolves, falling back
 * to the next track down.
 */
export function resolveVisibleOnTrack(
  timeline: Timeline,
  trackIndex: number,
  frame: number,
): VisibleClip | null {
  const track = timeline.tracks.video[trackIndex];
  if (!track || track.hidden) return null;
  for (const placed of placeItems(track)) {
    const { item, start, length } = placed;
    // `frame` is inside this item iff start <= frame < start + length.
    if (frame < start || frame >= start + length) continue;
    if (!isFootageClip(item) || item.kind !== "clip") return null; // blank/dissolve/graphic
    // Source frame = the clip's in-point plus how far into the clip we are.
    const offset = frame - start;
    const sourceFrame = Math.min(item.out, Math.max(item.in, item.in + offset));
    return {
      uuid: item.id,
      resource: item.resource,
      sourceFrame,
      trackIndex,
      in: item.in,
      out: item.out,
    };
  }
  return null;
}

/**
 * Resolve the SINGLE footage clip that wins at integer `frame` across all video
 * tracks: the TOPMOST (highest track index) track that has a footage clip covering
 * the frame (Tier 0's "topmost covering clip wins"). Returns `null` when no track
 * has footage at the frame (e.g. the playhead sits over only a color background, a
 * blank, or graphic-only tracks — the footage stage then shows nothing and the
 * overlay/background fills the box).
 *
 * This is the read-side projection the footage `<video>` is slaved to. Identity is
 * the clip's stable uuid, so two frames that resolve to the same clip reuse the
 * same pooled `<video>` (only `currentTime` moves).
 */
export function resolveVisibleSet(timeline: Timeline, frame: number): VisibleClip | null {
  // Walk video tracks from the TOP down so the first hit is the highest z.
  for (let i = timeline.tracks.video.length - 1; i >= 0; i--) {
    const hit = resolveVisibleOnTrack(timeline, i, frame);
    if (hit) return hit;
  }
  return null;
}
