// The contextual-gesture model: infer the EDIT TOOL from WHERE you grab a clip and
// which modifiers are held — no tool palette (Premiere/Resolve style). Pure
// functions + small types so TimelineStrip stays about pointer plumbing and this
// owns the "zone × modifier → tool → op" mapping.
//
// Zones (in clip-local px, where the clip spans [0, widthPx)):
//   • within the edge zone of the left edge  → trim the clip's IN  (head)
//   • within the edge zone of the right edge → trim the clip's OUT (tail)
//   • anything else (the body)               → move / slip / slide (by modifier)
//
// A clip's OWN edge ALWAYS trims THAT clip — even when it's butted against a
// neighbour. ROLL (moving a shared cut point) is the rarer op, so it is opt-in
// via Cmd, never the default for an edge grab (the old auto-roll made it
// impossible to head-trim a butted clip — you'd silently roll the cut instead).
//
// Modifiers refine the body + edge tools:
//   • body, no modifier      → MOVE  (op: move, toPosition from pixel delta)
//   • body + Alt             → SLIP  (op: slip, delta from pixel delta)
//   • body + Cmd/Meta        → SLIDE (op: slide, delta from pixel delta)
//   • edge, no modifier      → TRIM  (op: trimIn / trimOut)
//   • edge + Alt             → RIPPLE TRIM (rippleAllTracks: true)
//   • edge + Cmd/Meta        → ROLL  (the shared cut with the flush neighbour)
//
// All deltas are computed in INTEGER FRAMES from a pixel delta at the current
// scale — frame-exact, never a float. The op invocation is built fresh on
// pointerup from the committed frame delta.
import type { ClipItem, OpInvocation, PlacedItem, TrackAddr } from "./types";

/** How close (px) to a clip edge counts as an edge grab. Generous enough to hit
 *  reliably (8px was torture); capped per-clip in resolveGesture so a narrow clip
 *  still keeps a draggable body. */
export const EDGE_PX = 14;
/** How close (px) to the boundary between two adjacent clips counts as a seam. */
export const SEAM_PX = 7;

export type Tool = "move" | "trimIn" | "trimOut" | "roll" | "slip" | "slide";

export interface Modifiers {
  alt: boolean;
  meta: boolean;
}

/** The neighbour context a gesture may need: the adjacent placed clips on the
 *  same track (for roll / readouts), resolved by the strip from the track model. */
export interface ClipNeighbours {
  /** The clip immediately to the LEFT on the same track, if it is a clip. */
  left: PlacedItem | null;
  /** The clip immediately to the RIGHT on the same track, if it is a clip. */
  right: PlacedItem | null;
}

/** A live gesture: the tool, the clip it acts on, and enough context to build the
 *  op invocation and the rubber-band preview on each move. */
export interface Gesture {
  tool: Tool;
  /** The selected clip's uuid. */
  uuid: string;
  /** The track the clip lives on (stable id) — for move's toTrack + roll's track. */
  trackId: string;
  /** The clip's current placement (start + length in frames) at gesture start. */
  placed: PlacedItem;
  /** Same-track neighbours captured at gesture start (for roll + slip readout). */
  neighbours: ClipNeighbours;
  /** Whether this gesture ripples (Alt on an edge trim / move). */
  ripple: boolean;
  /** For a TRIM, how many frames the clip may EXTEND on its trim side before a
   *  non-ripple neighbour wall: a neighbour blank yields its length; real content
   *  (clip/dissolve) or the track head yields 0; open trailing space (a trimOut with
   *  nothing to the right) is `Infinity`. Captured at gesture start (the timeline is
   *  static for the drag's lifetime) and consumed by `gestureDxBounds`. Undefined for
   *  non-trim tools. */
  extendRoom?: number;
}

/** The raw grab geometry, before neighbour context picks roll vs trim. */
export type Zone = "left-edge" | "right-edge" | "body";

/**
 * Classify a pointerdown at `localX` (px from the clip's left edge, clip is
 * `widthPx` wide) into a grab zone + the body tool the modifiers select. The
 * STRIP then upgrades an edge zone to a ROLL when an adjacent same-track clip is
 * flush against that edge (a roll needs the pair); otherwise an edge is a TRIM.
 */
export function resolveGesture(
  localX: number,
  widthPx: number,
  mods: Modifiers,
): { zone: Zone; bodyTool: "move" | "slip" | "slide" } {
  // Cap the edge zone to a third of the clip so a narrow clip keeps a body to
  // grab for move/slip/slide (otherwise the two edge zones would meet and you
  // could never grab the middle).
  const edge = Math.min(EDGE_PX, widthPx / 3);
  const nearLeft = localX <= edge;
  const nearRight = localX >= widthPx - edge;
  const bodyTool: "move" | "slip" | "slide" = mods.alt ? "slip" : mods.meta ? "slide" : "move";
  if (nearLeft) return { zone: "left-edge", bodyTool };
  if (nearRight) return { zone: "right-edge", bodyTool };
  return { zone: "body", bodyTool };
}

/** Snap radius in PIXELS — a candidate edge within this many px of the dragged
 *  edge is snapped to. Kept in px (not frames) so snapping feels the same at every
 *  zoom: it gets easier to hit a target as you zoom in, exactly like Premiere. */
export const SNAP_PX = 6;

/**
 * Snap an integer `frame` to the nearest candidate (other clip edges, the
 * playhead, frame 0) when it lands within SNAP_PX at the current scale. Returns
 * the snapped integer frame and the snapped-to candidate (for drawing a snap
 * guide), or the input frame unchanged when nothing is close.
 */
export function snapFrame(
  frame: number,
  candidates: number[],
  pxPerFrame: number,
): { frame: number; snappedTo: number | null } {
  let best: number | null = null;
  let bestPx = SNAP_PX;
  for (const c of candidates) {
    const px = Math.abs(c - frame) * pxPerFrame;
    if (px <= bestPx) {
      best = c;
      bestPx = px;
    }
  }
  return best == null ? { frame, snappedTo: null } : { frame: best, snappedTo: best };
}

/** The CSS cursor for a zone/tool, so the clip reads its affordance on hover. */
export function cursorFor(tool: Tool): string {
  switch (tool) {
    case "trimIn":
    case "trimOut":
      return "ew-resize";
    case "roll":
      return "col-resize";
    case "slip":
      return "grab";
    case "slide":
      return "grab";
    default:
      return "grab";
  }
}

/** Whether a clip has a known media ceiling on its OUT point — a real footage file
 *  with a probed `length`. A `color` generator is POSITIONLESS (no source window)
 *  and an un-probed file clip has an unknown length, so neither caps the tail
 *  (mirrors the op guards: trimOut/slip only enforce `clip.length` when present and
 *  non-color). */
function sourceTailRoom(item: ClipItem): number {
  if (item.service === "color" || item.length == null) return Number.POSITIVE_INFINITY;
  return item.length - 1 - item.out; // frames the OUT may move later before source end
}

/**
 * The inclusive integer `[min, max]` range the gesture's `dxFrames` may occupy
 * before it crosses a NATURAL LIMIT — mirroring how Premiere/Resolve trim: an edge
 * STOPS dead at the wall instead of travelling into an impossible place and erroring
 * on commit. Three wall classes (all derived from the pure op guards):
 *   1. media/source — can't reveal frames the source lacks (head ≥ frame 0; tail ≤
 *      the source's last frame);
 *   2. minimum length — the two edges can't cross (the clip stops at 1 frame);
 *   3. adjacency (NON-ripple trim only) — a normal trim extends into a gap but stops
 *      at the next clip; ripple (Alt) lifts this wall since other content shuffles.
 *
 * The op's own guards stay as the correctness backstop for the agent/CLI/MCP path
 * (a coded `trimIn delta:-17` still returns a typed EditError); this clamp just means
 * a HUMAN dragging never generates one. `±Infinity` = no wall that side (unknown
 * source length, open trailing space, a move's open right edge). Pure integer math.
 */
export function gestureDxBounds(g: Gesture): { min: number; max: number } {
  const POS = Number.POSITIVE_INFINITY;
  const NEG = Number.NEGATIVE_INFINITY;
  const item = g.placed.item;
  if (item.kind !== "clip") return { min: NEG, max: POS };

  switch (g.tool) {
    case "move":
    case "slide":
      // The clip start can't go before frame 0; rightward the timeline just grows.
      return { min: -g.placed.start, max: POS };

    case "trimIn": {
      // shorten head (later start): dx ≤ out−in keeps ≥1 frame.
      // extend head (earlier start): dx ≥ −in stops at the source's first frame;
      // non-ripple also can't pass the neighbour wall (−extendRoom).
      const max = item.out - item.in;
      let min = -item.in;
      if (!g.ripple && g.extendRoom != null) min = Math.max(min, -g.extendRoom);
      return { min, max };
    }

    case "trimOut": {
      // shorten tail (earlier end): dx ≥ in−out keeps ≥1 frame.
      // extend tail (later end): dx ≤ (length−1)−out stops at the source's last
      // frame; non-ripple also can't pass the neighbour wall (extendRoom).
      const min = item.in - item.out;
      let max = sourceTailRoom(item);
      if (!g.ripple && g.extendRoom != null) max = Math.min(max, g.extendRoom);
      return { min, max };
    }

    case "slip": {
      // newIn = in − dx ≥ 0 → dx ≤ in (source head); newOut = out − dx ≤ length−1
      // → dx ≥ out − (length−1) (source tail, when the length is known).
      const min =
        item.service !== "color" && item.length != null ? item.out - (item.length - 1) : NEG;
      return { min, max: item.in };
    }

    case "roll": {
      const left = g.neighbours.left?.item;
      const right = g.neighbours.right?.item;
      if (left?.kind !== "clip" || right?.kind !== "clip") return { min: NEG, max: POS };
      // left grows on its TAIL (new out = leftOut + dx); right retracts its HEAD
      // (new in = rightIn + dx). Each side bounded by its own source + the ≥1-frame
      // floor: dx ≥ max(leftIn−leftOut, −rightIn); dx ≤ min(left tail room, rightOut−rightIn).
      const min = Math.max(left.in - left.out, -right.in);
      const max = Math.min(sourceTailRoom(left), right.out - right.in);
      return { min, max };
    }

    default:
      return { min: NEG, max: POS };
  }
}

/** Build the op invocation for a committed gesture given the integer FRAME delta
 *  the pointer travelled (dxFrames) and, for move, the target position/track.
 *  Returns null when the delta is a no-op (0 frames). */
export function buildInvocation(
  g: Gesture,
  dxFrames: number,
  rippleAllTracks: boolean,
  /** The track the clip should land on (move only). Defaults to the source track;
   *  a different id (same kind — the strip clamps that) is a CROSS-TRACK move. */
  toTrackId: string = g.trackId,
): OpInvocation | null {
  const trackAddr: TrackAddr = { trackId: g.trackId };
  switch (g.tool) {
    case "move": {
      const toPosition = Math.max(0, g.placed.start + dxFrames);
      // A no-op only when NEITHER position NOR track changed (a same-position
      // cross-track drop is a real move — don't discard it).
      if (toPosition === g.placed.start && toTrackId === g.trackId) return null;
      return {
        op: "move",
        args: {
          uuid: g.uuid,
          toTrack: { trackId: toTrackId },
          toPosition,
          // A body move uses lift+overwrite by default; Alt makes it ripple.
          ripple: rippleAllTracks,
          rippleAllTracks,
        },
      };
    }
    case "trimIn": {
      // Dragging the head RIGHT (+dx) trims IN (later start); LEFT extends it.
      if (dxFrames === 0) return null;
      return { op: "trimIn", args: { uuid: g.uuid, delta: dxFrames, rippleAllTracks } };
    }
    case "trimOut": {
      // Dragging the tail RIGHT (+dx) EXTENDS the clip; the trimOut op takes +delta
      // to SHORTEN the tail, so a rightward drag is a negative delta.
      if (dxFrames === 0) return null;
      return { op: "trimOut", args: { uuid: g.uuid, delta: -dxFrames, rippleAllTracks } };
    }
    case "roll": {
      if (dxFrames === 0) return null;
      const left = g.neighbours.left?.item;
      const right = g.neighbours.right?.item;
      // A roll needs the pair flush at the grabbed seam; the strip only sets
      // tool=roll when it resolved both. delta>0 slides the seam later.
      if (!left || !right || left.kind !== "clip" || right.kind !== "clip") return null;
      return {
        op: "roll",
        args: {
          track: trackAddr,
          leftUuid: left.id,
          rightUuid: right.id,
          delta: dxFrames,
        },
      };
    }
    case "slip": {
      // Dragging the body LEFT (−dx) reveals LATER source (slip +); dragging RIGHT
      // reveals EARLIER source (slip −). So slip delta = −dxFrames.
      if (dxFrames === 0) return null;
      return { op: "slip", args: { uuid: g.uuid, delta: -dxFrames } };
    }
    case "slide": {
      if (dxFrames === 0) return null;
      return { op: "slide", args: { uuid: g.uuid, delta: dxFrames } };
    }
    default:
      return null;
  }
}
