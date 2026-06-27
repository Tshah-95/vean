// insert (ripple) — place a clip at `position`, pushing later content right.
//
// Shotcut semantics (`multitrackmodel.cpp::insertClip`): if `position` is past
// the track end, pad a blank then append; else split the covering clip at
// `position` and insert the new clip between the halves (RIPPLE — content after
// shifts right by the clip playtime). If `rippleAllTracks`, push every OTHER
// unlocked track right by the clip playtime (`insertOrAdjustBlankAt`, here
// `rippleOtherTracks(state, …, +1)`).
//
// vean mirrors this on the pure IR via the shared `insertEntryAt` primitive
// (which splits the covering item on a non-boundary `position` and splices the
// new entry in) plus `rippleOtherTracks` for the cross-track fan-out. The clip
// lands carrying its own uuid, which the inverse targets.
//
// Inverse — TWO regimes, both exact:
//   • BOUNDARY / gap / end insert: `remove({ uuid, rippleAllTracks })`. insert is
//     remove's mirror — removing the clip we just inserted (same ripple flag)
//     ripple-closes back to the pre-insert state.
//   • MID-CLIP insert (position strictly inside a clip): the insert splits the
//     covering clip, minting a fresh-uuid HEAD that a plain `remove` can't re-merge
//     with the original tail. So we capture the covering clip and invert through
//     `_uninsert`, which drops the inserted clip AND re-merges the two split halves
//     into the captured original — restoring its uuid + window + fades exactly.
//   The op picks the right inverse automatically, so EVERY insert undoes exactly
//   (the earlier "mid-clip is intentionally lossy" caveat is resolved).
import { z } from "zod";
import { type Clip, type Item, type Timeline, type Track, clipSchema } from "../ir/types";
import {
  cloneTimeline,
  consolidateBlanks,
  findClip,
  findTrack,
  insertEntryAt,
  itemIndexAt,
  playtime,
  regionTouchesDissolve,
  rippleOtherTracks,
  startOf,
  trackLength,
} from "./primitives";
import {
  type EditError,
  type InsertArgs,
  type Op,
  type OpResult,
  clipUuid,
  editError,
  insertArgs,
  noConsequences,
} from "./types";

export const insert: Op<InsertArgs> = (state, args): OpResult | EditError => {
  const tloc = findTrack(state, args.track);
  if (!tloc) {
    const track =
      "trackId" in args.track ? args.track.trackId : `${args.track.kind}[${args.track.index}]`;
    return editError({ kind: "track-not-found", track });
  }

  const clip = structuredClone(args.clip);
  const len = playtime(clip);

  // Guard: inserting inside a dissolve's blended region would split an unsplittable
  // marker. Return a typed precondition instead of throwing (contract law #5).
  const srcItems = (state.tracks[tloc.kind][tloc.index] as Track).items;
  if (regionTouchesDissolve(srcItems, args.position, 0)) {
    return editError({
      kind: "precondition",
      detail: `insert: position ${args.position} on track "${tloc.track.id}" is inside a dissolve`,
    });
  }

  const next = cloneTimeline(state);
  const items = (next.tracks[tloc.kind][tloc.index] as Track).items;
  const trackId = tloc.track.id;

  // Does the insert land STRICTLY inside a clip (a mid-clip split), vs on a
  // boundary / in a gap / at the end? A mid-clip split mints a fresh-uuid head that
  // a plain `remove` inverse can't re-merge with the original tail, so we capture
  // the covering clip and invert through `_uninsert` (which re-merges the halves).
  const endBefore = trackLength(items);
  let splitOriginal: Clip | undefined;
  let splitStart = 0;
  if (args.position < endBefore) {
    const idx = itemIndexAt(items, args.position);
    const covering = items[idx] as Item;
    const boundary = startOf(items, idx);
    if (covering.kind === "clip" && args.position > boundary) {
      splitOriginal = structuredClone(covering);
      splitStart = boundary;
    }
  }

  // The track length BEFORE the insert decides whether we pad-and-append (past
  // the end) or split-and-splice (within the run). `insertEntryAt` handles both.
  const { items: placed } = insertEntryAt(items, args.position, clip);
  (next.tracks[tloc.kind][tloc.index] as Track).items = consolidateBlanks(placed);

  const c = noConsequences();
  c.clipsAdded.push({
    uuid: clipUuid(clip),
    track: trackId,
    position: args.position,
    playtime: len,
  });
  // A non-end insert ripples this track's tail right by `len`; an at/after-end
  // insert only extends the track (and may pad a leading blank).
  c.durationDelta = len;
  if (args.position > endBefore) {
    // Padded a leading blank so the clip lands exactly at `position`.
    c.blanksCreated.push({
      track: trackId,
      position: endBefore,
      length: args.position - endBefore,
    });
    c.durationDelta = args.position - endBefore + len;
  }

  if (args.rippleAllTracks) {
    const notes = rippleOtherTracks(next, tloc.kind, tloc.index, args.position, len, 1);
    for (const n of notes) {
      if (!n.blocked) c.ripple.push({ track: n.track, shift: n.shift, from: n.from });
    }
  }

  // A mid-clip insert inverts through `_uninsert` (drop the inserted clip + re-merge
  // the split halves into the captured original); a boundary/gap/end insert inverts
  // through the public `remove` (its ripple-close cleanly drops the clip).
  const inverse = splitOriginal
    ? {
        op: "_uninsert",
        args: {
          track: { trackId },
          insertedUuid: clipUuid(clip),
          original: splitOriginal,
          spanStart: splitStart,
          rippleAllTracks: args.rippleAllTracks,
        },
      }
    : {
        op: "remove",
        args: { uuid: clipUuid(clip), rippleAllTracks: args.rippleAllTracks },
      };

  return { state: next, consequences: c, inverse };
};

export { insertArgs };

// ─── The internal inverse op for a mid-clip insert (re-merge the split halves) ──
// A mid-clip insert left `[head(freshUuid), inserted, tail(originalUuid), …]` with
// later content rippled right. `_uninsert` drops the inserted clip (ripple-closing
// the gap, pulling this track + others back) AND re-merges the head/tail split
// fragments into the captured `original` clip, restoring its uuid + window + fades
// exactly. Its own inverse is `insert` of the original's covering position.
export const uninsertArgs = z.object({
  track: z.object({ trackId: z.string().min(1) }),
  insertedUuid: z.string().min(1),
  /** The covering clip the forward insert split, captured whole. */
  original: clipSchema,
  /** Rendered frame where the captured original begins. */
  spanStart: z.number().int().nonnegative(),
  rippleAllTracks: z.boolean().default(false),
});
export type UninsertArgs = z.infer<typeof uninsertArgs>;

export const uninsert: Op<UninsertArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.insertedUuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.insertedUuid });
  if (loc.trackId !== args.track.trackId) {
    return editError({
      kind: "precondition",
      detail: `_uninsert: clip "${args.insertedUuid}" is on track "${loc.trackId}", expected "${args.track.trackId}"`,
    });
  }

  const insertedLen = playtime(loc.clip);
  const next = cloneTimeline(state);
  const tk = next.tracks[loc.trackKind][loc.trackIndex] as Track;
  const work = [...tk.items];

  // The forward insert split the original into head (just before the inserted clip)
  // and tail (just after). Drop all three (head, inserted, tail) and splice the
  // captured original back in their place — re-merging the halves exactly.
  const insIdx = loc.itemIndex;
  const head = work[insIdx - 1];
  const tail = work[insIdx + 1];
  if (!head || head.kind !== "clip" || !tail || tail.kind !== "clip") {
    return editError({
      kind: "precondition",
      detail: `_uninsert: inserted clip "${args.insertedUuid}" is not flanked by the two split halves`,
    });
  }
  work.splice(insIdx - 1, 3, structuredClone(args.original));
  tk.items = consolidateBlanks(work);

  const c = noConsequences();
  c.clipsRemoved.push({
    uuid: args.insertedUuid,
    track: args.track.trackId,
    position: args.spanStart + playtime(head),
    playtime: insertedLen,
  });
  c.clipsAdded.push({
    uuid: args.original.id,
    track: args.track.trackId,
    position: args.spanStart,
    playtime: playtime(args.original),
  });
  c.durationDelta = -insertedLen;

  // Pull other tracks back left where the forward insert pushed them (only over
  // blank seams, mirroring the forward open's lossless regime).
  if (args.rippleAllTracks) {
    const notes = rippleOtherTracks(
      next,
      loc.trackKind,
      loc.trackIndex,
      args.spanStart + playtime(head),
      insertedLen,
      -1,
    );
    for (const n of notes) {
      if (!n.blocked) c.ripple.push({ track: n.track, shift: n.shift, from: n.from });
    }
  }

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "insert",
      args: {
        track: { trackId: args.track.trackId },
        clip: structuredClone(loc.clip),
        position: args.spanStart + playtime(head),
        rippleAllTracks: args.rippleAllTracks,
      },
    },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
// Cases span every regime: a CLIP BOUNDARY, a gap, the track end, a cross-track
// ripple, AND a MID-CLIP split (which inverts via `_uninsert` re-merging the
// halves). Every case is in the deep-equals regime — insert now undoes exactly
// wherever it lands.
import { blank, clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<InsertArgs>[] = [
  {
    name: "insert a clip at a boundary between two clips (this track's tail ripples right)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(30, "black"), colorClip(30, "gold"))],
      });
    },
    // Boundary between the two color clips is frame 30.
    args: {
      track: { kind: "video", index: 0 },
      clip: clip("/abs/ins.mp4", { id: "inserted", dur: 40, fadeIn: 8 }),
      position: 30,
      rippleAllTracks: false,
    },
  },
  {
    name: "insert at the track end (pure append, no split, no ripple)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, { video: [videoTrack(colorClip(45, "blue"))] });
    },
    args: {
      track: { kind: "video", index: 0 },
      clip: colorClip(50, "gold", { id: "tail-insert", fadeOut: 10 }),
      position: 45,
      rippleAllTracks: false,
    },
  },
  {
    name: "insert PAST the track end (pads a leading blank, then places the clip)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, { video: [videoTrack(colorClip(20, "black"))] });
    },
    args: {
      track: { kind: "video", index: 0 },
      clip: clip("/abs/late.mp4", { id: "late-insert", dur: 30 }),
      position: 50, // 30 frames past the track end (20) → pad a 30f blank first
      rippleAllTracks: false,
    },
  },
  {
    name: "insert with rippleAllTracks (a second track is pushed right at `position`)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(colorClip(30, "black"), colorClip(30, "gold")),
          // The other track has a BLANK spanning the ripple position (frame 30):
          // the ripple opens its gap inside that blank, a lossless blank-split +
          // merge that remove's ripple-close reconstructs exactly (a ripple that
          // splits a CLIP on another track is intentionally outside the
          // deep-equals regime — see the file header + lift/remove design note).
          videoTrack(
            colorClip(20, "blue", { id: "other-a" }),
            blank(40),
            colorClip(20, "green", { id: "other-b" }),
          ),
        ],
      });
    },
    args: {
      track: { kind: "video", index: 0 },
      clip: clip("/abs/ripple.mp4", { id: "rippled", dur: 25 }),
      position: 30, // boundary on track 0; opens a 25f gap inside the other track's gap region
      rippleAllTracks: true,
    },
  },
  {
    name: "insert in the MIDDLE of a clip (splits the covering clip; inverts via _uninsert re-merge)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(clip("/abs/big.mp4", { id: "big", dur: 100, fadeIn: 8, fadeOut: 8 }))],
      });
    },
    // `big` plays [0,99]; insert at frame 40 splits it into head[0,39] + tail[40,99]
    // with the new clip between — the inverse re-merges the halves into `big`.
    args: {
      track: { kind: "video", index: 0 },
      clip: clip("/abs/mid.mp4", { id: "mid-ins", dur: 20 }),
      position: 40,
      rippleAllTracks: false,
    },
  },
];
