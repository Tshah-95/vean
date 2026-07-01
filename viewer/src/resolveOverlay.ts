// PLAYHEAD-AWARE overlay resolution (P1). The live `@remotion/player` overlay must
// render the graphic clip ACTIVE at the current frame — so a timeline with several
// graphic clips (different comps, or the same comp at different times) previews the
// RIGHT one as the playhead moves, and each comp plays from its OWN frame 0 (the clip
// start offset), only during its span. This replaces the earlier "first graphic clip,
// always shown, comp-frame == master-frame" behaviour, which was correct only for a
// single overlay starting at frame 0.
//
// Pure over the (working) IR + a frame — unit-testable, and cheap enough to run per
// frame (a timeline has a handful of clips). Returns the clip's OWN `props` reference
// (stable across frames within a span) so the Player's `inputProps` stay memoized.
import { type Timeline, isGraphicClip, placeItems } from "./types";

export interface ActiveOverlay {
  /** Whether a graphic overlay covers the current frame (mount/show the Player). */
  present: boolean;
  /** The composition id the active clip names (undefined → the default composition). */
  compositionId: string | undefined;
  /** The active clip's composition props (stable ref within a span). */
  props: Record<string, unknown> | undefined;
  /** The active clip's timeline start — the comp-frame offset (comp frame =
   *  masterFrame − startFrame), so the comp animates from its own 0 when it enters. */
  startFrame: number;
  /** The active clip's placed length — the comp's `durationInFrames` window. */
  duration: number;
}

export const NO_OVERLAY: ActiveOverlay = {
  present: false,
  compositionId: undefined,
  props: undefined,
  startFrame: 0,
  duration: 0,
};

/** True iff the timeline has ANY graphic (Remotion) overlay clip — used to decide
 *  whether to MOUNT the overlay layer at all. The layer stays mounted across spans
 *  (per-frame visibility is `resolveOverlayAt().present`), so crossing a gap doesn't
 *  remount the Player — only a comp *change* does. */
export function hasGraphicOverlay(timeline: Timeline): boolean {
  for (const track of timeline.tracks.video) {
    for (const item of track.items) {
      if (item.kind === "clip" && isGraphicClip(item)) return true;
    }
  }
  return false;
}

/** The graphic overlay active at `frame`: the graphic clip whose placed span
 *  [start, start+length) contains `frame`. Upper video tracks win (walked in reverse,
 *  so a V2 overlay sits above V1). `NO_OVERLAY` when no graphic clip covers the frame. */
export function resolveOverlayAt(timeline: Timeline, frame: number): ActiveOverlay {
  for (let t = timeline.tracks.video.length - 1; t >= 0; t--) {
    const track = timeline.tracks.video[t];
    if (!track) continue;
    for (const placed of placeItems(track)) {
      const item = placed.item;
      if (item.kind !== "clip" || !isGraphicClip(item)) continue;
      if (frame >= placed.start && frame < placed.start + placed.length) {
        return {
          present: true,
          compositionId: item.composition?.id,
          props: item.composition?.props,
          startFrame: placed.start,
          duration: placed.length,
        };
      }
    }
  }
  return NO_OVERLAY;
}
