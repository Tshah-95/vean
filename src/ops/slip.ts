// slip — slide a clip's SOURCE window without moving the clip on the track. The
// clip keeps the SAME track position and the SAME playtime; only the `[in, out]`
// window onto the producer shifts by `delta` frames (so the footage that plays in
// that screen slot changes, the slot itself does not). This is Shotcut's "slip"
// trim mode (`multitrackmodel.cpp` — slip adjusts in AND out by the same signed
// amount, leaving the playlist entry's length untouched).
//
// Args: { uuid, delta }. new in = in + delta; new out = out + delta. playtime
// (out - in + 1) and the timeline position are invariant — no neighbour blank
// grows, nothing ripples.
//
// Guards (the `…Valid` predicates, as VALUES — law #5):
//   • new in < 0 — would slip before the source's first frame.
//   • new out > length - 1 — would slip past the source's last frame (only when
//     `length` is known; a file clip with no probed length skips this ceiling,
//     like trimOut, since the bound is unknown).
//   • a COLOR clip (`service: "color"`) is POSITIONLESS — every frame is content-
//     identical and the serializer always emits it 0-based, so its in/out carry no
//     source meaning and a slip is meaningless. Mirroring trim.ts's treatment of a
//     color clip's window, slip rejects it with a typed precondition rather than
//     producing an in-memory window that diverges from the serialized 0-based form.
//
// Inverse: the SAME verb with `delta: -delta` (the scalar self-inverse). Slip is
// pure integer arithmetic on in/out with no neighbour interaction, so
// `slip(-δ) ∘ slip(δ)` is exactly the identity (contract law #2) — no captured data.
import { z } from "zod";
import type { Clip, Track } from "../ir/types";
import { cloneTimeline, findClip } from "./primitives";
import { type EditError, type Op, type OpResult, editError, noConsequences } from "./types";

/** slip — slide a clip's source window by `delta` frames (position + playtime
 *  unchanged). Defined here (not in `types.ts`) so the op file owns its schema,
 *  the same way split.ts owns `unsplitArgs`. */
export const slipArgs = z.object({
  uuid: z.string().min(1),
  /** Signed frames the source window slides. +δ advances both in and out (plays
   *  LATER source frames); −δ retreats them (plays EARLIER source frames). */
  delta: z.number().int(),
});
export type SlipArgs = z.infer<typeof slipArgs>;

export const slip: Op<SlipArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const { clip } = loc;
  const delta = args.delta;

  // A color generator is positionless — its in/out carry no source meaning (the
  // serializer always emits it 0-based), so sliding its window is meaningless.
  // trim.ts re-bases a color window 0-based by playtime because a trim still
  // changes the played COUNT; a slip changes neither count nor position, so the
  // only sane outcome is to refuse it (matching trim's "color window is canonical
  // 0-based" stance — there is nothing for slip to do on one).
  if (clip.service === "color") {
    return editError({
      kind: "precondition",
      detail: `slip: clip "${args.uuid}" is a color generator (positionless, content-identical at every frame); slipping its source window has no effect`,
    });
  }

  // ── Validate (the slip-window bounds) ──
  const newIn = clip.in + delta;
  if (newIn < 0) {
    return editError({
      kind: "frame-out-of-range",
      frame: newIn,
      bound: 0,
      detail: `slip: new in-point ${newIn} < 0 (source start) for clip "${args.uuid}"`,
    });
  }
  const newOut = clip.out + delta;
  // Can't slip the window past the source's last frame (only enforceable when the
  // source length is known — a file clip with no probed length has no ceiling,
  // matching trimOut's `clip.length != null` guard).
  if (clip.length != null && newOut > clip.length - 1) {
    return editError({
      kind: "frame-out-of-range",
      frame: newOut,
      bound: clip.length - 1,
      detail: `slip: new out-point ${newOut} > source length ${clip.length} (max ${clip.length - 1}) for clip "${args.uuid}"`,
    });
  }

  const next = cloneTimeline(state);
  const target = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items[loc.itemIndex] as Clip;
  // Slide the window; playtime (out - in + 1) is preserved because both edges move
  // by the same delta, and the timeline position is untouched (no item reorder, no
  // blank change). Source-windowed keyframe filters are NOT re-based: a slip moves
  // the clip's source origin AND its played span together by the same amount, so a
  // keyframe authored at a screen-local frame stays at that same screen-local frame
  // (unlike a head-trim, which moves the origin relative to the played window).
  target.in = newIn;
  target.out = newOut;

  const c = noConsequences();
  c.clipsTrimmed.push({
    uuid: clip.id,
    inDelta: delta,
    outDelta: delta,
    playtimeDelta: 0,
  });
  c.durationDelta = 0; // a slip moves no frames on the timeline

  return {
    state: next,
    consequences: c,
    inverse: { op: "slip", args: { uuid: args.uuid, delta: -delta } },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { blank, clip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { Timeline } from "../ir/types";
import type { OpSample } from "./types";

export const samples: OpSample<SlipArgs>[] = [
  {
    name: "slip a file clip forward (in + out advance by delta; position + playtime fixed)",
    state: (): Timeline => {
      resetIds();
      // A clip windowed [20, 99] (playtime 80) onto a 200-frame source, held at
      // timeline frame 30 by a leading blank.
      return timeline(VERTICAL, {
        video: [
          videoTrack(blank(30), clip("/abs/a.mp4", { id: "slipme", in: 20, out: 99, length: 200 })),
        ],
      });
    },
    // delta +15: window [20,99] → [35,114] (still within source 200), playtime 80
    // unchanged, the clip stays at frame 30. Inverse slip −15 restores [20,99].
    args: { uuid: "slipme", delta: 15 },
  },
  {
    name: "slip a file clip backward (delta < 0, window retreats but stays >= 0)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            blank(10),
            clip("/abs/b.mp4", { id: "slipback", in: 40, out: 89, length: 150 }),
          ),
        ],
      });
    },
    // delta -25: window [40,89] → [15,64], playtime 50 unchanged.
    args: { uuid: "slipback", delta: -25 },
  },
];
