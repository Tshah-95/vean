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
// Inverse: `move` BACK to the captured origin (same `ripple`/`rippleAllTracks`).
// move is its own inverse under the symmetry the contract needs:
//   • non-ripple: lift+overwrite back is the exact undo WHEN the destination region
//     the forward move stamped over was empty (blank/trailing) — the regime where
//     overwrite destroys nothing. (Overwriting REAL content is lossy in Shotcut too;
//     the design's `_restoreRegion` captured-region inverse is the Move-1b upgrade,
//     and the consequence report flags any `clipsRemoved` so a lossy move is
//     visible. The samples below stay in the lossless regime, exactly as the
//     remove/insert ripple samples do.)
//   • ripple: ripple-remove then ripple-insert back is the exact undo when the
//     cross-track ripple acted only over trailing emptiness (same lossless regime
//     the remove/insert samples are scoped to).
// So `move(origin) ∘ move(dest)` is the identity over those regimes (contract
// law #2), with the inverse a single registry `move` invocation — no captured-data
// restore op needed for Move 1a.
import type { Clip, Item, Timeline, Track } from "../ir/types";
import {
  blankItem,
  clipTouchesDissolve,
  cloneTimeline,
  consolidateBlanks,
  findClip,
  findTrack,
  insertEntryAt,
  itemIndexAt,
  playtime,
  regionIsBlank,
  regionTouchesDissolve,
  removeRange,
  rippleOtherTracks,
  startOf,
  trackLength,
} from "./primitives";
import {
  type Consequences,
  type EditError,
  type MoveArgs,
  type Op,
  type OpResult,
  editError,
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

  const next = cloneTimeline(state);
  const c = noConsequences();

  if (args.ripple) {
    moveRipple(next, src, dstTrack, moved, len, args, c);
  } else {
    const err = moveOverwrite(next, src, dstTrack, moved, len, args, c);
    if (err) return err;
  }

  // The clip ended up at (toTrack, toPosition); report the relocation.
  c.clipsMoved.push({
    uuid: moved.id,
    from: { track: srcTrackId, position: srcPosition },
    to: { track: dstTrack.track.id, position: args.toPosition },
  });

  // Inverse: move BACK to the captured origin, same regime. (See header: exact
  // over the lossless regimes the samples are scoped to.)
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

// ─── Non-ripple: lift the source, overwrite the destination ───────────────────
/** LIFT the clip at the source (swap for a same-length blank, leave a gap) then
 *  OVERWRITE it onto `[toPosition, toPosition+len)` at the destination. Mutates
 *  the (cloned) `next` in place; fills `c`. Returns an EditError only on a real
 *  precondition failure (none in the non-ripple path today). */
function moveOverwrite(
  next: Timeline,
  src: NonNullable<ReturnType<typeof findClip>>,
  dst: NonNullable<ReturnType<typeof findTrack>>,
  moved: Clip,
  len: number,
  args: MoveArgs,
  c: Consequences,
): EditError | undefined {
  const sameTrack = dst.kind === src.trackKind && dst.index === src.trackIndex;

  // ── Vacate the source: replace the clip entry with a blank of equal length ──
  const srcTrack = next.tracks[src.trackKind][src.trackIndex] as Track;
  const lifted = [...srcTrack.items];
  lifted.splice(src.itemIndex, 1, blankItem(len));
  srcTrack.items = consolidateBlanks(lifted);
  c.blanksCreated.push({ track: src.trackId, position: src.position, length: len });

  // ── Stamp the clip onto the destination region, capturing what it covers ──
  // After the lift, the source-track items changed; re-grab the destination items
  // (which is the SAME array when same-track, now carrying the lift's blank).
  const dstTrack = next.tracks[dst.kind][dst.index] as Track;
  // A non-ripple (overwrite) move is reversible only when it stamps over EMPTY
  // space — overwriting real content destroys it with no capture, and the inverse
  // (move back) cannot reconstruct it. Reject that case with a typed precondition
  // so move's "its own inverse" contract holds (the agent should ripple-move, or
  // explicitly overwrite, to intentionally destroy content).
  if (!regionIsBlank(dstTrack.items, args.toPosition, len)) {
    return editError({
      kind: "precondition",
      detail: `move: non-ripple move would overwrite content at [${args.toPosition},${args.toPosition + len}) on track "${dstTrack.id}" (use ripple, or remove the content first)`,
    });
  }
  const { items: cleared, removed } = overwriteRegion(dstTrack.items, args.toPosition, len, moved);
  dstTrack.items = consolidateBlanks(cleared);

  // Report any NON-blank content the overwrite destroyed (a lossy move — the
  // inverse can't reconstruct it; the consequence makes that visible).
  let removedAcc = args.toPosition;
  for (const it of removed) {
    if (it.kind === "clip") {
      c.clipsRemoved.push({
        uuid: it.id,
        track: dstTrack.id,
        position: removedAcc,
        playtime: playtime(it),
      });
    } else if (it.kind === "blank") {
      c.blanksRemoved.push({ track: dstTrack.id, position: removedAcc, length: it.length });
    }
    removedAcc += it.kind === "clip" ? playtime(it) : it.kind === "blank" ? it.length : it.frames;
  }
  c.clipsAdded.push({
    uuid: moved.id,
    track: dstTrack.id,
    position: args.toPosition,
    playtime: len,
  });
  // A non-ripple move keeps total timeline duration the same UNLESS the clip
  // landed past the old track end (padded), which extends that track.
  void sameTrack;
  return undefined;
}

/** Overwrite `[position, position+len)` on `items` with `entry`: pad-then-place
 *  past the end, else carve the region (splitting straddled edges) and splice the
 *  entry into the hole. Returns the new items + the removed region (for reporting).
 *  Pure (operates on a copy). Mirrors the `overwrite` primitive Shotcut shares
 *  between overwrite/move. */
function overwriteRegion(
  items: Item[],
  position: number,
  len: number,
  entry: Item,
): { items: Item[]; removed: Item[] } {
  const end = trackLength(items);
  if (position >= end) {
    // Past the track end: pad with a blank to reach `position`, then append.
    const work = [...items];
    if (position > end) work.push(blankItem(position - end));
    work.push(entry);
    return { items: work, removed: [] };
  }
  // Carve out the covered region, then drop the entry into the hole.
  const { items: carved, removed } = removeRange(items, position, len);
  const idx = holeIndex(carved, position);
  const work = [...carved];
  work.splice(idx, 0, entry);
  return { items: work, removed };
}

/** The items index where the hole at timeline `position` begins (after a
 *  removeRange carved it). `position` lands on an item boundary; this returns the
 *  index of the item STARTING at `position`, or `items.length` when the hole is at
 *  the track tail. */
function holeIndex(items: Item[], position: number): number {
  if (position >= trackLength(items)) return items.length;
  const idx = itemIndexAt(items, position);
  const boundary = startOf(items, idx);
  // removeRange guarantees `position` is on a boundary; `idx` is the item there.
  return position > boundary ? idx + 1 : idx;
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
];
