// split — cut the clip `uuid` at timeline `frame` into two clips. The trickiest
// reference op: it drives `splitEntryAt`, including the fade-direction filter
// deletion that makes split the canonical consumer of the keyframe-representation
// decision (DESIGN-MOVE1.md §3, §4).
//
// Shotcut semantics (`multitrackmodel.cpp::splitClip`): clone the producer,
// insert the clone for the LEFT window `[in, in+duration-1]`, resize the original
// to the RIGHT window `[in+duration, out]`, DELETE fadeOut* filters from the left
// half and fadeIn* filters from the right half, and shift clip-attached filter
// (fade/keyframe) windows by the split delta. vean mirrors this on the pure IR:
//   • left half  = fresh uuid, window [in, in+local-1], fadeOut sentinels dropped;
//   • right half = ORIGINAL uuid, window [in+local, out], fadeIn sentinels dropped.
// Fades are integer-frame SENTINELS in the IR (not raw keyframes — decision #1),
// so the serializer owns the keyframe math and split needs no keyframe string
// surgery for them; a combined fade lands as left-fadeIn + right-fadeOut, exactly
// the proven shape.
//
// Inverse: re-merge the two halves into the original clip (`join`). `join` ships
// as a stub in this Move, so split's inverse is the self-contained `_unsplit`
// restore op (registered here): it removes the two halves and splices the
// captured original clip back, restoring its uuid + dropped fades. When `join`
// lands, split's inverse switches to the symmetric `join` invocation.
import { z } from "zod";
import { clipSchema } from "../ir/types";
import type { Clip, Item, Timeline, Track } from "../ir/types";
import {
  type ClipLocation,
  cloneTimeline,
  dissolveConsumesAt,
  findClip,
  playtime,
  splitEntryAt,
  trackItems,
} from "./primitives";
import {
  type EditError,
  type Op,
  type OpResult,
  type SplitArgs,
  type Uuid,
  editError,
  noConsequences,
  splitArgs,
} from "./types";

export const split: Op<SplitArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const local = args.frame - loc.position; // frames into the clip's played window
  const len = playtime(loc.clip);
  if (local <= 0 || local >= len) {
    return editError({
      kind: "split-at-boundary",
      frame: args.frame,
      detail:
        `split point ${args.frame} is at a boundary of clip "${args.uuid}" ` +
        `(plays [${loc.position}, ${loc.position + len - 1}]); nothing to split`,
    });
  }

  // If this clip participates in a dissolve, the split must leave each
  // dissolve-facing half AT LEAST as long as the dissolve it borders — otherwise
  // the serializer's validateTrack rejects the state (dissolve longer than its
  // clip). `local` is the head's solo length; `len - local` is the tail's.
  const srcItems = (state.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  const dHead = dissolveConsumesAt(srcItems, loc.itemIndex, "before"); // dissolve on the head edge
  const dTail = dissolveConsumesAt(srcItems, loc.itemIndex, "after"); // dissolve on the tail edge
  if (dHead > 0 && local < dHead) {
    return editError({
      kind: "precondition",
      detail: `split: head half (${local}f) would be shorter than its dissolve (${dHead}f) on clip "${args.uuid}"`,
    });
  }
  if (dTail > 0 && len - local < dTail) {
    return editError({
      kind: "precondition",
      detail: `split: tail half (${len - local}f) would be shorter than its dissolve (${dTail}f) on clip "${args.uuid}"`,
    });
  }

  // Capture the pre-split clip for the inverse BEFORE mutating.
  const original: Clip = structuredClone(loc.clip);

  const next = cloneTimeline(state);
  const items = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  const { items: split2, leftUuid, rightUuid } = splitEntryAt(items, loc.itemIndex, local);
  (next.tracks[loc.trackKind][loc.trackIndex] as Track).items = split2;

  const leftClip = split2[loc.itemIndex] as Extract<Item, { kind: "clip" }>;
  const rightClip = split2[loc.itemIndex + 1] as Extract<Item, { kind: "clip" }>;

  const c = noConsequences();
  // The original (its uuid survives on the right) is trimmed to the tail window…
  c.clipsTrimmed.push({
    uuid: original.id,
    inDelta: rightClip.in - original.in, // + (later start)
    outDelta: 0,
    playtimeDelta: playtime(rightClip) - len, // negative
  });
  // …and a new clip (the head) is added.
  c.clipsAdded.push({
    uuid: leftClip.id,
    track: loc.trackId,
    position: loc.position,
    playtime: playtime(leftClip),
  });
  c.durationDelta = 0; // a split moves no frames on the timeline

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_unsplit",
      args: {
        track: { trackId: loc.trackId },
        leftUuid: leftUuid as Uuid,
        rightUuid: rightUuid as Uuid,
        original,
      },
    },
  };
};

// ─── The internal inverse op (re-merge the two split halves) ──────────────────
// Removes the two adjacent halves (left then right, identified by uuid) and
// splices the captured `original` clip back at that position, restoring its uuid,
// window, and the fades split dropped. Self-contained (no dependency on `join`)
// so split's inverse-invariant passes now. Its own inverse is `split` of the
// original at the boundary the two halves met, so undo-of-undo round-trips.
export const unsplitArgs = z.object({
  track: z.object({ trackId: z.string().min(1) }),
  leftUuid: z.string().min(1),
  rightUuid: z.string().min(1),
  original: clipSchema,
});
export type UnsplitArgs = z.infer<typeof unsplitArgs>;

export const unsplit: Op<UnsplitArgs> = (state, args): OpResult | EditError => {
  // Locate the left half (the right half must immediately follow it).
  const left = findClip(state, args.leftUuid);
  if (!left) return editError({ kind: "clip-not-found", uuid: args.leftUuid });
  const items = trackItems(state, left.trackKind, left.trackIndex);
  const rightItem = items[left.itemIndex + 1] as Item | undefined;
  if (!rightItem || rightItem.kind !== "clip" || rightItem.id !== args.rightUuid) {
    return editError({
      kind: "precondition",
      detail: `_unsplit: clip "${args.rightUuid}" must immediately follow "${args.leftUuid}"`,
    });
  }
  if (left.trackId !== args.track.trackId) {
    return editError({
      kind: "precondition",
      detail: `_unsplit: halves are on track "${left.trackId}", expected "${args.track.trackId}"`,
    });
  }

  // The frame where the two halves meet (the original split point) — for the
  // inverse-of-inverse (a `split` invocation).
  const splitFrame = left.position + playtime(left.clip);

  const next = cloneTimeline(state);
  const loc = findClip(next, args.leftUuid) as ClipLocation;
  const nItems = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  // Replace the two halves with the captured original.
  nItems.splice(loc.itemIndex, 2, structuredClone(args.original));

  const c = noConsequences();
  c.clipsRemoved.push({
    uuid: args.leftUuid,
    track: loc.trackId,
    position: loc.position,
    playtime: playtime(left.clip),
  });
  c.clipsAdded.push({
    uuid: args.original.id,
    track: loc.trackId,
    position: loc.position,
    playtime: playtime(args.original),
  });
  c.durationDelta = 0;

  return {
    state: next,
    consequences: c,
    inverse: { op: "split", args: { uuid: args.original.id, frame: splitFrame } },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { clip, colorClip, filter, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<SplitArgs>[] = [
  {
    name: "split a color clip with a combined fadeIn+fadeOut (head keeps fadeIn, tail keeps fadeOut)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(60, "gold", { id: "splitme", fadeIn: 10, fadeOut: 10 }))],
      });
    },
    // Clip plays [0,59]; split at frame 30 → left [0,29], right [30,59].
    args: { uuid: "splitme", frame: 30 },
  },
  {
    name: "split a file clip carrying an escape-hatch animated filter",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(20, "black"),
            clip("/abs/scene.mp4", {
              id: "filtered",
              dur: 80,
              filters: [filter("brightness", { level: "0=0.2;79=1" })],
            }),
          ),
        ],
      });
    },
    // The file clip starts at timeline frame 20, plays [20,99]; split at 60.
    args: { uuid: "filtered", frame: 60 },
  },
];
