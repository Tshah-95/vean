// remove (ripple) — drop a clip and close the gap (content after shifts LEFT).
//
// Shotcut semantics (`multitrackmodel.cpp::removeClip`): remove the clip's entry
// and consolidate blanks (ripple-CLOSE — everything after the clip slides left by
// its playtime). If `rippleAllTracks`, pull every OTHER unlocked track left by the
// same playtime (`removeRegion` on each other track).
//
// vean mirrors this on the pure IR: locate the clip, drop its `items[]` entry,
// `consolidateBlanks` (merging the now-adjacent neighbours so the gap truly
// closes), and — when rippleAllTracks — `rippleOtherTracks(…, dir:-1)` to pull the
// other tracks left from this clip's start. The captured clip + position + ripple
// flag ride into the inverse.
//
// Inverse: `_reinsert({ track, position, clip, rippleAllTracks })` — re-open the
// gap at `position` (insert the clip, pushing following content right by its
// playtime; ripple other tracks right when set) and place the captured clip back.
// Self-contained so remove's inverse-invariant passes now.
import { z } from "zod";
import { clipSchema } from "../ir/types";
import type { Item, Timeline, Track } from "../ir/types";
import {
  clipTouchesDissolve,
  cloneTimeline,
  consolidateBlanks,
  findClip,
  findTrack,
  insertEntryAt,
  linkDesyncWarning,
  playtime,
  rippleOtherTracks,
} from "./primitives";
import {
  type EditError,
  type Op,
  type OpResult,
  type RemoveArgs,
  editError,
  noConsequences,
} from "./types";

export const remove: Op<RemoveArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  // Removing a clip that participates in a dissolve would leave a dangling marker
  // the serializer rejects. Reject with a typed precondition (the user must remove
  // the dissolve first; Shotcut's "remove clip" also tears down its transition).
  const srcItems = (state.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  if (clipTouchesDissolve(srcItems, loc.itemIndex)) {
    return editError({
      kind: "precondition",
      detail: `remove: clip "${args.uuid}" participates in a dissolve — remove the dissolve first`,
    });
  }

  const removedClip: Item = structuredClone(loc.clip);
  const len = playtime(loc.clip);

  const next = cloneTimeline(state);
  const track = next.tracks[loc.trackKind][loc.trackIndex] as Track;
  // Drop the entry and close the gap (ripple-close on THIS track).
  const dropped = [...track.items];
  dropped.splice(loc.itemIndex, 1);
  track.items = consolidateBlanks(dropped);

  const c = noConsequences();
  c.clipsRemoved.push({
    uuid: loc.clip.id,
    track: loc.trackId,
    position: loc.position,
    playtime: len,
  });
  c.durationDelta = -len; // ripple-close shortens the track by the clip playtime

  // Record a link desync (record, don't corrupt): ripple-removing ONE half of a
  // linked A/V pair leaves the partner in place (its track is only shifted if it's
  // an OTHER track under rippleAllTracks, and even then not from the partner's own
  // position), so the pair drifts and the partner's link now dangles. The remove is
  // performed correctly; we flag it for the diagnostics layer (dangling-link + desync).
  c.warnings.push(
    ...linkDesyncWarning(
      state,
      loc.clip,
      "remove",
      "the clip was ripple-deleted but its linked partner was not",
    ),
  );

  // Track ids the cross-track ripple-close LEFT IN PLACE (content at the seam);
  // the inverse must NOT re-open a gap on these, or undo would shift them.
  const blockedTracks: string[] = [];
  if (args.rippleAllTracks) {
    // Pull every OTHER unlocked track left by `len` from this clip's start —
    // but only where the seam is blank. A track holding real content there is
    // left untouched and reported as a warning (never silently shredded).
    const notes = rippleOtherTracks(next, loc.trackKind, loc.trackIndex, loc.position, len, -1);
    for (const n of notes) {
      if (n.blocked) {
        blockedTracks.push(n.track);
        c.warnings.push({
          code: "ripple-blocked",
          detail: `track "${n.track}" holds content at frame ${n.from}; ripple-close left it in place (Shotcut does not shred other-track clips)`,
        });
      } else {
        c.ripple.push({ track: n.track, shift: n.shift, from: n.from });
      }
    }
  }

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_reinsert",
      args: {
        track: { trackId: loc.trackId },
        position: loc.position,
        clip: removedClip,
        rippleAllTracks: args.rippleAllTracks,
        skipOpen: blockedTracks,
      },
    },
  };
};

// ─── The internal inverse op (re-open the gap and re-place the captured clip) ──
// Re-inserts the captured clip at `position` (splitting any covering item so the
// clip lands on the boundary, pushing following content right by its playtime).
// When `rippleAllTracks`, ripples every other track right by the same amount so
// the cross-track alignment that ripple-remove pulled in is restored exactly.
export const reinsertArgs = z.object({
  track: z.object({ trackId: z.string().min(1) }),
  position: z.number().int().nonnegative(),
  clip: clipSchema,
  rippleAllTracks: z.boolean().default(false),
  /** Track ids the forward ripple-close left untouched (content at the seam); the
   *  re-open skips them so undo restores the cross-track alignment exactly. */
  skipOpen: z.array(z.string().min(1)).default([]),
});
export type ReinsertArgs = z.infer<typeof reinsertArgs>;

export const reinsert: Op<ReinsertArgs> = (state, args): OpResult | EditError => {
  const tloc = findTrack(state, args.track);
  if (!tloc) return editError({ kind: "track-not-found", track: args.track.trackId });

  const len = playtime(args.clip);
  const next = cloneTimeline(state);
  const items = (next.tracks[tloc.kind][tloc.index] as Track).items;
  // Insert the captured clip at `position`, splitting the covering item if any
  // (this re-opens the gap by pushing following content right).
  const { items: placed } = insertEntryAt(items, args.position, structuredClone(args.clip));
  (next.tracks[tloc.kind][tloc.index] as Track).items = consolidateBlanks(placed);

  const c = noConsequences();
  c.clipsAdded.push({
    uuid: args.clip.id,
    track: args.track.trackId,
    position: args.position,
    playtime: len,
  });
  c.durationDelta = len;

  const skip = new Set(args.skipOpen);
  if (args.rippleAllTracks) {
    const notes = rippleOtherTracks(next, tloc.kind, tloc.index, args.position, len, 1, skip);
    for (const n of notes) {
      if (!n.blocked) c.ripple.push({ track: n.track, shift: n.shift, from: n.from });
    }
  }

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "remove",
      args: { uuid: args.clip.id, rippleAllTracks: args.rippleAllTracks },
    },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<RemoveArgs>[] = [
  {
    name: "remove a clip between two others (ripple-close — the right neighbour slides left)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(30, "black"),
            clip("/abs/mid.mp4", { id: "rm", dur: 40, fadeIn: 8 }),
            colorClip(30, "gold"),
          ),
        ],
      });
    },
    args: { uuid: "rm", rippleAllTracks: false },
  },
  {
    name: "remove with rippleAllTracks (a second track is pulled left over its trailing gap)",
    // The clip `rm` starts at frame 20; the overlay track ends at frame 15 (before
    // 20), so the cross-track ripple acts only on trailing emptiness — exactly the
    // regime where ripple-remove is LOSSLESS and its inverse (re-open the gap)
    // reconstructs the original byte-for-byte. (A ripple that cuts real content out
    // of another track is intentionally lossy in Shotcut too; the inverse-exact
    // invariant only holds over blank, which the consequences report makes visible.)
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(20, "black"),
            clip("/abs/v.mp4", { id: "rm", dur: 50 }),
            colorClip(20, "gold"),
          ),
          videoTrack(clip("/abs/overlay.mp4", { id: "ov", dur: 15 })),
        ],
      });
    },
    args: { uuid: "rm", rippleAllTracks: true },
  },
];
