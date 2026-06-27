// lift — replace a clip with a same-length blank (leave a gap, do NOT ripple).
//
// Shotcut semantics (`multitrackmodel.cpp::liftClip`): replace the clip's entry
// with a BLANK of equal length, then consolidate adjacent blanks. The clip's
// content is removed but the timing of everything after it is unchanged — a hole
// opens where the clip was.
//
// vean mirrors this on the pure IR: locate the clip, swap its `items[]` entry for
// a `blank` of `playtime(clip)` frames, then `consolidateBlanks` (which merges the
// new gap with any neighbouring blanks and drops it entirely if it became
// trailing). The captured clip + its frame position ride into the inverse.
//
// Inverse: `_unlift({ track, position, clip })` — re-open the gap at `position`
// (splitting the merged blank back out, or re-creating a trailing blank the
// consolidation dropped) and splice the captured clip in. Self-contained (no
// dependency on a future op) so lift's inverse-invariant passes now.
import { z } from "zod";
import { clipSchema } from "../ir/types";
import type { Item, Timeline, Track } from "../ir/types";
import {
  blankItem,
  clipTouchesDissolve,
  cloneTimeline,
  consolidateBlanks,
  findClip,
  findTrack,
  itemIndexAt,
  playtime,
  splitEntryAt,
  startOf,
  trackLength,
} from "./primitives";
import {
  type EditError,
  type LiftArgs,
  type Op,
  type OpResult,
  editError,
  noConsequences,
} from "./types";

export const lift: Op<LiftArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  // Lifting a clip in a dissolve would leave a dangling marker; reject (the user
  // must remove the dissolve first, as Shotcut tears down the transition on lift).
  const srcItems = (state.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  if (clipTouchesDissolve(srcItems, loc.itemIndex)) {
    return editError({
      kind: "precondition",
      detail: `lift: clip "${args.uuid}" participates in a dissolve — remove the dissolve first`,
    });
  }

  const lifted: Item = structuredClone(loc.clip);
  const len = playtime(loc.clip);

  const next = cloneTimeline(state);
  const track = next.tracks[loc.trackKind][loc.trackIndex] as Track;
  // Swap the clip entry for a same-length blank, then merge adjacent blanks.
  const replaced = [...track.items];
  replaced.splice(loc.itemIndex, 1, blankItem(len));
  track.items = consolidateBlanks(replaced);

  const c = noConsequences();
  c.clipsRemoved.push({
    uuid: loc.clip.id,
    track: loc.trackId,
    position: loc.position,
    playtime: len,
  });
  // A blank of `len` is created at the clip's old position (it may have merged
  // with neighbours, but the load-bearing fact is a gap of `len` opened here).
  c.blanksCreated.push({ track: loc.trackId, position: loc.position, length: len });
  c.durationDelta = 0; // lift leaves a gap — total timeline length is unchanged

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_unlift",
      args: { track: { trackId: loc.trackId }, position: loc.position, clip: lifted },
    },
  };
};

// ─── The internal inverse op (re-fill the lifted blank with the captured clip) ─
// Re-opens the gap at `position` and splices the captured clip back. Because lift
// consolidated blanks, the gap at `position` is some run of blank that may be
// longer than the clip (merged with neighbours) or absent (the clip was trailing,
// so consolidate dropped it). `_unlift` handles both: it pads the track up to
// `position` if needed, then carves `playtime(clip)` frames out of the blank
// there and drops the clip into the carved slot — restoring the exact pre-lift
// items[] (uuid, window, filters, and the surrounding blanks unchanged).
export const unliftArgs = z.object({
  track: z.object({ trackId: z.string().min(1) }),
  position: z.number().int().nonnegative(),
  clip: clipSchema,
});
export type UnliftArgs = z.infer<typeof unliftArgs>;

export const unlift: Op<UnliftArgs> = (state, args): OpResult | EditError => {
  const tloc = findTrack(state, args.track);
  if (!tloc) return editError({ kind: "track-not-found", track: args.track.trackId });

  const next = cloneTimeline(state);
  const items = (next.tracks[tloc.kind][tloc.index] as Track).items;
  const len = playtime(args.clip);

  let work: Item[] = [...items];
  const end = trackLength(work);

  if (args.position >= end) {
    // The lift dropped a trailing gap; re-pad up to `position` then place the clip.
    if (args.position > end) work.push(blankItem(args.position - end));
    work.push(structuredClone(args.clip));
  } else {
    // Carve `len` frames out of the blank covering `position`. After lift's
    // consolidation the covering item at `position` is always a blank ≥ `len`.
    const idx = itemIndexAt(work, args.position);
    const boundary = startOf(work, idx);
    let slotIdx = idx;
    if (args.position > boundary) {
      // Split the blank so `position` lands on a boundary; the slot is the right part.
      work = splitEntryAt(work, idx, args.position - boundary).items;
      slotIdx = idx + 1;
    }
    const slot = work[slotIdx] as Item;
    if (slot.kind !== "blank") {
      return editError({
        kind: "precondition",
        detail: `_unlift: expected a blank at position ${args.position} on track "${args.track.trackId}"`,
      });
    }
    if (slot.length < len) {
      return editError({
        kind: "precondition",
        detail: `_unlift: blank at ${args.position} is ${slot.length}f, need ${len}f for the clip`,
      });
    }
    const remainder = slot.length - len;
    const replacement: Item[] = [structuredClone(args.clip)];
    if (remainder > 0) replacement.push(blankItem(remainder));
    work.splice(slotIdx, 1, ...replacement);
  }
  (next.tracks[tloc.kind][tloc.index] as Track).items = consolidateBlanks(work);

  const c = noConsequences();
  c.clipsAdded.push({
    uuid: args.clip.id,
    track: args.track.trackId,
    position: args.position,
    playtime: len,
  });
  c.blanksRemoved.push({ track: args.track.trackId, position: args.position, length: len });
  c.durationDelta = 0;

  return {
    state: next,
    consequences: c,
    inverse: { op: "lift", args: { uuid: args.clip.id } },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { blank, clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<LiftArgs>[] = [
  {
    name: "lift a clip sitting between two others (a real gap opens)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(30, "black"),
            clip("/abs/mid.mp4", { id: "liftme", dur: 40, fadeIn: 8, fadeOut: 8 }),
            colorClip(30, "gold"),
          ),
        ],
      });
    },
    args: { uuid: "liftme" },
  },
  {
    name: "lift the LAST clip (gap is trailing → consolidate drops it; unlift re-pads)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(colorClip(30, "black"), clip("/abs/tail.mp4", { id: "liftme", dur: 50 })),
        ],
      });
    },
    args: { uuid: "liftme" },
  },
  {
    name: "lift a clip adjacent to an existing blank (the new gap merges, unlift re-carves)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(20, "black"),
            blank(15),
            clip("/abs/after-gap.mp4", { id: "liftme", dur: 35 }),
            colorClip(25, "gold"),
          ),
        ],
      });
    },
    args: { uuid: "liftme" },
  },
];
