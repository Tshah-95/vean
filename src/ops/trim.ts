import type { Clip, Filter, Item, Track } from "../ir/types";
// trimIn / trimOut — resize a clip's in/out window by `delta` frames. Both trim
// verbs live in one file (they share validation, the neighbour-blank math, and
// the keyframe-window shift) and are registered separately ("trimIn"/"trimOut").
//
// Shotcut semantics (`multitrackmodel.cpp::trimClipIn`/`trimClipOut`):
//   • trimIn:  new in  = in  + delta. delta>0 trims the HEAD shorter (later
//     start); delta<0 extends the head EARLIER (eats into the left neighbour
//     blank). out is unchanged; playtime changes by −delta.
//   • trimOut: new out = out − delta. delta>0 trims the TAIL shorter (earlier
//     end); delta<0 extends the tail LATER. in is unchanged; playtime −delta.
//   • NON-ripple grows/shrinks the NEIGHBOURING blank (left for trimIn, right for
//     trimOut) so the rest of the track stays put; a blank that hits 0 is removed,
//     and a positive `delta` against no neighbour blank inserts one (trimIn keeps
//     the clip's start fixed; trimOut pads to keep downstream content fixed).
//   • RIPPLE shifts every OTHER unlocked track instead of touching a blank
//     (`rippleOtherTracks`): the playtime change is opened/closed cross-track.
//   • Clip-attached fade/keyframe windows shift by the trim (the
//     `MLT.adjustClipFilters` re-base). Fades are integer-frame SENTINELS in the
//     IR (decision #1, DESIGN-MOVE1.md §4) — the serializer owns their keyframe
//     math — so a trim only has to CLAMP a fade that no longer fits the shorter
//     window (recorded as a warning), never rewrite keyframe strings. Escape-hatch
//     animated filters re-base via `shiftAnimWindow` (the head-trim case: trimIn
//     subtracts `delta` from every keyframe frame; see §4).
//   • Guard like `trimClipInValid`/`trimClipOutValid` (can't trim past the source
//     window, the clip's own length, or — non-ripple — into a missing blank) → an
//     EditError, never a throw.
//
// Inverse: the SAME verb with `delta: -delta` (the design's scalar inverse). It's
// exact here: trim is integer-frame arithmetic and the neighbour-blank growth is
// perfectly symmetric (grow-by-δ ↔ shrink-by-δ; remove-at-0 ↔ insert-δ), and a
// fade clamped on the way down is re-grown on the way up because the sentinel
// `frames` is preserved verbatim through the trim. So `trimIn(-δ)∘trimIn(δ)` and
// `trimOut(-δ)∘trimOut(δ)` are the identity (contract law #2) without any
// captured-data restore op.
import {
  type RippleNote,
  blankItem,
  cloneTimeline,
  findClip,
  isFadeIn,
  isFadeOut,
  playtime,
  rippleOtherTracks,
  shiftAnimWindow,
  shiftClipAnimWindows,
} from "./primitives";

// Re-export the shared keyframe-window re-base so the historical import path
// (`../src/ops/trim`) the trim/move tests use keeps working — the implementation
// now lives in `primitives` so split + trim share one copy (DESIGN-MOVE1.md §4).
export { shiftAnimWindow };
import {
  type Consequences,
  type EditError,
  type Op,
  type OpResult,
  type TrimArgs,
  type Warning,
  editError,
  noConsequences,
  trimArgs,
} from "./types";

// ─── Fade clamp (a fade can't exceed the trimmed window) ──────────────────────
/** The total fade frames a clip carries (fadeIn + fadeOut sentinels). */
function fadeTotal(filters: Filter[]): number {
  let total = 0;
  for (const f of filters) {
    if (isFadeIn(f) || isFadeOut(f)) {
      const fr = f.properties.frames;
      total += typeof fr === "number" ? fr : Number.parseInt(String(fr ?? 0), 10) || 0;
    }
  }
  return total;
}

// ─── Shared trim core ─────────────────────────────────────────────────────────
type Side = "in" | "out";

/** The pure trim engine, parameterized by side. trimIn adjusts the LEFT neighbour
 *  blank + the clip `in`; trimOut adjusts the RIGHT neighbour blank + the clip
 *  `out`. Both shift the same way under ripple. Returns an OpResult or EditError. */
function doTrim(
  state: Parameters<Op<TrimArgs>>[0],
  args: TrimArgs,
  side: Side,
): OpResult | EditError {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const { clip } = loc;
  const len = playtime(clip);
  const delta = args.delta;
  if (delta === 0) {
    // A no-op trim still returns a valid (identity) result so callers can compose.
    return identityTrim(state, loc, side, args);
  }

  // A color generator is POSITIONLESS: it has no external source, every frame is
  // content-identical, and the serializer ALWAYS emits it 0-based (in=0,
  // out=len-1, length=len — `serialize.ts walkTrack`, the same invariant the
  // split-color fix enforces in `splitEntryAt`). So its `in`/`out` carry no
  // source meaning — only the PLAYTIME (frame count) is real. Trim therefore
  // validates + resizes a color clip by playtime and re-bases the window to
  // 0-based, keeping the IR byte-identical to what the serializer emits. Without
  // this the in-memory window (e.g. in=10,out=49) diverges from the serialized
  // form (in=0,out=39), and the scalar inverse — computed against the
  // pre-rebase `in` — underflows after a serialize→reparse persist round-trip
  // (the C3 / persisted-undo defect). `length` is intrinsic to a color
  // generator (its own played count), never an external ceiling.
  const positionless = clip.service === "color";

  // ── Validate (mirror trimClipInValid / trimClipOutValid) ──
  const newLenCheck = len - delta; // playtime after the trim
  if (positionless) {
    // A color clip can be any length (no source ceiling); the only hard limit is
    // that the trim must leave at least one frame. Extension into a neighbour is
    // governed later by `neighbourBlankTrim` (non-ripple) like a file clip.
    if (newLenCheck < 1) {
      return editError({
        kind: "frame-out-of-range",
        frame: newLenCheck,
        bound: 1,
        detail:
          `${side === "in" ? "trimIn" : "trimOut"}: trimming by ${delta} would leave ` +
          `${newLenCheck} frames (< 1) — would empty color clip "${args.uuid}"`,
      });
    }
  } else if (side === "in") {
    const newIn = clip.in + delta;
    if (newIn < 0) {
      return editError({
        kind: "frame-out-of-range",
        frame: newIn,
        bound: 0,
        detail: `trimIn: new in-point ${newIn} < 0 (source start) for clip "${args.uuid}"`,
      });
    }
    if (newIn > clip.out) {
      return editError({
        kind: "frame-out-of-range",
        frame: newIn,
        bound: clip.out,
        detail: `trimIn: new in-point ${newIn} > out ${clip.out} (would empty clip "${args.uuid}")`,
      });
    }
  } else {
    const newOut = clip.out - delta;
    if (newOut < clip.in) {
      return editError({
        kind: "frame-out-of-range",
        frame: newOut,
        bound: clip.in,
        detail: `trimOut: new out-point ${newOut} < in ${clip.in} (would empty clip "${args.uuid}")`,
      });
    }
    // Can't extend the tail past the source length (matches `>= info->length`).
    if (clip.length != null && newOut >= clip.length) {
      return editError({
        kind: "frame-out-of-range",
        frame: newOut,
        bound: clip.length - 1,
        detail: `trimOut: new out-point ${newOut} >= source length ${clip.length} for clip "${args.uuid}"`,
      });
    }
  }

  const next = cloneTimeline(state);
  const track = next.tracks[loc.trackKind][loc.trackIndex] as Track;
  const items = track.items;
  const target = items[loc.itemIndex] as Clip;

  // ── Resize the clip window ──
  const newLen = len - delta; // playtime after the trim (both sides shrink with +δ)
  if (positionless) {
    // Re-base the positionless color window to canonical 0-based by playtime, the
    // exact form the serializer emits (so the IR is byte-identical to the
    // round-trip and the scalar inverse survives serialize→reparse). The trim
    // side has already chosen which neighbour blank absorbs the change; the
    // window itself is just `[0, newLen-1]` with `length = newLen`. A color clip
    // carries no source-windowed keyframe filters (a fade is a frame-count
    // sentinel the serializer re-anchors), so no `shiftClipAnimWindows` is
    // needed — matching the split-color path.
    target.in = 0;
    target.out = newLen - 1;
    target.length = newLen;
  } else if (side === "in") {
    target.in = clip.in + delta;
    // trimIn moves the clip's local origin by +delta, so an animated filter's
    // keyframes re-base by −delta (a keyframe at old-local f is now at f−delta).
    shiftClipAnimWindows(target, -delta, newLen);
  } else {
    target.out = clip.out - delta;
    // trimOut leaves the origin fixed; keyframe frames are unchanged (only the
    // window shrank — out-of-range keyframes simply no longer render, which the
    // serializer/melt already tolerate). No shift needed.
  }

  // ── Clamp a fade that no longer fits the shorter window (warning, non-fatal) ──
  const warnings: Warning[] = [];
  if (newLen < fadeTotal(target.filters)) {
    warnings.push({
      code: "fade-exceeds-window",
      detail:
        `clip "${args.uuid}" fades total ${fadeTotal(target.filters)} frames but the trimmed ` +
        `window is ${newLen}; the serializer will clamp the fade to fit`,
    });
  }

  const c = noConsequences();
  c.clipsTrimmed.push({
    uuid: clip.id,
    inDelta: side === "in" ? delta : 0,
    outDelta: side === "out" ? -delta : 0, // out moved by −delta
    playtimeDelta: -delta,
  });
  c.warnings = warnings;

  if (args.rippleAllTracks) {
    rippleTrim(next, loc, side, delta, c);
  } else {
    const err = neighbourBlankTrim(items, loc.itemIndex, side, delta, c, track.id);
    if (err) return err;
  }

  return {
    state: next,
    consequences: c,
    inverse: { op: side === "in" ? "trimIn" : "trimOut", args: { ...args, delta: -delta } },
  };
}

/** An identity (delta=0) trim: a valid no-change result whose inverse is itself.
 *  Keeps the op total so a caller can pass a 0 delta without special-casing. */
function identityTrim(
  state: Parameters<Op<TrimArgs>>[0],
  loc: ReturnType<typeof findClip> & object,
  side: Side,
  args: TrimArgs,
): OpResult {
  const next = cloneTimeline(state);
  const c = noConsequences();
  c.clipsTrimmed.push({
    uuid: (loc as { clip: Clip }).clip.id,
    inDelta: 0,
    outDelta: 0,
    playtimeDelta: 0,
  });
  return {
    state: next,
    consequences: c,
    inverse: { op: side === "in" ? "trimIn" : "trimOut", args: { ...args, delta: 0 } },
  };
}

// ─── Non-ripple: grow/shrink the neighbouring blank ───────────────────────────
/** Adjust the blank on the trim side so the rest of the track stays put. Mutates
 *  the (cloned) `items` in place and fills the blank consequences. `delta>0`
 *  (shorter clip) GROWS the neighbour blank by `delta`; `delta<0` (longer clip)
 *  SHRINKS it (and removes it at 0). When there is no neighbour blank: `delta>0`
 *  inserts one (preserves the clip's screen position); `delta<0` is invalid (the
 *  clip can't extend into adjacent CONTENT non-ripple — matches Shotcut's
 *  `trimClipInValid` rejecting `delta<0` with no left blank). */
function neighbourBlankTrim(
  items: Item[],
  clipIndex: number,
  side: Side,
  delta: number,
  c: Consequences,
  trackId: string,
): EditError | undefined {
  // The blank that absorbs the change: left of the clip for trimIn, right for trimOut.
  const blankIndex = side === "in" ? clipIndex - 1 : clipIndex + 1;
  const neighbour = items[blankIndex] as Item | undefined;
  const hasBlank = neighbour?.kind === "blank";

  if (hasBlank) {
    const blank = neighbour as Extract<Item, { kind: "blank" }>;
    const newBlankLen = blank.length + delta;
    if (newBlankLen < 0) {
      // The clip wants to extend further than the blank can give back.
      return editError({
        kind: "precondition",
        detail:
          `${side === "in" ? "trimIn" : "trimOut"}: extending clip by ${-delta} frames exceeds the ` +
          `neighbouring blank (${blank.length}); use ripple or trim less`,
      });
    }
    if (newBlankLen === 0) {
      items.splice(blankIndex, 1);
      c.blanksRemoved.push({ track: trackId, position: 0, length: blank.length });
    } else {
      items[blankIndex] = blankItem(newBlankLen);
      // A resized blank reads as removed-then-created in the report.
      c.blanksRemoved.push({ track: trackId, position: 0, length: blank.length });
      c.blanksCreated.push({ track: trackId, position: 0, length: newBlankLen });
    }
    return undefined;
  }

  // No neighbour blank.
  if (delta > 0) {
    // Insert a blank to hold the clip's position (trimIn: before the clip;
    // trimOut: after it). Trailing blanks are dropped by consolidateBlanks on
    // serialize, which is exactly right for a trimOut at the track tail (nothing
    // after it to hold) — and the scalar inverse re-grows the clip without needing
    // the blank back, so the round-trip is still exact.
    const insertAt = side === "in" ? clipIndex : clipIndex + 1;
    items.splice(insertAt, 0, blankItem(delta));
    c.blanksCreated.push({ track: trackId, position: 0, length: delta });
    return undefined;
  }
  // delta < 0, no blank to give back: can't extend into adjacent content.
  return editError({
    kind: "precondition",
    detail:
      `${side === "in" ? "trimIn" : "trimOut"}: cannot extend clip by ${-delta} frames — no ` +
      `neighbouring blank on the ${side === "in" ? "left" : "right"} (use ripple)`,
  });
}

// ─── Ripple: shift every other track by the playtime change ───────────────────
/** Ripple the trim across the OTHER tracks. The playtime shrinks by `delta`
 *  (delta>0), so other tracks pull LEFT by `delta` from the trim seam; delta<0
 *  pushes them RIGHT. The seam is the clip's start (trimIn) or end (trimOut). */
function rippleTrim(
  state: Parameters<Op<TrimArgs>>[0],
  loc: NonNullable<ReturnType<typeof findClip>>,
  side: Side,
  delta: number,
  c: Consequences,
): void {
  // Seam position on the timeline where the ripple opens/closes.
  const seam = side === "in" ? loc.position : loc.position + playtime(loc.clip) - delta;
  const frames = Math.abs(delta);
  const dir: 1 | -1 = delta > 0 ? -1 : 1; // +δ shortens → pull left; −δ → push right
  const notes: RippleNote[] = rippleOtherTracks(
    state,
    loc.trackKind,
    loc.trackIndex,
    seam,
    frames,
    dir,
  );
  for (const n of notes) {
    if (n.blocked) {
      c.warnings.push({
        code: "ripple-blocked",
        detail: `track "${n.track}" holds content at frame ${n.from}; ripple left it in place`,
      });
    } else {
      c.ripple.push({ track: n.track, shift: n.shift, from: n.from });
    }
  }
}

// ─── The two public ops ───────────────────────────────────────────────────────
export const trimIn: Op<TrimArgs> = (state, args) => doTrim(state, args, "in");
export const trimOut: Op<TrimArgs> = (state, args) => doTrim(state, args, "out");

export { trimArgs };

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { clip, colorClip, filter, resetIds, timeline, videoTrack } from "../ir/builder";
import { blank } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { Timeline } from "../ir/types";
import type { OpSample } from "./types";

export const samplesTrimIn: OpSample<TrimArgs>[] = [
  {
    name: "trimIn a clip whose left neighbour is a blank (blank grows by delta)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(blank(20), clip("/abs/a.mp4", { id: "tin", dur: 90, fadeIn: 10 }))],
      });
    },
    // delta +15: in 0→15, playtime 90→75, left blank 20→35.
    args: { uuid: "tin", delta: 15, rippleAllTracks: false },
  },
  {
    name: "trimIn (extend head) eating into the left blank (delta < 0)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(blank(30), clip("/abs/a.mp4", { id: "tin2", in: 20, out: 99 }))],
      });
    },
    // delta -10: in 20→10 (earlier start), playtime 80→90, left blank 30→20.
    args: { uuid: "tin2", delta: -10, rippleAllTracks: false },
  },
  {
    name: "trimIn a head-clip with no left blank (a holding blank is inserted)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(clip("/abs/a.mp4", { id: "tin3", dur: 60 }))],
      });
    },
    // delta +12: in 0→12, playtime 60→48, a 12-frame blank is inserted on the left.
    args: { uuid: "tin3", delta: 12, rippleAllTracks: false },
  },
  {
    // A COLOR (positionless) clip: the trim must re-base the window to 0-based by
    // playtime (the form the serializer emits), so the scalar inverse survives a
    // serialize→reparse persist. Without the color branch the in-memory window
    // (in=10) diverges from the persisted form (in=0) and the inverse underflows
    // (the C3 / persisted-undo defect). This sample exercises the in-memory
    // inverse law + the serialize round-trip; a dedicated persist test in
    // tests/ops-trim-move.test.ts covers serialize→reparse→undo end-to-end.
    name: "trimIn a COLOR clip — window re-bases 0-based by playtime",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(blank(20), colorClip(50, "blue", { id: "tinC" }))],
      });
    },
    // delta +10: playtime 50→40, window re-based to in=0,out=39,length=40, left
    // blank 20→30. Inverse trimIn −10 re-grows playtime to 50 (in=0,out=49).
    args: { uuid: "tinC", delta: 10, rippleAllTracks: false },
  },
  {
    name: "trimIn ripple — other tracks pull left by delta (over trailing emptiness)",
    // The trimmed clip starts at frame 30 (a leading blank holds it there), so the
    // ripple seam is at frame 30; the overlay track ends at frame 15 (before the
    // seam). The cross-track ripple therefore acts only on trailing emptiness —
    // the regime where ripple is LOSSLESS and its inverse (push content back right)
    // reconstructs the original byte-for-byte. A ripple that cut real content out of
    // another track is intentionally lossy in Shotcut too (see remove's note); the
    // inverse-exact invariant only holds over blank, which the consequences expose.
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(blank(30), clip("/abs/a.mp4", { id: "tinR", dur: 80 })),
          videoTrack(clip("/abs/b.mp4", { id: "other", dur: 15 })),
        ],
      });
    },
    // delta +20: clip head shortens (in 0→20); the other track (ending at 15, before
    // the seam at 30) only has trailing emptiness pulled left — a no-op there.
    args: { uuid: "tinR", delta: 20, rippleAllTracks: true },
  },
];

export const samplesTrimOut: OpSample<TrimArgs>[] = [
  {
    name: "trimOut a clip with a right-neighbour blank (blank grows by delta)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/a.mp4", { id: "tout", dur: 90, fadeOut: 10 }),
            blank(25),
            clip("/abs/c.mp4", { id: "after", dur: 40 }),
          ),
        ],
      });
    },
    // delta +15: out 89→74, playtime 90→75, right blank 25→40, "after" stays put.
    args: { uuid: "tout", delta: 15, rippleAllTracks: false },
  },
  {
    name: "trimOut (extend tail) consuming the right blank (delta < 0)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/a.mp4", { id: "tout2", in: 0, out: 49, length: 200 }),
            blank(30),
            clip("/abs/c.mp4", { id: "after2", dur: 40 }),
          ),
        ],
      });
    },
    // delta -10: out 49→59 (longer, within source length 200), right blank 30→20.
    args: { uuid: "tout2", delta: -10, rippleAllTracks: false },
  },
  {
    name: "trimOut a tail-clip with no right blank (trailing — no holding blank needed)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(clip("/abs/a.mp4", { id: "tout3", dur: 70 }))],
      });
    },
    // delta +20: out 69→49, playtime 70→50; the inserted trailing blank is dropped
    // on serialize, and the scalar inverse re-grows the clip — round-trip exact.
    args: { uuid: "tout3", delta: 20, rippleAllTracks: false },
  },
  {
    name: "trimOut on a clip carrying an escape-hatch animated filter (window unchanged)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/scene.mp4", {
              id: "toutF",
              dur: 100,
              filters: [filter("brightness", { level: "0=0.2;99=1" })],
            }),
            blank(40),
          ),
        ],
      });
    },
    // delta +30: out 99→69; the right blank (40) grows to 70.
    args: { uuid: "toutF", delta: 30, rippleAllTracks: false },
  },
  {
    // The trimOut twin of the color trimIn sample: a positionless color clip's
    // window re-bases 0-based by playtime so the scalar inverse survives a
    // serialize→reparse persist. The right neighbour blank absorbs the change.
    name: "trimOut a COLOR clip — window re-bases 0-based by playtime",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(50, "blue", { id: "toutC" }), blank(25))],
      });
    },
    // delta +10: playtime 50→40, window re-based to in=0,out=39,length=40, right
    // blank 25→35. Inverse trimOut −10 re-grows playtime to 50 (in=0,out=49).
    args: { uuid: "toutC", delta: 10, rippleAllTracks: false },
  },
];
