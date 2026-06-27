// overwrite — stamp a clip over `[position, position+playtime)`, replacing what
// was there. The capturing op: it records the removed region so the inverse can
// splice it back.
//
// Shotcut semantics (`multitrackmodel.cpp::overwrite`): if `position` is past the
// track end, pad a blank then append; else split the covering clip at the left
// edge, remove/split items until the region of length `clip.playtime` is consumed
// (leaving a HOLE, not a gap), then insert the new clip into the hole. The removed
// region is needed by the inverse, so we CAPTURE it (`removeRange`'s `removed`).
//
// vean mirrors this on the pure IR:
//   • `removeRange(items, position, len)` does the split-left + drop-covered +
//     split-right loop and returns the removed items in order;
//   • `insertEntryAt(items, position, clip)` drops the new clip into the hole
//     (now a clean boundary at `position`, so no further split).
// A position past the track end pads a leading blank (no region removed). Because
// overwrite REPLACES in place, it never ripples other tracks and never changes the
// timeline duration (except when it extends the track past its old end).
//
// Inverse: `_restoreRegion({ track, position, removed, insertedUuid, padded })` —
// remove the inserted clip and splice the captured `removed` items back at
// `position`, restoring the exact pre-overwrite items[] (windows, uuids, fades,
// surrounding blanks). Self-contained so overwrite's inverse-invariant passes now.
import { z } from "zod";
import { itemSchema } from "../ir/types";
import type { Item, Timeline, Track } from "../ir/types";
import {
  cloneTimeline,
  consolidateBlanks,
  findClip,
  findTrack,
  insertEntryAt,
  itemLength,
  padToPosition,
  playtime,
  regionTouchesDissolve,
  removeRange,
  spanCovering,
  trackLength,
} from "./primitives";
import {
  type EditError,
  type Op,
  type OpResult,
  type OverwriteArgs,
  clipUuid,
  editError,
  noConsequences,
  overwriteArgs,
} from "./types";

export const overwrite: Op<OverwriteArgs> = (state, args): OpResult | EditError => {
  const tloc = findTrack(state, args.track);
  if (!tloc) {
    const track =
      "trackId" in args.track ? args.track.trackId : `${args.track.kind}[${args.track.index}]`;
    return editError({ kind: "track-not-found", track });
  }

  const clip = structuredClone(args.clip);
  const len = playtime(clip);
  const trackId = tloc.track.id;

  // Guard: overwriting across a dissolve's blended region would shred the nested
  // transition tractor. Return a typed precondition (contract law #5).
  const srcItems = (state.tracks[tloc.kind][tloc.index] as Track).items;
  if (regionTouchesDissolve(srcItems, args.position, len)) {
    return editError({
      kind: "precondition",
      detail: `overwrite: [${args.position},${args.position + len}) on track "${trackId}" overlaps a dissolve`,
    });
  }

  const next = cloneTimeline(state);
  const items = (next.tracks[tloc.kind][tloc.index] as Track).items;
  const endBefore = trackLength(items);

  const c = noConsequences();

  if (args.position >= endBefore) {
    // Past the track end: pad a leading blank (if any), then append — nothing is
    // removed (the region is empty/trailing). durationDelta is the new extent.
    const { items: padded, padded: padLen } = padToPosition(items, args.position);
    const placed = [...padded, clip];
    (next.tracks[tloc.kind][tloc.index] as Track).items = placed;

    c.clipsAdded.push({
      uuid: clipUuid(clip),
      track: trackId,
      position: args.position,
      playtime: len,
    });
    if (padLen > 0) c.blanksCreated.push({ track: trackId, position: endBefore, length: padLen });
    c.durationDelta = args.position + len - endBefore;

    return {
      state: next,
      consequences: c,
      inverse: {
        op: "_restoreRegion",
        args: {
          track: { trackId },
          position: args.position,
          removed: [], // nothing was overwritten
          insertedUuid: clipUuid(clip),
          padded: padLen,
        },
      },
    };
  }

  // Within the run: CAPTURE the whole span of items the region overlaps (verbatim,
  // before any split) so the inverse restores them exactly — re-merging what a
  // split-edge removeRange would otherwise fragment into fresh-uuid head/tail
  // clips (the straddle inverse bug). Then do the surgery: remove exactly `len`
  // frames at `position` (split-left, drop covered, split-right) and drop the new
  // clip into the clean hole.
  const span = spanCovering(items, args.position, len);
  const { items: holed, removed } = removeRange(items, args.position, len);
  const { items: placed } = insertEntryAt(holed, args.position, clip);
  (next.tracks[tloc.kind][tloc.index] as Track).items = consolidateBlanks(placed);

  c.clipsAdded.push({
    uuid: clipUuid(clip),
    track: trackId,
    position: args.position,
    playtime: len,
  });
  // Report the removed region's clips/blanks for the consequences contract. We
  // report the WHOLE items the region touched (clips by their ORIGINAL uuid), so an
  // agent reading consequences sees the real content affected — not a phantom
  // split fragment. (A clip the region only partially covers is still reported
  // whole, since the inverse restores it whole.)
  for (const it of span.captured) {
    const pos = startOfSpanItem(span, it);
    if (it.kind === "clip") {
      c.clipsRemoved.push({ uuid: it.id, track: trackId, position: pos, playtime: playtime(it) });
    } else if (it.kind === "blank") {
      c.blanksRemoved.push({ track: trackId, position: pos, length: it.length });
    }
  }
  // overwrite replaces in place; the region removed (`removedLen`) equals what was
  // inserted (`len`) when fully within the run, so the track length is unchanged.
  const removedLen = removed.reduce((n, it) => n + itemLength(it), 0);
  c.durationDelta = len - removedLen;

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_restoreRegion",
      args: {
        track: { trackId },
        position: args.position,
        removed,
        captured: span.captured,
        spanStart: span.spanStart,
        insertedUuid: clipUuid(clip),
        padded: 0,
      },
    },
  };
};

/** Rendered position of a captured span item (for consequence reporting). The
 *  span is a contiguous run; positions accumulate from `span.spanStart`. */
function startOfSpanItem(span: { spanStart: number; captured: Item[] }, target: Item): number {
  let pos = span.spanStart;
  for (const it of span.captured) {
    if (it === target) return pos;
    pos += it.kind === "clip" ? playtime(it) : it.kind === "blank" ? it.length : it.frames;
  }
  return span.spanStart;
}

export { overwriteArgs };

// ─── The internal inverse op (restore the captured span) ──────────────────────
// Restores the EXACT pre-overwrite items[] by replacing the rendered span the
// forward op touched — the inserted clip PLUS any edge fragments removeRange split
// — with the `captured` originals (whole clips, original uuids + fades), spliced
// back at `spanStart`. Capturing the whole touched span (not just the inner
// removed fragments) is what makes a STRADDLING overwrite invert exactly: a naive
// "drop inserted clip, re-insert removed inner items" left the fresh-uuid outer
// split fragments behind. When the forward op padded a leading blank (past-end
// overwrite), the inverse instead drops the inserted clip AND that pad. Its own
// inverse is `overwrite` of the same clip at `position`, so undo-of-undo
// round-trips.
export const restoreRegionArgs = z.object({
  track: z.object({ trackId: z.string().min(1) }),
  position: z.number().int().nonnegative(),
  /** The items overwrite removed, in track order (consequence reporting only). */
  removed: z.array(itemSchema).default([]),
  /** The WHOLE original items the region overlapped, captured verbatim for an
   *  exact restore (re-merges what a split-edge removeRange fragmented). */
  captured: z.array(itemSchema).default([]),
  /** Rendered frame where the captured span begins. */
  spanStart: z.number().int().nonnegative().default(0),
  /** The uuid of the clip overwrite inserted (the thing to pull back out). */
  insertedUuid: z.string().min(1),
  /** Frames of leading blank the forward op padded (past-end overwrite); dropped on restore. */
  padded: z.number().int().nonnegative().default(0),
});
export type RestoreRegionArgs = z.infer<typeof restoreRegionArgs>;

export const restoreRegion: Op<RestoreRegionArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.insertedUuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.insertedUuid });
  if (loc.trackId !== args.track.trackId) {
    return editError({
      kind: "precondition",
      detail: `_restoreRegion: clip "${args.insertedUuid}" is on track "${loc.trackId}", expected "${args.track.trackId}"`,
    });
  }

  const insertedLen = playtime(loc.clip);
  const next = cloneTimeline(state);
  const tk = next.tracks[loc.trackKind][loc.trackIndex] as Track;
  let work = [...tk.items];

  if (args.padded > 0) {
    // Past-end overwrite: drop the inserted clip AND the leading blank the forward
    // op padded. After removing the inserted clip a `padded`-length blank ends at
    // `position`; remove exactly `padded` frames ending there.
    work.splice(loc.itemIndex, 1);
    const padStart = args.position - args.padded;
    const { items: trimmed } = removeRange(work, padStart, args.padded);
    work = trimmed;
  } else {
    // Within-run overwrite: remove the WHOLE touched span (the inserted clip + any
    // split edge fragments) by frame range, then splice the captured originals back
    // at `spanStart`. This re-merges the fragments exactly (straddle-safe).
    const capturedLen = args.captured.reduce(
      (n, it) =>
        n + (it.kind === "clip" ? playtime(it) : it.kind === "blank" ? it.length : it.frames),
      0,
    );
    const { items: cleared } = removeRange(work, args.spanStart, capturedLen);
    work = cleared;
    let at = args.spanStart;
    for (const it of args.captured) {
      const { items } = insertEntryAt(work, at, structuredClone(it));
      work = items;
      at += it.kind === "clip" ? playtime(it) : it.kind === "blank" ? it.length : it.frames;
    }
  }
  tk.items = consolidateBlanks(work);

  const c = noConsequences();
  c.clipsRemoved.push({
    uuid: args.insertedUuid,
    track: args.track.trackId,
    position: args.position,
    playtime: insertedLen,
  });
  let rpos = args.spanStart;
  for (const it of args.captured) {
    if (it.kind === "clip") {
      c.clipsAdded.push({
        uuid: it.id,
        track: args.track.trackId,
        position: rpos,
        playtime: playtime(it),
      });
      rpos += playtime(it);
    } else if (it.kind === "blank") {
      c.blanksCreated.push({ track: args.track.trackId, position: rpos, length: it.length });
      rpos += it.length;
    }
  }
  const restoredLen = args.captured.reduce(
    (n, it) =>
      n + (it.kind === "clip" ? playtime(it) : it.kind === "blank" ? it.length : it.frames),
    0,
  );
  c.durationDelta = restoredLen - insertedLen - args.padded;

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "overwrite",
      args: {
        track: { trackId: args.track.trackId },
        clip: structuredClone(loc.clip),
        position: args.position,
      },
    },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { blank, clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<OverwriteArgs>[] = [
  {
    name: "overwrite a whole clip exactly (the captured clip is restored by the inverse)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(30, "black"),
            clip("/abs/mid.mp4", { id: "victim", dur: 40, fadeIn: 8, fadeOut: 8 }),
            colorClip(30, "gold"),
          ),
        ],
      });
    },
    // The victim plays [30,70); overwrite an exactly-40f clip over it.
    args: {
      track: { kind: "video", index: 0 },
      clip: colorClip(40, "blue", { id: "stamp" }),
      position: 30,
    },
  },
  {
    name: "overwrite a blank + a whole clip (multi-item removed region, restored by uuid)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(20, "black", { id: "a" }),
            blank(20),
            clip("/abs/b.mp4", { id: "b", dur: 30, fadeOut: 6 }),
          ),
        ],
      });
    },
    // Track: a[0,20) blank[20,40) b[40,70). Overwrite 50f at position 20 (a clean
    // boundary) covering the blank AND the whole of `b` — so the removed region is
    // [blank(20), b] and the inverse splices both back by-value (b's uuid + fade
    // preserved). Both edges land on item boundaries → no clip is split → lossless.
    args: {
      track: { kind: "video", index: 0 },
      clip: clip("/abs/stamp2.mp4", { id: "stamp2", dur: 50 }),
      position: 20,
    },
  },
  {
    name: "overwrite PAST the track end (pads a leading blank, then appends)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, { video: [videoTrack(colorClip(20, "black"))] });
    },
    args: {
      track: { kind: "video", index: 0 },
      clip: colorClip(30, "gold", { id: "late-stamp" }),
      position: 50, // 30 frames past the end (20) → pad a 30f blank, then append
    },
  },
  {
    name: "overwrite STRADDLING two clip boundaries (captured-span inverse restores both whole)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/a.mp4", { id: "A", dur: 40, fadeOut: 8 }),
            clip("/abs/b.mp4", { id: "B", dur: 40, fadeIn: 8 }),
          ),
        ],
      });
    },
    // A plays [0,39], B plays [40,79]. Stamp a 30f clip at position 25 → the region
    // [25,55) straddles the A|B boundary, splitting BOTH. The captured-span inverse
    // re-merges the fragments back into whole A + B (uuids + fades intact).
    args: {
      track: { kind: "video", index: 0 },
      clip: clip("/abs/s.mp4", { id: "S", dur: 30 }),
      position: 25,
    },
  },
];
