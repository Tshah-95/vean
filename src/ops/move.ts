// move — relocate a clip to (toTrack, toPosition), preserving its uuid + content.
//
// Shotcut semantics (`multitrackmodel.cpp::moveClip` / `overwriteFromTrack` /
// `moveClipToTrack`): remove the clip from its SOURCE and re-place it at the
// DESTINATION, keeping the same producer (so the clip's uuid + filters + gain +
// window are unchanged — only its track/position move). Two regimes, picked by
// the `ripple` flag, mirroring Shotcut's two move paths:
//
//   • NON-RIPPLE (the default, "overwrite" move): LIFT the clip at the source
//     (leave a same-length gap so nothing downstream shifts) then OVERWRITE it
//     onto `[toPosition, toPosition+playtime)` at the destination (stamp over
//     whatever sits there). The rest of both tracks stays put.
//   • RIPPLE: ripple-REMOVE the clip at the source (close the gap — content after
//     pulls LEFT by playtime) then INSERT it at the destination (open a gap —
//     content after pushes RIGHT by playtime). With `rippleAllTracks`, the
//     remove pulls every OTHER track left and the insert pushes them right.
//
// vean builds this directly on the shared primitives (the lower `overwrite` /
// `insert` ops are stubs in this Move, so move can't delegate through `apply`;
// it reuses the SAME surgery they will — `removeRange`, `insertEntryAt`,
// `consolidateBlanks`, `rippleOtherTracks` — so the semantics match once those
// land). The clip's stable `id` rides through unchanged (identity preservation,
// DESIGN-MOVE1.md §1); a same-uuid clip is never duplicated because the source
// entry is gone before the destination entry is placed.
//
// Inverse:
//   • NON-RIPPLE is built by DELEGATING to `lift` (source) then `overwrite` (dest),
//     so its inverse is their inverses composed: `_compound([_restoreRegion(dest),
//     _unlift(source)])`. `overwrite` captures the destination content it stamps
//     over (verbatim, straddle-safe), so the undo RESTORES that content exactly AND
//     puts the clip back at the source — even when the drop landed on real clips
//     (the "overwrite-on-collide" a user drag expects). This is EXACT, not
//     lossless-regime-only: no captured data is thrown away. The consequence report
//     still lists any `clipsRemoved` so a destructive drop is visible before render.
//   • RIPPLE inverts by `move` BACK to the captured origin; that stays exact over
//     the regime the ripple acted on trailing emptiness (the same lossless caveat
//     the remove/insert ripple samples are scoped to — a cross-track ripple that
//     cut real content out of another track is intentionally lossy, as in Shotcut).
// So `move(origin) ∘ move(dest)` is the identity (contract law #2): a `_compound`
// invocation for non-ripple, a single `move` for ripple.
import { z } from "zod";
import type { Clip, Timeline, Track } from "../ir/types";
import { lift } from "./lift";
import { overwrite } from "./overwrite";
import {
  clipTouchesDissolve,
  cloneTimeline,
  consolidateBlanks,
  findClip,
  findTrack,
  insertEntryAt,
  playtime,
  regionTouchesDissolve,
  rippleOtherTracks,
} from "./primitives";
import {
  type Consequences,
  type EditError,
  type MoveArgs,
  type Op,
  type OpResult,
  editError,
  isEditError,
  moveArgs,
  noConsequences,
} from "./types";

export const move: Op<MoveArgs> = (state, args): OpResult | EditError => {
  // ── Locate the clip (the thing being moved) and the destination track ──
  const src = findClip(state, args.uuid);
  if (!src) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const dstTrack = findTrack(state, args.toTrack);
  if (!dstTrack) {
    const track =
      "trackId" in args.toTrack
        ? args.toTrack.trackId
        : `${args.toTrack.kind}[${args.toTrack.index}]`;
    return editError({ kind: "track-not-found", track });
  }

  // Guard: vacating a dissolve-participating clip leaves a dangling marker.
  const srcItems = (state.tracks[src.trackKind][src.trackIndex] as Track).items;
  if (clipTouchesDissolve(srcItems, src.itemIndex)) {
    return editError({
      kind: "precondition",
      detail: `move: clip "${args.uuid}" participates in a dissolve — remove the dissolve first`,
    });
  }
  // Guard: dropping into a dissolve's blended region (on the destination track)
  // would shred the nested transition tractor.
  const dstItems = (state.tracks[dstTrack.kind][dstTrack.index] as Track).items;
  if (regionTouchesDissolve(dstItems, args.toPosition, playtime(src.clip))) {
    return editError({
      kind: "precondition",
      detail: `move: destination [${args.toPosition},${args.toPosition + playtime(src.clip)}) on track "${dstTrack.track.id}" overlaps a dissolve`,
    });
  }
  // Guard: a clip cannot cross between video and audio tracks (Shotcut forbids
  // dragging a video clip onto an audio track and vice versa). The clip's kind is
  // its current track's kind; a different destination kind is rejected.
  if (dstTrack.kind !== src.trackKind) {
    return editError({
      kind: "precondition",
      detail: `move: a ${src.trackKind} clip ("${args.uuid}") cannot move onto a ${dstTrack.kind} track`,
    });
  }

  const moved: Clip = structuredClone(src.clip);
  const len = playtime(moved);
  const srcTrackId = src.trackId;
  const srcPosition = src.position;
  const sameTrack = dstTrack.kind === src.trackKind && dstTrack.index === src.trackIndex;
  const sameSlot = sameTrack && args.toPosition === srcPosition;

  // A no-op move (same track, same position) — return a valid identity result so
  // callers can compose without special-casing.
  if (sameSlot) {
    const next = cloneTimeline(state);
    return {
      state: next,
      consequences: noConsequences(),
      inverse: { op: "move", args: { ...args } },
    };
  }

  // ── NON-RIPPLE (the default drag): lift the source + overwrite the dest. ──
  if (!args.ripple) {
    return moveOverwrite(state, src, dstTrack, moved, len, args);
  }

  // ── RIPPLE: ripple-remove the source, ripple-insert at the destination. ──
  const next = cloneTimeline(state);
  const c = noConsequences();
  moveRipple(next, src, dstTrack, moved, len, args, c);
  c.clipsMoved.push({
    uuid: moved.id,
    from: { track: srcTrackId, position: srcPosition },
    to: { track: dstTrack.track.id, position: args.toPosition },
  });
  return {
    state: next,
    consequences: c,
    inverse: {
      op: "move",
      args: {
        uuid: moved.id,
        toTrack: { trackId: srcTrackId },
        toPosition: srcPosition,
        ripple: args.ripple,
        rippleAllTracks: args.rippleAllTracks,
      },
    },
  };
};

/** Shift any over-composite transition that BRACKETS the moved overlay clip so it
 *  follows the clip. A transition "brackets" the clip when its `bTrack` is the
 *  clip's track (`bTrackIndex`, a main-tractor index where the background producer
 *  is 0) AND its span exactly matches the clip's OLD placement
 *  (`[oldStart, oldStart+len-1]`). Matching transition(s) are re-spanned to the NEW
 *  placement. Mutates `next.transitions` in place; a no-op when nothing matches (a
 *  plain clip with no over-composite is untouched). */
function syncBracketingTransition(
  next: Timeline,
  bTrackIndex: number,
  oldStart: number,
  len: number,
  newStart: number,
): void {
  if (newStart === oldStart) return;
  const oldIn = oldStart;
  const oldOut = oldStart + len - 1;
  for (const t of next.transitions) {
    if (t.bTrack === bTrackIndex && t.in === oldIn && t.out === oldOut) {
      t.in = newStart;
      t.out = newStart + len - 1;
    }
  }
}

// ─── _spanTransition — the invertible form of syncBracketingTransition ─────────
/** Re-span a bracketing over-composite transition: match by `bTrack` + its current
 *  span `[fromIn,fromOut]` and move it to `[toIn,toOut]`. A no-op when nothing
 *  matches (a plain move with no overlay transition), so it is always safe to
 *  include in move's undo compound. Its inverse swaps from⇄to, so it round-trips
 *  (and redo re-applies the forward shift). Internal — only `move`'s inverse names
 *  it; it never appears in the agent-facing vocabulary. */
export const spanTransitionArgs = z.object({
  bTrack: z.number().int().nonnegative(),
  fromIn: z.number().int(),
  fromOut: z.number().int(),
  toIn: z.number().int(),
  toOut: z.number().int(),
});
export type SpanTransitionArgs = z.infer<typeof spanTransitionArgs>;

export const spanTransition: Op<SpanTransitionArgs> = (state, args): OpResult => {
  const next = cloneTimeline(state);
  for (const t of next.transitions) {
    if (t.bTrack === args.bTrack && t.in === args.fromIn && t.out === args.fromOut) {
      t.in = args.toIn;
      t.out = args.toOut;
    }
  }
  return {
    state: next,
    consequences: noConsequences(),
    inverse: {
      op: "_spanTransition",
      args: {
        bTrack: args.bTrack,
        fromIn: args.toIn,
        fromOut: args.toOut,
        toIn: args.fromIn,
        toOut: args.fromOut,
      },
    },
  };
};

// ─── Non-ripple: lift the source, overwrite the destination ───────────────────
/** A non-ripple move = LIFT the clip at the source (leave a same-length gap so
 *  nothing downstream shifts) + OVERWRITE it onto `[toPosition, toPosition+len)` at
 *  the destination (stamp over whatever sits there). Both delegated ops are already
 *  inverse-exact — lift⇄`_unlift`, overwrite⇄`_restoreRegion` (the latter CAPTURES
 *  the overwritten content verbatim, straddle-safe) — so move composes them and
 *  inherits a correct capturing undo for free: `_compound([_restoreRegion(dest),
 *  _unlift(source)])` restores the destination content AND puts the clip back at the
 *  source. This is the "overwrite-on-collide" the old `regionIsBlank` reject
 *  refused; the capture is what makes stamping over real clips safely undoable. */
function moveOverwrite(
  state: Timeline,
  src: NonNullable<ReturnType<typeof findClip>>,
  dst: NonNullable<ReturnType<typeof findTrack>>,
  moved: Clip,
  len: number,
  args: MoveArgs,
): OpResult | EditError {
  const srcTrackId = src.trackId;
  const srcPosition = src.position;
  const sameTrack = dst.kind === src.trackKind && dst.index === src.trackIndex;

  const liftRes = lift(state, { uuid: args.uuid });
  if (isEditError(liftRes)) return liftRes;
  const owRes = overwrite(liftRes.state, {
    track: args.toTrack,
    clip: moved,
    position: args.toPosition,
  });
  if (isEditError(owRes)) return owRes;

  const next = owRes.state;

  // Undo = restore the destination (drop the moved clip, splice the captured span
  // back) THEN put the clip back at the source — the two delegated inverses in
  // last-applied-first order.
  const steps: { op: string; args: unknown }[] = [owRes.inverse, liftRes.inverse];

  // Keep an over-composite field transition IN SYNC with the overlay clip it
  // brackets on a SAME-TRACK move. A graphic/overlay clip (e.g. a Remotion-baked
  // alpha .mov on an upper track) is composited over the footage by a `qtblend`
  // `Transition` scoped to the clip's [in,out] span; dragging the clip along its
  // track must move that transition with it, or the overlay keeps compositing at the
  // old span (the "can't move the Remotion thing" gap). We shift it forward here and
  // PREPEND its own inverse (`_spanTransition`, new→old) to the undo compound so the
  // move round-trips with the transition in tow — the delegated `_restoreRegion` /
  // `_unlift` know nothing about transitions.
  if (sameTrack && src.trackKind === "video") {
    const bTrackIndex = 1 + src.trackIndex;
    syncBracketingTransition(next, bTrackIndex, srcPosition, len, args.toPosition);
    steps.unshift({
      op: "_spanTransition",
      args: {
        bTrack: bTrackIndex,
        fromIn: args.toPosition,
        fromOut: args.toPosition + len - 1,
        toIn: srcPosition,
        toOut: srcPosition + len - 1,
      },
    });
  }

  // Reframe the delegated consequences as a MOVE, surfacing any real content the
  // destination overwrite destroyed (so a destructive drop is visible before render
  // — the lift's own source gap + shuffled dest blanks are mechanics, not losses).
  const c = noConsequences();
  c.clipsMoved.push({
    uuid: moved.id,
    from: { track: srcTrackId, position: srcPosition },
    to: { track: dst.track.id, position: args.toPosition },
  });
  for (const r of owRes.consequences.clipsRemoved) c.clipsRemoved.push(r);
  c.warnings.push(...liftRes.consequences.warnings, ...owRes.consequences.warnings);
  c.durationDelta = owRes.consequences.durationDelta; // lift is duration-neutral

  return {
    state: next,
    consequences: c,
    inverse: { op: "_compound", args: { steps } },
  };
}

// ─── Ripple: ripple-remove the source, ripple-insert the destination ──────────
/** Ripple-REMOVE the clip at the source (close the gap, pull content + other
 *  tracks left) then ripple-INSERT it at the destination (open a gap, push content
 *  + other tracks right). The destination position is in the POST-removal frame
 *  space (Shotcut's move computes the drop after the source gap closes). */
function moveRipple(
  next: Timeline,
  src: NonNullable<ReturnType<typeof findClip>>,
  dst: NonNullable<ReturnType<typeof findTrack>>,
  moved: Clip,
  len: number,
  args: MoveArgs,
  c: Consequences,
): void {
  // ── Vacate the source: drop the entry, ripple-close ──
  const srcTrack = next.tracks[src.trackKind][src.trackIndex] as Track;
  const dropped = [...srcTrack.items];
  dropped.splice(src.itemIndex, 1);
  srcTrack.items = consolidateBlanks(dropped);
  if (args.rippleAllTracks) {
    const notes = rippleOtherTracks(next, src.trackKind, src.trackIndex, src.position, len, -1);
    for (const n of notes) {
      if (n.blocked) {
        c.warnings.push({
          code: "ripple-blocked",
          detail: `track "${n.track}" holds content at frame ${n.from}; ripple-close left it in place`,
        });
      } else {
        c.ripple.push({ track: n.track, shift: n.shift, from: n.from });
      }
    }
  }

  // ── Place at the destination: insert the clip, ripple-open ──
  const dstTrack = next.tracks[dst.kind][dst.index] as Track;
  const { items: placed } = insertEntryAt(dstTrack.items, args.toPosition, structuredClone(moved));
  dstTrack.items = consolidateBlanks(placed);
  if (args.rippleAllTracks) {
    const notes = rippleOtherTracks(next, dst.kind, dst.index, args.toPosition, len, 1);
    for (const n of notes) {
      if (!n.blocked) c.ripple.push({ track: n.track, shift: n.shift, from: n.from });
    }
  }

  c.clipsRemoved.push({
    uuid: moved.id,
    track: src.trackId,
    position: src.position,
    playtime: len,
  });
  c.clipsAdded.push({
    uuid: moved.id,
    track: dstTrack.id,
    position: args.toPosition,
    playtime: len,
  });
}

export { moveArgs };

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { blank, clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<MoveArgs>[] = [
  {
    // NON-RIPPLE, cross-track, onto EMPTY space: the clean lossless regime. The
    // clip moves from V1 (where it sits between two others) onto V2 at a frame
    // past V2's content, so the overwrite stamps over nothing. The inverse
    // (move back) lifts it off V2 and overwrites it back into the V1 gap.
    name: "non-ripple move to another track's empty tail (overwrite stamps over nothing)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(30, "black"),
            clip("/abs/mid.mp4", { id: "mv", dur: 40, fadeIn: 8, fadeOut: 8 }),
            colorClip(30, "gold"),
          ),
          videoTrack(clip("/abs/v2.mp4", { id: "v2head", dur: 20 })),
        ],
      });
    },
    // V2 ends at frame 20; drop "mv" at frame 60 (past the end → padded blank +
    // append). Nothing on V2 is overwritten, so move-back is exact.
    args: {
      uuid: "mv",
      toTrack: { kind: "video", index: 1 },
      toPosition: 60,
      ripple: false,
      rippleAllTracks: false,
    },
  },
  {
    // NON-RIPPLE, same-track, into a BLANK gap: the clip hops over a blank to a
    // later empty slot on its own track. After the lift opens a blank where it
    // was, the overwrite lands in a downstream blank (stamps over nothing). The
    // inverse lifts it back and overwrites into the re-opened source blank.
    name: "non-ripple move on the same track into a downstream blank",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/a.mp4", { id: "mv", dur: 30 }),
            blank(80),
            clip("/abs/tail.mp4", { id: "tail", dur: 20 }),
          ),
        ],
      });
    },
    // "mv" plays [0,29]; the blank covers [30,109]. Drop it at frame 50 (inside the
    // blank, region [50,79] is pure blank). Nothing real is overwritten.
    args: {
      uuid: "mv",
      toTrack: { kind: "video", index: 0 },
      toPosition: 50,
      ripple: false,
      rippleAllTracks: false,
    },
  },
  {
    // RIPPLE move, same track, to the track tail: ripple-remove closes the source
    // gap, ripple-insert at the (post-removal) tail re-opens it. With a single
    // track and a tail drop, the round-trip is exact (the inverse ripple-removes
    // from the tail and ripple-inserts back at the origin).
    name: "ripple move to the track tail (close source gap, re-open at tail)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/a.mp4", { id: "mv", dur: 40 }),
            clip("/abs/b.mp4", { id: "b", dur: 50 }),
            clip("/abs/c.mp4", { id: "cc", dur: 30 }),
          ),
        ],
      });
    },
    // Remove "mv" (track was 120f → 80f), then insert at frame 80 (the new tail).
    args: {
      uuid: "mv",
      toTrack: { kind: "video", index: 0 },
      toPosition: 80,
      ripple: true,
      rippleAllTracks: false,
    },
  },
  {
    // RIPPLE move with rippleAllTracks, scoped to TRAILING emptiness on the other
    // track (the lossless cross-track regime, as in remove/insert's ripple
    // samples). The other track ends before both ripple seams, so the left-pull
    // (remove) and right-push (insert) only touch trailing blank — a no-op there
    // that the inverse reconstructs exactly.
    name: "ripple move with rippleAllTracks over trailing emptiness on the other track",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            blank(20),
            clip("/abs/a.mp4", { id: "mv", dur: 40 }),
            clip("/abs/b.mp4", { id: "b", dur: 30 }),
          ),
          videoTrack(clip("/abs/ov.mp4", { id: "ov", dur: 10 })),
        ],
      });
    },
    // "mv" plays [20,59]. Remove it (V1: 90f → 50f; seam at 20, other track ends at
    // 10 < 20 → trailing only). Insert at frame 50 (V1's new tail; seam at 50,
    // also past the other track's 10f). Round-trip exact.
    args: {
      uuid: "mv",
      toTrack: { kind: "video", index: 0 },
      toPosition: 50,
      ripple: true,
      rippleAllTracks: true,
    },
  },
  {
    // NON-RIPPLE move that OVERWRITES real content (the everyday drag onto an
    // occupied region — the case the old `regionIsBlank` reject refused). "mv" lifts
    // off the head, then stamps at frame 30, straddling the "victim" clip's start:
    // the destination [30,70) covers the lift blank AND the head 30f of "victim".
    // overwrite CAPTURES the whole covered span, so the `_compound` inverse restores
    // "victim" whole (uuid + fade) and puts "mv" back at frame 0 — an exact undo of a
    // DESTRUCTIVE move. This is what makes overwrite-on-collide safely reversible.
    name: "non-ripple move that overwrites content (captured-span inverse restores it)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/mv.mp4", { id: "mv", dur: 40 }),
            clip("/abs/victim.mp4", { id: "victim", dur: 40, fadeIn: 8 }),
          ),
        ],
      });
    },
    // "mv" [0,40), "victim" [40,80). Lift "mv" → [blank(40), victim]; overwrite "mv"
    // at 30 → [blank(30), mv(40), victim'(10)] (victim's head 30f is stamped over).
    // Undo restores victim whole + mv at 0.
    args: {
      uuid: "mv",
      toTrack: { kind: "video", index: 0 },
      toPosition: 30,
      ripple: false,
      rippleAllTracks: false,
    },
  },
  {
    // NON-RIPPLE cross-track move whose clip is LONGER than the space to the dest
    // track's end, so the delegated overwrite EXTENDS V2 past its old end. Exercises
    // the `footprint` inverse THROUGH move's `_compound` (regression: this used to
    // leave the moved clip's tail stranded on undo). "mv"(100) lifts off V1 and stamps
    // over "b" on V2 at frame 20, overhanging b's end.
    name: "non-ripple move onto content that EXTENDS the dest track (footprint inverse via compound)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/h.mp4", { id: "h", dur: 40 }),
            clip("/abs/mv.mp4", { id: "mv", dur: 100 }),
          ),
          videoTrack(clip("/abs/b.mp4", { id: "b", dur: 100, fadeOut: 6 })),
        ],
      });
    },
    // "mv"(100) → V2 at frame 20 over "b"(100): removes b's 80f tail, appends the
    // overhang. Undo restores b whole (with fade) and mv back on V1.
    args: {
      uuid: "mv",
      toTrack: { kind: "video", index: 1 },
      toPosition: 20,
      ripple: false,
      rippleAllTracks: false,
    },
  },
];
