// slide — move a clip earlier/later in time WITHOUT changing its content; the two
// neighbours absorb the shift so the track's total duration is unchanged.
//
// Shotcut semantics (the "slide" trim mode, `multitrackmodel.cpp` slide path):
// a slide is a paired trim of the clip's two neighbours that translates the clip
// along the track while its OWN source window (`in`/`out`/playtime) stays fixed —
// the clip's frames are identical, only WHERE on the timeline it plays moves.
//   • delta > 0 (clip moves LATER / right): the LEFT neighbour EXTENDS by `delta`
//     (grows to backfill the space the clip vacated on its left) and the RIGHT
//     neighbour RETRACTS by `delta` (shrinks because the clip now occupies frames
//     that were the right neighbour's).
//   • delta < 0 (clip moves EARLIER / left): the mirror — the LEFT neighbour
//     retracts, the RIGHT neighbour extends.
// In both directions the LEFT neighbour changes by `+delta` and the RIGHT by
// `-delta`, so the sum is 0 and the track length is preserved (durationDelta: 0).
//
// Each neighbour is adjusted by KIND (exactly as trim.ts handles the neighbour
// space it grows/shrinks):
//   • a CLIP neighbour resizes its source window like a trim — the LEFT neighbour
//     moves its `out` (tail), the RIGHT neighbour moves its `in` (head) — bounded
//     by the same media limits (`in >= 0`, `out < length`, window stays ≥ 1f);
//   • a BLANK neighbour resizes its `length` (created when one is needed and the
//     neighbour is the clip's own start/end, removed when it hits 0), mirroring
//     `neighbourBlankTrim`.
//
// Guards (returned as typed EditErrors, never thrown — contract law #5):
//   • a required neighbour is missing (the clip is at a track edge with no
//     neighbour to give/take the frames) → precondition;
//   • a clip-neighbour cannot extend past its media bounds, or a retracting
//     neighbour would be left with < 1 frame → frame-out-of-range;
//   • the slid clip OR an adjacent clip participates in a dissolve (sliding would
//     leave a dissolve marker longer than its clip / dangling) → precondition.
//
// Inverse: `slide` with `delta: -delta`. The neighbour math is symmetric integer
// arithmetic (a clip-neighbour's window shift and a blank-neighbour's grow/shrink
// each reverse exactly), so `slide(-δ) ∘ slide(δ)` is the identity (contract
// law #2) with no captured-data restore op — over the regime where the slide does
// not FULLY CONSUME a neighbour blank. When `δ` shrinks a blank-neighbour to 0 the
// blank is removed and the clip's neighbour becomes the next item (a clip), which
// the scalar inverse cannot re-expand back into a blank (the same "lossless
// regime" caveat trim/move document). Removing a blank is still a valid edit (it
// is reported in `blanksRemoved`); the round-trip law just holds only over the
// blank-preserving regime, exactly as the trim/move samples are scoped.
import { z } from "zod";
import type { Blank, Clip, Item, Track } from "../ir/types";
import { blankItem, cloneTimeline, findClip } from "./primitives";
import {
  type BlankRef,
  type ClipTrim,
  type Consequences,
  type EditError,
  type Op,
  type OpResult,
  editError,
  noConsequences,
} from "./types";

/** slide — translate a clip by `delta` frames in timeline position, keeping its
 *  source window fixed; the two neighbours absorb the shift. */
export const slideArgs = z.object({
  uuid: z.string().min(1),
  /** Signed frames to move the clip in timeline position (+ = later / right). */
  delta: z.number().int(),
});
export type SlideArgs = z.infer<typeof slideArgs>;

export const slide: Op<SlideArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const delta = args.delta;
  const items = (state.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  const i = loc.itemIndex;
  const leftItem = items[i - 1] as Item | undefined;
  const rightItem = items[i + 1] as Item | undefined;

  // A no-op slide (delta = 0) — a valid identity result so callers can compose
  // without special-casing; its inverse is itself.
  if (delta === 0) {
    const next = cloneTimeline(state);
    const c = noConsequences();
    c.clipsMoved.push({
      uuid: loc.clip.id,
      from: { track: loc.trackId, position: loc.position },
      to: { track: loc.trackId, position: loc.position },
    });
    return { state: next, consequences: c, inverse: { op: "slide", args: { ...args } } };
  }

  // ── Dissolve guard: the slid clip, or either adjacent clip, mustn't be wedged
  // against a dissolve marker — sliding would shorten the clip a dissolve depends
  // on (leaving the marker longer than its clip) or strand the marker. A dissolve
  // sits as its OWN item between two clips, so it would BE the left/right
  // neighbour here; reject if any neighbour (or the gap past it) is a dissolve. ──
  if (
    leftItem?.kind === "dissolve" ||
    rightItem?.kind === "dissolve" ||
    items[i - 2]?.kind === "dissolve" ||
    items[i + 2]?.kind === "dissolve"
  ) {
    return editError({
      kind: "precondition",
      detail: `slide: clip "${args.uuid}" or a neighbour participates in a dissolve — remove the dissolve first`,
    });
  }

  // ── A MISSING neighbour is OPEN TRACK-EDGE space, not a hard stop (the old
  // "no left/right neighbour" reject made a clip at either edge un-slideable — the
  // everyday case of sliding the first or last clip). The two edges are asymmetric,
  // exactly like trim's tail/head:
  //   • MISSING RIGHT (last clip): trailing emptiness is implicit and infinite, so
  //     the right side is a NO-OP — the LEFT side's change alone repositions the clip
  //     (grow-left pushes it right, shrink-left pulls it left);
  //   • MISSING LEFT (clip at frame 0): leading space is NOT implicit, so to move the
  //     clip LATER we MATERIALISE a leading blank; moving it EARLIER is impossible
  //     (nothing before frame 0) and is rejected.
  // Validate both sides BEFORE mutating so a rejection leaves state pure. LEFT
  // changes by +delta, RIGHT by -delta. ──
  const leftErr = validateSide(leftItem, "left", delta, args.uuid);
  if (leftErr) return leftErr;
  const rightErr = validateSide(rightItem, "right", -delta, args.uuid);
  if (rightErr) return rightErr;

  // ── Apply on a clone. ──
  const next = cloneTimeline(state);
  const nItems = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  const c = noConsequences();

  // RIGHT first so the LEFT splice/index math (which may insert/remove an item to
  // the clip's left, shifting the right neighbour's index) is computed last and
  // the right index is still `i + 1` when we touch it.
  applySide(nItems, i, "right", -delta, loc.trackId, c);
  applySide(nItems, i, "left", delta, loc.trackId, c);

  // The clip's own window is UNCHANGED — only its timeline position moved by delta.
  c.clipsMoved.push({
    uuid: loc.clip.id,
    from: { track: loc.trackId, position: loc.position },
    to: { track: loc.trackId, position: loc.position + delta },
  });

  return {
    state: next,
    consequences: c,
    inverse: { op: "slide", args: { uuid: args.uuid, delta: -delta } },
  };
};

// ─── Neighbour math ───────────────────────────────────────────────────────────
type Side = "left" | "right";

/** Validate that a side can absorb `change` frames (signed: + grows that side's
 *  span, − shrinks it). `item` is the neighbour (or `undefined` at an open track
 *  edge). A present clip-neighbour is bounded by its media window; a present
 *  blank-neighbour by staying non-negative. A MISSING neighbour is open edge space:
 *  a missing RIGHT absorbs any change (implicit trailing space); a missing LEFT
 *  can only GROW (materialise a leading blank) — a shrink there means sliding a
 *  frame-0 clip earlier, which is impossible. `change` is `+delta` for left, `-delta`
 *  for right. */
function validateSide(
  item: Item | undefined,
  side: Side,
  change: number,
  uuid: string,
): EditError | undefined {
  if (item === undefined) {
    if (side === "right") return undefined; // trailing space absorbs any change
    if (change > 0) return undefined; // missing left, growing → insert a leading blank
    return editError({
      kind: "precondition",
      detail: `slide: clip "${uuid}" is at the track start — cannot slide it earlier (no space before frame 0)`,
    });
  }
  if (item.kind === "clip") {
    // The LEFT neighbour grows/shrinks its TAIL (`out += change`); the RIGHT
    // neighbour grows/shrinks its HEAD by moving its start the OPPOSITE way
    // (`in -= change`, since a longer right-clip starts earlier).
    if (side === "left") {
      const newOut = item.out + change;
      if (newOut < item.in) {
        return editError({
          kind: "frame-out-of-range",
          frame: newOut,
          bound: item.in,
          detail: `slide: left neighbour "${item.id}" would retract its out to ${newOut} < in ${item.in} (would empty it)`,
        });
      }
      if (item.length != null && newOut >= item.length) {
        return editError({
          kind: "frame-out-of-range",
          frame: newOut,
          bound: item.length - 1,
          detail: `slide: left neighbour "${item.id}" would extend its out to ${newOut} >= source length ${item.length}`,
        });
      }
    } else {
      const newIn = item.in - change;
      if (newIn < 0) {
        return editError({
          kind: "frame-out-of-range",
          frame: newIn,
          bound: 0,
          detail: `slide: right neighbour "${item.id}" would extend its in to ${newIn} < 0 (source start)`,
        });
      }
      if (newIn > item.out) {
        return editError({
          kind: "frame-out-of-range",
          frame: newIn,
          bound: item.out,
          detail: `slide: right neighbour "${item.id}" would retract its in to ${newIn} > out ${item.out} (would empty it)`,
        });
      }
    }
    return undefined;
  }
  if (item.kind === "blank") {
    const newLen = item.length + change;
    if (newLen < 0) {
      return editError({
        kind: "precondition",
        detail: `slide: ${side} neighbour blank (${item.length}f) cannot shrink by ${-change} for clip "${uuid}"`,
      });
    }
    return undefined;
  }
  // A dissolve neighbour is already rejected by the dissolve guard above.
  return editError({
    kind: "precondition",
    detail: `slide: ${side} neighbour of clip "${uuid}" is not a clip or blank`,
  });
}

/** Apply the validated change to one side of the slid clip at `clipIndex` (signed:
 *  + grows that side's span). A present clip resizes its window; a present blank
 *  resizes its length (removed at 0). At an OPEN edge: a missing RIGHT is a no-op
 *  (trailing space absorbs it; the LEFT change repositions the clip), and a missing
 *  LEFT that must grow inserts a leading blank to push the clip later. Mutates
 *  `items` in place and fills `c`. */
function applySide(
  items: Item[],
  clipIndex: number,
  side: Side,
  change: number,
  trackId: string,
  c: Consequences,
): void {
  const index = side === "left" ? clipIndex - 1 : clipIndex + 1;
  const item = items[index] as Item | undefined;
  if (item === undefined) {
    // Open track edge. A missing RIGHT is absorbed by implicit trailing space —
    // nothing to do (the LEFT side's change already repositioned the clip). A missing
    // LEFT that grows (change > 0, validated) materialises a leading blank BEFORE the
    // clip so it shifts later; the scalar inverse (slide −delta) then finds that blank
    // as its left neighbour and shrinks it back to 0, so the round-trip stays exact.
    if (side === "left" && change > 0) {
      items.splice(clipIndex, 0, blankItem(change));
      c.blanksCreated.push({ track: trackId, position: 0, length: change });
    }
    return;
  }
  if (item.kind === "clip") {
    const trimmed: ClipTrim =
      side === "left"
        ? { uuid: item.id, inDelta: 0, outDelta: change, playtimeDelta: change }
        : { uuid: item.id, inDelta: -change, outDelta: 0, playtimeDelta: change };
    const next: Clip =
      side === "left" ? { ...item, out: item.out + change } : { ...item, in: item.in - change };
    items[index] = next;
    c.clipsTrimmed.push(trimmed);
    return;
  }
  // A blank: resize its length; a resized blank reads as removed-then-created, a
  // 0-length blank is removed (mirrors neighbourBlankTrim's reporting).
  const blank = item as Blank;
  const newLen = blank.length + change;
  const removed: BlankRef = { track: trackId, position: 0, length: blank.length };
  if (newLen === 0) {
    items.splice(index, 1);
    c.blanksRemoved.push(removed);
  } else {
    items[index] = blankItem(newLen);
    c.blanksRemoved.push(removed);
    c.blanksCreated.push({ track: trackId, position: 0, length: newLen });
  }
}

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { clip, resetIds, timeline, videoTrack } from "../ir/builder";
import { blank } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { Timeline } from "../ir/types";
import type { OpSample } from "./types";

export const samples: OpSample<SlideArgs>[] = [
  {
    // Both neighbours are CLIPS: slide the middle clip later by 10. The left clip
    // extends its tail by 10 (out += 10), the right clip retracts its head by 10
    // (in += 10). The middle clip's own window is untouched; track length unchanged.
    name: "slide a clip later between two clip-neighbours (left tail extends, right head retracts)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/left.mp4", { id: "L", in: 0, out: 49, length: 200 }),
            clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
            clip("/abs/right.mp4", { id: "R", in: 20, out: 99, length: 200 }),
          ),
        ],
      });
    },
    // delta +10: L out 49→59 (within length 200), R in 20→30 (within out 99). mid
    // moves from frame 50 to 60; its in/out/playtime unchanged.
    args: { uuid: "mid", delta: 10 },
  },
  {
    // Both neighbours are BLANKS: slide the middle clip earlier by 8. The left
    // blank retracts by 8 (it shrinks), the right blank extends by 8. Track length
    // unchanged. Exercises the blank-resize + create/remove parity on inverse.
    name: "slide a clip earlier between two blank-neighbours (left blank shrinks, right grows)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            blank(30),
            clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
            blank(25),
            clip("/abs/anchor.mp4", { id: "anchor", dur: 20 }),
          ),
        ],
      });
    },
    // delta -8: left blank 30→22, right blank 25→33. mid moves from 30 to 22.
    args: { uuid: "mid", delta: -8 },
  },
  {
    // MIXED neighbours: a blank on the left, a clip on the right. Slide later by 12:
    // the left blank extends 20→32, the right clip's head retracts (in 0→12). The
    // "anchor" tail keeps the right clip from being a track-edge case.
    name: "slide later with a blank-left and clip-right neighbour",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            blank(20),
            clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
            clip("/abs/right.mp4", { id: "R", in: 0, out: 99, length: 200 }),
          ),
        ],
      });
    },
    // delta +12: left blank 20→32, R in 0→12 (head retracts). mid moves 20→32.
    args: { uuid: "mid", delta: 12 },
  },
  {
    // TRACK-EDGE slide: the LAST clip on the track (no right neighbour). Sliding it
    // LATER used to hard-reject ("no right neighbour"); now the open trailing space
    // absorbs the change and the left clip extends to reposition it. Inverse re-grows
    // the left clip and pulls it back — exact.
    name: "slide the LAST clip later (missing right neighbour → open trailing space)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/head.mp4", { id: "head", in: 0, out: 39, length: 200 }),
            clip("/abs/mv.mp4", { id: "mv", dur: 30 }),
          ),
        ],
      });
    },
    // delta +10: head out 39→49 (extends), mv moves 40→50; right is open (no-op).
    args: { uuid: "mv", delta: 10 },
  },
  {
    // TRACK-EDGE slide: the FIRST clip (at frame 0, no left neighbour). Sliding it
    // LATER used to hard-reject ("no left neighbour"); now a leading blank is
    // materialised to push it right while the right clip's head retracts. Inverse
    // shrinks that blank back to 0 (removed) and re-extends the right clip — exact.
    name: "slide the FIRST clip later (missing left neighbour → leading blank inserted)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/mv.mp4", { id: "mv", dur: 30 }),
            clip("/abs/right.mp4", { id: "R", in: 20, out: 99, length: 200 }),
          ),
        ],
      });
    },
    // delta +10: insert a leading blank(10), R in 20→30 (head retracts). mv moves 0→10.
    args: { uuid: "mv", delta: 10 },
  },
];
