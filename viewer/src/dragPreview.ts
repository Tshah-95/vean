// The DRAG PREVIEW builder — turns a live timeline gesture into a transient
// "override" the footage compositor draws INSTEAD of the committed frame, so the
// program monitor reacts to a drag/trim before it commits (the pro-NLE affordance:
// trim shows the new in/out frame; a move shows the clip landed at the drop spot).
//
// WHY A SYNTHETIC TOP TRACK (not an in-place IR edit): vean's IR is sequential
// items+blanks per track — overlaps aren't representable, so previewing a move onto
// occupied space or an extend-trim past a neighbour would need the real overwrite
// algebra (and could corrupt the committed track's blank/dissolve structure). We
// instead leave the committed IR untouched and APPEND ONE topmost video track
// carrying just the dragged clip at its previewed placement + adjusted source
// window. resolveLayers then composites it ON TOP at the chosen preview frame,
// reusing the whole decode/cache path (same clip uuid → frames are already warm).
// Appending at the end keeps every existing `qtblend` transition's track index
// valid (they reference `tracks.video` by position), and the audio path is never
// touched (it reads the committed IR).
//
// FRAME-EXACT INTEGER MATH: every in/out/start/frame is an integer frame; the
// synthetic clip's on-timeline length is `out - in + 1`, exactly what
// resolveLayerOnTrack derives — so the previewed frame resolves to the source frame
// this builder intends. Returns null for a no-op (dx 0), a non-clip/graphic drag
// (graphics are the @remotion/player overlay, not footage), or a degenerate window.
import type { Gesture } from "./timelineGestures";
import { type ClipItem, type Item, type Timeline, type Track, isGraphicClip } from "./types";

/** The transient compositor override for an in-flight gesture: draw `timeline`
 *  (the committed IR + a synthetic preview track) at `frame` instead of the live
 *  playhead frame, until the gesture commits or aborts. */
export interface PreviewOverride {
  timeline: Timeline;
  /** The integer timeline frame the compositor should resolve + show. */
  frame: number;
}

/** The synthetic top track's id — never collides with a real MLT track id. */
export const PREVIEW_TRACK_ID = "__vean_drag_preview__";

/** The previewed placement + source window of the clip to draw on top, plus the
 *  frame to show. `null` fields when a tool has nothing to preview. */
interface Overlay {
  item: ClipItem;
  /** Absolute timeline start of the clip on the synthetic track. */
  start: number;
  /** The frame to composite (always within `[start, start + len)`). */
  frame: number;
}

/** Resolve the overlay clip (previewed source window + placement) for a gesture at
 *  the committed integer frame delta. Mirrors the sign conventions in
 *  `buildInvocation` so the preview matches what will commit. */
function overlayFor(gesture: Gesture, dxFrames: number): Overlay | null {
  const base = gesture.placed;
  if (base.item.kind !== "clip") return null;
  const clip = base.item;

  switch (gesture.tool) {
    case "move":
    case "slide": {
      // The clip keeps its source window; only its position moves.
      const start = Math.max(0, base.start + dxFrames);
      return { item: clip, start, frame: start };
    }
    case "trimIn": {
      // +dx trims the head (later start + later in-point); −dx extends it earlier.
      const newIn = Math.max(0, clip.in + dxFrames);
      if (newIn > clip.out) return null; // trimmed past the tail — nothing to show
      const start = Math.max(0, base.start + (newIn - clip.in));
      // frame = the new head → source frame resolves to `newIn` (the new in-frame).
      return { item: { ...clip, in: newIn }, start, frame: start };
    }
    case "trimOut": {
      // +dx extends the tail (later out-point); −dx shortens it.
      const newOut = Math.max(clip.in, clip.out + dxFrames);
      const start = base.start;
      // frame = the new tail (last covered) → source frame resolves to `newOut`.
      return { item: { ...clip, out: newOut }, start, frame: start + (newOut - clip.in) };
    }
    case "slip": {
      // slip delta = −dxFrames (drag left → reveal later source). The window shifts;
      // the placement is unchanged. Show the head → the new (slipped) in-frame.
      const newIn = Math.max(0, clip.in - dxFrames);
      const newOut = clip.out + (newIn - clip.in); // conserve length
      if (newOut < newIn) return null;
      return { item: { ...clip, in: newIn, out: newOut }, start: base.start, frame: base.start };
    }
    case "roll": {
      // Rolling the shared cut (+dx slides the seam later): show the INCOMING
      // (right) clip's new head at the moved cut — the frame you're cutting to.
      const right = gesture.neighbours.right;
      if (right?.item.kind === "clip") {
        const rc = right.item;
        const newIn = Math.max(0, rc.in + dxFrames);
        if (newIn > rc.out) return null;
        const start = Math.max(0, right.start + (newIn - rc.in));
        return { item: { ...rc, in: newIn }, start, frame: start };
      }
      // Left-only seam (no right neighbour): show the outgoing clip's new tail.
      const left = gesture.neighbours.left;
      if (left?.item.kind === "clip") {
        const lc = left.item;
        const newOut = Math.max(lc.in, lc.out + dxFrames);
        return {
          item: { ...lc, out: newOut },
          start: left.start,
          frame: left.start + (newOut - lc.in),
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Build the transient compositor override for a live gesture, or `null` when there
 * is nothing to preview (a zero-frame delta, a non-clip/graphic drag, or a
 * degenerate window). The returned timeline is the committed IR with ONE extra
 * topmost video track holding the dragged clip at its previewed placement; the
 * compositor resolves `frame` against it and draws that clip over the rest.
 */
export function buildDragPreview(
  timeline: Timeline,
  gesture: Gesture,
  dxFrames: number,
): PreviewOverride | null {
  if (dxFrames === 0) return null;
  if (gesture.placed.item.kind !== "clip") return null;
  // Graphic (Remotion) clips are drawn by the @remotion/player overlay, not the
  // footage stage — decoding their cache resource here would just fail. Let the
  // strip's ghost carry those; the footage preview stays silent.
  if (isGraphicClip(gesture.placed.item)) return null;

  const overlay = overlayFor(gesture, dxFrames);
  if (!overlay) return null;

  const items: Item[] =
    overlay.start > 0 ? [{ kind: "blank", length: overlay.start }, overlay.item] : [overlay.item];
  const previewTrack: Track = { kind: "video", id: PREVIEW_TRACK_ID, name: "preview", items };

  return {
    frame: Math.max(0, overlay.frame),
    timeline: {
      ...timeline,
      tracks: { ...timeline.tracks, video: [...timeline.tracks.video, previewTrack] },
    },
  };
}
