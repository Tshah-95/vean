// dissolve (same-track transition) — overlap two ADJACENT clips by `frames` into
// a same-track cross-fade. In Shotcut (`multitrackmodel.cpp::addTransition` for a
// same-track mix) this materializes a nested tractor (track0 = outgoing tail cut,
// track1 = incoming head cut) carrying a `luma` video dissolve + a `mix` audio
// cross-fade over [0, frames-1], tagged with a `<property
// name="shotcut:transition">lumaMix</property>` CHILD (never a namespaced
// attribute — that is the whole Shotcut-openability invariant). The neighbours
// are shortened by `frames`.
//
// vean carries that as the first-class `Dissolve` IR marker (`builder.ts::dissolve`)
// inserted BETWEEN the two clips. Crucially, in the IR the neighbour clips stay at
// FULL length — the serializer (`serialize.ts`) owns the overlap: it trims
// `frames` off the preceding clip's tail and the following clip's head into the
// nested lumaMix tractor (see `serialize.ts` lines ~471-538), and `validateTrack`
// guarantees each neighbour is long enough. So this op's whole job is: confirm the
// two clips are adjacent on one track, validate the overlap fits both (accounting
// for any dissolve they ALREADY participate in), and splice the marker between
// them. No clip mutation — the marker IS the edit.
//
// Guards (mirror the serializer's `validateTrack`, surfaced as typed EditErrors so
// the op never throws): both uuids resolve to clips, they are adjacent on the SAME
// track in left→right order, and `frames` ≤ each neighbour's REMAINING playtime
// (full playtime minus what an existing adjacent dissolve already consumes on that
// side) → `dissolve-too-long` with the offending side.
//
// Inverse: `_removeDissolve` — drop the marker between the two named clips,
// restoring the pre-dissolve item run exactly (a self-contained captured-data
// restore, mirroring split's `_unsplit`; the user-facing `removeDissolve` lands in
// Move 1b and this is its specialization). Its own inverse is `dissolve` of the
// same two clips by the same frames, so undo-of-undo round-trips.
import { z } from "zod";
import type { Dissolve, Item, Timeline, Track } from "../ir/types";
import {
  type ClipLocation,
  cloneTimeline,
  dissolveConsumesAt,
  findClip,
  playtime,
} from "./primitives";
import {
  type DissolveArgs,
  type EditError,
  type Op,
  type OpResult,
  editError,
  noConsequences,
} from "./types";

export const dissolve: Op<DissolveArgs> = (state, args): OpResult | EditError => {
  const left = findClip(state, args.leftUuid);
  if (!left) return editError({ kind: "clip-not-found", uuid: args.leftUuid });
  const right = findClip(state, args.rightUuid);
  if (!right) return editError({ kind: "clip-not-found", uuid: args.rightUuid });

  // Both clips must live on the SAME track, with `right` immediately following
  // `left` (a same-track dissolve sits between two adjacent clips).
  if (left.trackKind !== right.trackKind || left.trackIndex !== right.trackIndex) {
    return editError({
      kind: "precondition",
      detail: `dissolve: "${args.leftUuid}" and "${args.rightUuid}" are on different tracks (a same-track dissolve needs two clips on one track)`,
    });
  }
  if (right.itemIndex !== left.itemIndex + 1) {
    return editError({
      kind: "precondition",
      detail:
        `dissolve: "${args.rightUuid}" must immediately follow "${args.leftUuid}" ` +
        `on track "${left.trackId}" (they are not adjacent)`,
    });
  }

  // Resolve the track addr arg against the clips' actual track (a mismatch is a
  // caller error worth catching, not silently honoured).
  if ("trackId" in args.track && args.track.trackId !== left.trackId) {
    return editError({
      kind: "precondition",
      detail: `dissolve: track arg "${args.track.trackId}" ≠ the clips' track "${left.trackId}"`,
    });
  }

  const items = (state.tracks[left.trackKind][left.trackIndex] as Track).items;
  // Each neighbour's REMAINING playtime on the side facing the new dissolve: the
  // serializer trims this dissolve off `left`'s tail and `right`'s head, and any
  // dissolve already on the OTHER side of each has claimed frames there too.
  const leftRemaining = playtime(left.clip) - dissolveConsumesAt(items, left.itemIndex, "before");
  const rightRemaining = playtime(right.clip) - dissolveConsumesAt(items, right.itemIndex, "after");
  if (args.frames > leftRemaining) {
    return editError({
      kind: "dissolve-too-long",
      frames: args.frames,
      neighbour: leftRemaining,
      side: "out",
    });
  }
  if (args.frames > rightRemaining) {
    return editError({
      kind: "dissolve-too-long",
      frames: args.frames,
      neighbour: rightRemaining,
      side: "in",
    });
  }

  const next = cloneTimeline(state);
  const nItems = (next.tracks[left.trackKind][left.trackIndex] as Track).items;
  const marker: Dissolve = { kind: "dissolve", frames: args.frames, luma: args.luma };
  // Splice the marker between left (itemIndex) and right (itemIndex+1).
  nItems.splice(left.itemIndex + 1, 0, marker);

  const c = noConsequences();
  // The overlap is shared frames: the two clips that summed to L+R now play
  // L+R-frames on the timeline (the dissolve eats `frames` of total length).
  c.durationDelta = -args.frames;
  // Report both neighbours as trimmed by the overlap (their solo entries shrink;
  // identities are unchanged — the marker carries the blended region).
  c.clipsTrimmed.push(
    { uuid: args.leftUuid, inDelta: 0, outDelta: -args.frames, playtimeDelta: -args.frames },
    { uuid: args.rightUuid, inDelta: args.frames, outDelta: 0, playtimeDelta: -args.frames },
  );

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_removeDissolve",
      args: {
        track: { trackId: left.trackId },
        leftUuid: args.leftUuid,
        rightUuid: args.rightUuid,
      },
    },
  };
};

export { dissolveArgs } from "./types";

// ─── The internal inverse op (remove a dissolve marker) ───────────────────────
// Drop the `Dissolve` marker sitting BETWEEN the two named clips, restoring the
// pre-dissolve item run. Self-contained (no dependency on a Move-1b
// `removeDissolve`) so dissolve's inverse-invariant passes now. Its own inverse is
// `dissolve` of the two clips by the removed `frames`, so undo-of-undo round-trips.
export const removeDissolveArgs = z.object({
  track: z.object({ trackId: z.string().min(1) }),
  leftUuid: z.string().min(1),
  rightUuid: z.string().min(1),
});
export type RemoveDissolveArgs = z.infer<typeof removeDissolveArgs>;

export const removeDissolve: Op<RemoveDissolveArgs> = (state, args): OpResult | EditError => {
  const left = findClip(state, args.leftUuid);
  if (!left) return editError({ kind: "clip-not-found", uuid: args.leftUuid });
  if (left.trackId !== args.track.trackId) {
    return editError({
      kind: "precondition",
      detail: `_removeDissolve: clip "${args.leftUuid}" is on track "${left.trackId}", expected "${args.track.trackId}"`,
    });
  }
  const items = (state.tracks[left.trackKind][left.trackIndex] as Track).items;
  const mid = items[left.itemIndex + 1] as Item | undefined;
  const right = items[left.itemIndex + 2] as Item | undefined;
  if (!mid || mid.kind !== "dissolve") {
    return editError({
      kind: "precondition",
      detail: `_removeDissolve: no dissolve marker follows "${args.leftUuid}" on track "${args.track.trackId}"`,
    });
  }
  if (!right || right.kind !== "clip" || right.id !== args.rightUuid) {
    return editError({
      kind: "precondition",
      detail: `_removeDissolve: dissolve must sit between "${args.leftUuid}" and "${args.rightUuid}"`,
    });
  }
  const frames = mid.frames;
  const luma = mid.luma;

  const next = cloneTimeline(state);
  const loc = findClip(next, args.leftUuid) as ClipLocation;
  const nItems = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  nItems.splice(loc.itemIndex + 1, 1); // drop the dissolve marker

  const c = noConsequences();
  c.durationDelta = frames; // removing the overlap restores the shared frames
  c.clipsTrimmed.push(
    { uuid: args.leftUuid, inDelta: 0, outDelta: frames, playtimeDelta: frames },
    { uuid: args.rightUuid, inDelta: -frames, outDelta: 0, playtimeDelta: frames },
  );

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "dissolve",
      args: {
        track: { trackId: loc.trackId },
        leftUuid: args.leftUuid,
        rightUuid: args.rightUuid,
        frames,
        luma,
      },
    },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { audioTrack, clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<DissolveArgs>[] = [
  {
    name: "dissolve two adjacent color clips on one video track",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(colorClip(60, "gold", { id: "left" }), colorClip(60, "blue", { id: "right" })),
        ],
      });
    },
    args: {
      track: { kind: "video", index: 0 },
      leftUuid: "left",
      rightUuid: "right",
      frames: 20,
      luma: "luma",
    },
  },
  {
    name: "dissolve two adjacent file clips on an audio track (mix cross-fade)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        audio: [
          audioTrack(
            clip("/abs/a.wav", { id: "left", dur: 90 }),
            clip("/abs/b.wav", { id: "right", dur: 90 }),
          ),
        ],
      });
    },
    args: {
      track: { kind: "audio", index: 0 },
      leftUuid: "left",
      rightUuid: "right",
      frames: 15,
      luma: "luma",
    },
  },
  {
    name: "dissolve neighbours that each already fade at their outer edge",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(80, "gold", { id: "left", fadeIn: 10 }),
            colorClip(80, "blue", { id: "right", fadeOut: 10 }),
          ),
        ],
      });
    },
    args: {
      track: { kind: "video", index: 0 },
      leftUuid: "left",
      rightUuid: "right",
      frames: 24,
      luma: "luma",
    },
  },
];
