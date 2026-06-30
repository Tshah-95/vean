// roll — move the CUT POINT between two adjacent same-track clips by `delta`
// frames, WITHOUT moving either clip's outer edges or changing total duration.
// This is the canonical NLE "roll edit" (Shotcut's two-headed trim of a junction;
// `multitrackmodel.cpp` reaches it as a `trimClipOut` on the left composed with a
// `trimClipIn` on the right, the two trims SHARING the seam frame).
//
// vean expresses it directly on the pure IR as that exact composition over one
// junction:
//   • left.out  += delta  (the left clip's tail extends/retracts by delta);
//   • right.in  += delta  (the right clip's head retracts/extends by delta).
// So `delta>0` slides the seam LATER (right): the left clip grows by delta, the
// right clip shrinks by delta. `delta<0` slides it EARLIER. Neither outer edge of
// the pair moves — the left clip's START is fixed and the right clip's END is
// fixed — and because the left grew by exactly what the right shrank, the seam (and
// every downstream item) stays put: total track duration is UNCHANGED. This is the
// difference from a NON-ripple trim, which grows/shrinks a neighbouring blank; a
// roll's "neighbour" IS the adjacent clip, which absorbs the change frame-for-frame.
//
// Frame mechanics mirror trim.ts (study `doTrim`):
//   • a FILE clip is windowed onto a producer, so the roll cannot push left.out
//     past the source end (`>= length`) or right.in below 0 / past its own out;
//   • a COLOR clip is POSITIONLESS — the serializer always emits it 0-based
//     (in=0, out=playtime-1, length=playtime), so a roll re-bases each color half's
//     window to 0-based by its new playtime (the form the serializer emits), keeping
//     the IR byte-identical to a serialize→reparse round-trip and the scalar inverse
//     exact. A color clip has no source ceiling — the only hard limit is leaving each
//     side at least one frame. (Same invariant trim's color branch enforces.)
//   • the left clip's local origin is FIXED (only its tail extends), so its
//     escape-hatch animated filters need no re-base; the right clip's origin moves
//     by +delta (its head advances), so its animated filters re-base by -delta —
//     exactly trimIn's head-trim re-base.
//
// Guards (typed EditErrors, never a throw — law #5): both uuids resolve to clips
// that are ADJACENT on the SAME track (right immediately follows left); the move
// fits both clips' windows; and NEITHER clip participates in a dissolve at the seam
// (a roll into a dissolve-bound junction would shorten the neighbour the nested
// lumaMix tractor depends on — mirror split/remove's dissolve guard).
//
// Inverse: roll with `delta: -delta` — the seam slides back by the same amount,
// re-growing the right and re-shrinking the left to the originals. Exact: roll is
// integer-frame arithmetic and perfectly symmetric (left +δ ↔ −δ, right +δ ↔ −δ),
// and a color half re-based 0-based on the way out re-bases back on the way in
// because playtime is conserved. So `roll(-δ)∘roll(δ)` is the identity (contract
// law #2) without any captured-data restore op.
import { z } from "zod";
import type { Clip, Timeline, Track } from "../ir/types";
import {
  cloneTimeline,
  dissolveConsumesAt,
  findClip,
  playtime,
  shiftClipAnimWindows,
} from "./primitives";
import {
  type EditError,
  type Op,
  type OpResult,
  editError,
  noConsequences,
  trackAddrSchema,
} from "./types";

/** roll — move the cut point between two adjacent same-track clips by `delta`
 *  frames. `delta>0` slides the seam later (left grows, right shrinks); `delta<0`
 *  earlier. Total track duration is unchanged. */
export const rollArgs = z.object({
  track: trackAddrSchema,
  leftUuid: z.string().min(1),
  rightUuid: z.string().min(1),
  /** Signed frames the seam moves. + = later (left grows, right shrinks). */
  delta: z.number().int(),
});
export type RollArgs = z.infer<typeof rollArgs>;

export const roll: Op<RollArgs> = (state, args): OpResult | EditError => {
  const left = findClip(state, args.leftUuid);
  if (!left) return editError({ kind: "clip-not-found", uuid: args.leftUuid });
  const right = findClip(state, args.rightUuid);
  if (!right) return editError({ kind: "clip-not-found", uuid: args.rightUuid });

  // Both clips must live on the SAME track, with `right` immediately following
  // `left` (a roll moves the junction between two adjacent clips).
  if (left.trackKind !== right.trackKind || left.trackIndex !== right.trackIndex) {
    return editError({
      kind: "precondition",
      detail: `roll: "${args.leftUuid}" and "${args.rightUuid}" are on different tracks (a roll moves the cut between two clips on one track)`,
    });
  }
  const items = (state.tracks[left.trackKind][left.trackIndex] as Track).items;

  // A DISSOLVE between the two clips: the junction is a nested lumaMix tractor the
  // serializer owns, and a `dissolve` marker sits BETWEEN them in the item run
  // (so they read as one item apart, not adjacent). Rolling such a junction would
  // shorten the neighbour the dissolve depends on (an unserializable state), so we
  // reject it BEFORE the plain-adjacency check — otherwise the user sees a
  // confusing "not adjacent" when the real reason is the dissolve. Mirror
  // split/remove's dissolve guard.
  const between = items[left.itemIndex + 1];
  if (
    (between?.kind === "dissolve" && right.itemIndex === left.itemIndex + 2) ||
    dissolveConsumesAt(items, left.itemIndex, "after") > 0 ||
    dissolveConsumesAt(items, right.itemIndex, "before") > 0
  ) {
    return editError({
      kind: "precondition",
      detail: `roll: the junction between "${args.leftUuid}" and "${args.rightUuid}" is a dissolve; roll it apart first`,
    });
  }

  if (right.itemIndex !== left.itemIndex + 1) {
    return editError({
      kind: "precondition",
      detail:
        `roll: "${args.rightUuid}" must immediately follow "${args.leftUuid}" ` +
        `on track "${left.trackId}" (they are not adjacent)`,
    });
  }

  // Resolve the track addr arg against the clips' actual track (a mismatch is a
  // caller error worth catching, not silently honoured) — mirrors dissolve.ts.
  if ("trackId" in args.track && args.track.trackId !== left.trackId) {
    return editError({
      kind: "precondition",
      detail: `roll: track arg "${args.track.trackId}" ≠ the clips' track "${left.trackId}"`,
    });
  }

  const delta = args.delta;
  if (delta === 0) {
    // A no-op roll still returns a valid (identity) result so callers can compose.
    return identityRoll(state, left, right, args);
  }

  const leftPositionless = left.clip.service === "color";
  const rightPositionless = right.clip.service === "color";

  // ── Validate the move fits both windows (mirror trimClipOut / trimClipIn) ──
  // LEFT grows on its TAIL by delta: new out = out + delta.
  const newLeftOut = left.clip.out + delta;
  if (leftPositionless) {
    // No source ceiling for a color clip — the only hard limit is leaving ≥ 1 frame.
    if (playtime(left.clip) + delta < 1) {
      return editError({
        kind: "frame-out-of-range",
        frame: playtime(left.clip) + delta,
        bound: 1,
        detail: `roll: moving by ${delta} would leave left color clip "${args.leftUuid}" < 1 frame`,
      });
    }
  } else {
    if (newLeftOut < left.clip.in) {
      return editError({
        kind: "frame-out-of-range",
        frame: newLeftOut,
        bound: left.clip.in,
        detail: `roll: new left out-point ${newLeftOut} < in ${left.clip.in} (would empty clip "${args.leftUuid}")`,
      });
    }
    // Can't extend the tail past the source length (matches trimOut's `>= length`).
    if (left.clip.length != null && newLeftOut >= left.clip.length) {
      return editError({
        kind: "frame-out-of-range",
        frame: newLeftOut,
        bound: left.clip.length - 1,
        detail: `roll: new left out-point ${newLeftOut} >= source length ${left.clip.length} for clip "${args.leftUuid}"`,
      });
    }
  }

  // RIGHT shrinks on its HEAD by delta: new in = in + delta.
  const newRightIn = right.clip.in + delta;
  if (rightPositionless) {
    if (playtime(right.clip) - delta < 1) {
      return editError({
        kind: "frame-out-of-range",
        frame: playtime(right.clip) - delta,
        bound: 1,
        detail: `roll: moving by ${delta} would leave right color clip "${args.rightUuid}" < 1 frame`,
      });
    }
  } else {
    if (newRightIn < 0) {
      return editError({
        kind: "frame-out-of-range",
        frame: newRightIn,
        bound: 0,
        detail: `roll: new right in-point ${newRightIn} < 0 (source start) for clip "${args.rightUuid}"`,
      });
    }
    if (newRightIn > right.clip.out) {
      return editError({
        kind: "frame-out-of-range",
        frame: newRightIn,
        bound: right.clip.out,
        detail: `roll: new right in-point ${newRightIn} > out ${right.clip.out} (would empty clip "${args.rightUuid}")`,
      });
    }
  }

  // ── Resize both halves on a private clone (purity boundary) ──
  const next = cloneTimeline(state);
  const nItems = (next.tracks[left.trackKind][left.trackIndex] as Track).items;
  const leftClip = nItems[left.itemIndex] as Clip;
  const rightClip = nItems[right.itemIndex] as Clip;

  // LEFT: tail extends by delta. Its local origin is FIXED, so its animated filters
  // are not re-based (only the window grew on the far end). A color clip re-bases to
  // canonical 0-based by its new playtime (the serializer's emitted form).
  if (leftPositionless) {
    const newLen = playtime(left.clip) + delta;
    leftClip.in = 0;
    leftClip.out = newLen - 1;
    leftClip.length = newLen;
  } else {
    leftClip.out = newLeftOut;
  }

  // RIGHT: head advances by delta. Its origin moves by +delta, so animated filters
  // re-base by -delta (a keyframe at old-local f is now at f-delta) — exactly
  // trimIn's head-trim re-base. A color clip re-bases to 0-based by its new playtime.
  if (rightPositionless) {
    const newLen = playtime(right.clip) - delta;
    rightClip.in = 0;
    rightClip.out = newLen - 1;
    rightClip.length = newLen;
  } else {
    rightClip.in = newRightIn;
    shiftClipAnimWindows(rightClip, -delta, playtime(rightClip));
  }

  // ── Consequences: both clips trimmed, no net duration change ──
  const c = noConsequences();
  c.clipsTrimmed.push({
    uuid: left.clip.id,
    inDelta: 0,
    outDelta: delta, // tail moved by +delta
    playtimeDelta: delta, // left grew by delta
  });
  c.clipsTrimmed.push({
    uuid: right.clip.id,
    inDelta: delta, // head moved by +delta
    outDelta: 0,
    playtimeDelta: -delta, // right shrank by delta
  });
  c.durationDelta = 0; // the seam moved; the track end did not

  return {
    state: next,
    consequences: c,
    inverse: { op: "roll", args: { ...args, delta: -delta } },
  };
};

/** An identity (delta=0) roll: a valid no-change result whose inverse is itself.
 *  Keeps the op total so a caller can pass a 0 delta without special-casing. */
function identityRoll(
  state: Timeline,
  left: NonNullable<ReturnType<typeof findClip>>,
  right: NonNullable<ReturnType<typeof findClip>>,
  args: RollArgs,
): OpResult {
  const next = cloneTimeline(state);
  const c = noConsequences();
  c.clipsTrimmed.push({ uuid: left.clip.id, inDelta: 0, outDelta: 0, playtimeDelta: 0 });
  c.clipsTrimmed.push({ uuid: right.clip.id, inDelta: 0, outDelta: 0, playtimeDelta: 0 });
  return {
    state: next,
    consequences: c,
    inverse: { op: "roll", args: { ...args, delta: 0 } },
  };
}

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { clip, colorClip, filter, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<RollArgs>[] = [
  {
    name: "roll a file-clip junction later (left grows, right shrinks, duration unchanged)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/a.mp4", { id: "L", in: 0, out: 89, length: 200 }),
            clip("/abs/b.mp4", { id: "R", in: 30, out: 119, length: 200 }),
          ),
        ],
      });
    },
    // delta +15: L out 89→104 (playtime 90→105), R in 30→45 (playtime 90→75).
    args: { track: { kind: "video", index: 0 }, leftUuid: "L", rightUuid: "R", delta: 15 },
  },
  {
    name: "roll a junction earlier (delta < 0 — left shrinks, right grows)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/a.mp4", { id: "L2", in: 10, out: 99, length: 200 }),
            clip("/abs/b.mp4", { id: "R2", in: 40, out: 129, length: 200 }),
          ),
        ],
      });
    },
    // delta -12: L out 99→87 (playtime 90→78), R in 40→28 (playtime 90→102).
    args: { track: { kind: "video", index: 0 }, leftUuid: "L2", rightUuid: "R2", delta: -12 },
  },
  {
    name: "roll where the RIGHT clip carries an escape-hatch animated filter (head re-bases, lossless)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/a.mp4", { id: "Lf", in: 0, out: 59, length: 300 }),
            clip("/abs/b.mp4", {
              id: "Rf",
              in: 0,
              out: 99,
              length: 300,
              filters: [filter("brightness", { level: "20=0.2;99=1" })],
            }),
          ),
        ],
      });
    },
    // delta +20: R in 0→20, its brightness keyframes re-base by -20 (20=… → 0=…, 99=… → 79=…).
    // Earliest keyframe sits at frame 20 (≥ delta) so it stays in-window and the inverse
    // reconstructs it byte-for-byte — the lossless regime the round-trip law holds over,
    // exactly like trimOut's animated-filter sample (a head re-base that drops an
    // out-of-window keyframe is forward-only behaviour, asserted in tests/ops-roll.test.ts).
    args: { track: { kind: "video", index: 0 }, leftUuid: "Lf", rightUuid: "Rf", delta: 20 },
  },
  {
    name: "roll a COLOR-clip junction — both halves re-base 0-based by playtime",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(colorClip(50, "gold", { id: "Lc" }), colorClip(50, "blue", { id: "Rc" })),
        ],
      });
    },
    // delta +10: Lc playtime 50→60 (window 0-based), Rc playtime 50→40 (window 0-based).
    args: { track: { kind: "video", index: 0 }, leftUuid: "Lc", rightUuid: "Rc", delta: 10 },
  },
];
