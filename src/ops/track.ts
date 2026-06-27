// addTrack / removeTrack — add or remove a playlist track on the tractor. Both
// verbs live here (they share the track-list mechanics) and register separately
// ("addTrack" / "removeTrack").
//
// Shotcut semantics (`multitrackmodel.cpp::addVideoTrack` / `addAudioTrack` /
// `removeTrack`): a track is a `<playlist>` behind the main tractor. VIDEO tracks
// PREPEND (the top of the stack = front of compositing); AUDIO tracks APPEND. In
// vean's IR a track is an entry in `tracks.video[]` / `tracks.audio[]`:
//   • addTrack(video) → UNSHIFT a fresh empty video track (front of the video
//     list = top of compositing);
//   • addTrack(audio) → PUSH a fresh empty audio track;
//   • removeTrack → drop the resolved track, CAPTURING its content + kind + index
//     within its kind's list, so the inverse re-adds it exactly where it was.
//
// Index note: field transitions reference tracks by integer index across
// [...video, ...audio]; add/removeTrack shifts those indices. Move 1a does the
// structural add/remove + a clean inverse and emits a WARNING when transitions
// are present (a full re-index pass is Move 1b). With no transitions the warning
// is absent and the op is pure structure.
//
// Inverse: addTrack ↔ removeTrack. addTrack mints a track id and captures it, so
// its inverse is removeTrack of THAT track. removeTrack captures the whole track
// (content + index + kind); since the public addTrack can only create an EMPTY
// track at the prepend/append slot, removeTrack's inverse is the internal
// `_restoreTrack` op, which splices the captured track back at its exact index.
import { z } from "zod";
import { uuid } from "../ir/builder";
import { trackSchema } from "../ir/types";
import type { Timeline, Track, TrackKind } from "../ir/types";
import { cloneTimeline, findTrack } from "./primitives";
import {
  type AddTrackArgs,
  type EditError,
  type Op,
  type OpResult,
  type RemoveTrackArgs,
  type Warning,
  addTrackArgs,
  editError,
  noConsequences,
  removeTrackArgs,
} from "./types";

/** A fresh empty track of `kind` with a runtime-unique id (and optional name).
 *  Audio tracks are hidden video (`hidden: true`), matching the builder. */
function emptyTrack(kind: TrackKind, id: string, name?: string): Track {
  const t: Track = { kind, id, items: [] };
  if (name != null) t.name = name;
  if (kind === "audio") t.hidden = true;
  return t;
}

/** A warning iff the timeline carries field transitions (their integer track
 *  indices shift when a track is added/removed; a re-index pass is Move 1b). */
function reindexWarning(state: Timeline): Warning[] {
  if (state.transitions.length === 0) return [];
  return [
    {
      code: "track-add-remove-shifts-transition-indices",
      detail: `${state.transitions.length} field transition(s) reference tracks by integer index; adding/removing a track shifts those indices (re-index pass lands in Move 1b)`,
    },
  ];
}

export const addTrack: Op<AddTrackArgs> = (state, args): OpResult | EditError => {
  const id = args.id ?? uuid();
  const track = emptyTrack(args.kind, id, args.name);

  const next = cloneTimeline(state);
  if (args.kind === "video") {
    next.tracks.video.unshift(track); // video PREPENDS (top of compositing)
  } else {
    next.tracks.audio.push(track); // audio APPENDS
  }

  const c = noConsequences();
  c.warnings.push(...reindexWarning(next));

  return {
    state: next,
    consequences: c,
    // Drop the track we just created (it's empty, so a plain removeTrack restores).
    inverse: { op: "removeTrack", args: { track: { trackId: id } } },
  };
};

export const removeTrack: Op<RemoveTrackArgs> = (state, args): OpResult | EditError => {
  const loc = findTrack(state, args.track);
  if (!loc) {
    const track =
      "trackId" in args.track ? args.track.trackId : `${args.track.kind}[${args.track.index}]`;
    return editError({ kind: "track-not-found", track });
  }

  // Capture the whole track (content + kind + index) BEFORE mutating.
  const captured: Track = structuredClone(loc.track);
  const kind = loc.kind;
  const index = loc.index;

  const next = cloneTimeline(state);
  next.tracks[kind].splice(index, 1);

  const c = noConsequences();
  // Report every clip the removed track carried as removed content.
  let pos = 0;
  for (const it of captured.items) {
    if (it.kind === "clip") {
      c.clipsRemoved.push({
        uuid: it.id,
        track: captured.id,
        position: pos,
        playtime: it.out - it.in + 1,
      });
      pos += it.out - it.in + 1;
    } else if (it.kind === "blank") {
      pos += it.length;
    } else {
      pos += it.frames;
    }
  }
  c.warnings.push(...reindexWarning(state));

  return {
    state: next,
    consequences: c,
    // Splice the captured track back at its exact (kind, index).
    inverse: { op: "_restoreTrack", args: { kind, index, track: captured } },
  };
};

export { addTrackArgs, removeTrackArgs };

// ─── The internal inverse op (re-add a captured track at its index) ───────────
// Splices the captured `track` back into `tracks[kind]` at `index`, restoring the
// content + position a `removeTrack` dropped. Self-contained (no dependency on
// addTrack's prepend/append semantics, which can't target an arbitrary index).
// Its own inverse is `removeTrack` of that track, so undo-of-undo round-trips.
export const restoreTrackArgs = z.object({
  kind: z.enum(["video", "audio"]),
  index: z.number().int().nonnegative(),
  track: trackSchema,
});
export type RestoreTrackArgs = z.infer<typeof restoreTrackArgs>;

export const restoreTrack: Op<RestoreTrackArgs> = (state, args): OpResult | EditError => {
  const list = state.tracks[args.kind];
  if (args.index < 0 || args.index > list.length) {
    return editError({
      kind: "frame-out-of-range",
      frame: args.index,
      bound: list.length,
      detail: `_restoreTrack: index ${args.index} is out of range for ${args.kind} tracks (${list.length})`,
    });
  }

  const next = cloneTimeline(state);
  next.tracks[args.kind].splice(args.index, 0, structuredClone(args.track));

  const c = noConsequences();
  let pos = 0;
  for (const it of args.track.items) {
    if (it.kind === "clip") {
      c.clipsAdded.push({
        uuid: it.id,
        track: args.track.id,
        position: pos,
        playtime: it.out - it.in + 1,
      });
      pos += it.out - it.in + 1;
    } else if (it.kind === "blank") {
      pos += it.length;
    } else {
      pos += it.frames;
    }
  }
  c.warnings.push(...reindexWarning(next));

  return {
    state: next,
    consequences: c,
    inverse: { op: "removeTrack", args: { track: { trackId: args.track.id } } },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { audioTrack, clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samplesAddTrack: OpSample<AddTrackArgs>[] = [
  {
    name: "add a video track (prepends to the top of compositing)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(60, "gold", { id: "v" }))],
      });
    },
    // Explicit id so the sample is deterministic; inverse removeTrack drops it.
    args: { kind: "video", id: "new-video", name: "V2" },
  },
  {
    name: "add an audio track (appends)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(60, "gold", { id: "v2" }))],
        audio: [audioTrack(clip("/abs/vo.wav", { id: "a", dur: 60 }))],
      });
    },
    args: { kind: "audio", id: "new-audio" },
  },
];

export const samplesRemoveTrack: OpSample<RemoveTrackArgs>[] = [
  {
    name: "remove a populated audio track (content captured + restored by the inverse)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(60, "gold", { id: "v3" }))],
        audio: [audioTrack(clip("/abs/vo.wav", { id: "a2", dur: 90, gain: 0.8 }))],
      });
    },
    args: { track: { kind: "audio", index: 0 } },
  },
  {
    name: "remove the second of two video tracks (index captured + restored)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(colorClip(60, "gold", { id: "v4" })),
          videoTrack(clip("/abs/b.mp4", { id: "v5", dur: 40 })),
        ],
      });
    },
    args: { track: { kind: "video", index: 1 } },
  },
];
