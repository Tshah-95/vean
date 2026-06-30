// removeWords — cut word-level frame RANGES from a track, addressed by STABLE
// word identity, with ripple-close (content after each cut slides LEFT).
//
// THE WHOLE POINT (vs Palmier's documented `remove_words` footgun). Palmier
// removes words by ORDINAL INDEX, and "indices shift after each cut" — remove
// word 3 and words 4..N renumber, so a multi-word removal in one call silently
// hits the wrong words. vean removes word ranges by STABLE id (resolved upstream
// to timeline frame spans via `src/query/transcript-map.resolveWordRange`), and
// cuts the spans RIGHT-TO-LEFT. Cutting from the end means an earlier (lower)
// span's frame position is NEVER disturbed by a later cut — the index/position
// shift that breaks Palmier cannot occur. The op carries the originating word ids
// into its consequences + inverse so the cut is legible and exactly invertible.
//
// Each span is removed with the same lossless capture/restore surgery overwrite
// uses (`spanCovering` + `removeRange`), so a straddled clip splits cleanly and
// the inverse re-merges it byte-for-byte. The captured items + their original
// positions ride into the inverse (`_restoreWords`), which re-opens the gaps
// LEFT-TO-RIGHT (restoring the coordinate frame for each later span exactly).
//
// Inverse: `_restoreWords({ track, restores })` — for each captured span (in
// ASCENDING position order) re-open a gap of its length at its original position
// and splice the captured items back. Self-contained so removeWords' inverse
// invariant holds today.
import { z } from "zod";
import { type Item, itemSchema } from "../ir/types";
import type { Timeline, Track } from "../ir/types";
import {
  cloneTimeline,
  consolidateBlanks,
  findTrack,
  itemLength,
  playtime,
  regionTouchesDissolve,
  removeRange,
  spanCovering,
} from "./primitives";
import {
  type EditError,
  type Op,
  type OpResult,
  editError,
  noConsequences,
  trackAddrSchema,
} from "./types";

// ─── Args ──────────────────────────────────────────────────────────────────
/** One word-range target: an INCLUSIVE timeline frame span plus the stable word
 *  ids that produced it (resolved upstream from a transcript). The ids are
 *  carried for the consequence report + inverse legibility; the FRAMES are what
 *  the cut acts on. */
export const wordTargetSchema = z.object({
  /** Stable word ids this span covers (≥1). Addressing is by THESE, never index. */
  wordIds: z.array(z.string().min(1)).min(1),
  /** Inclusive 0-based timeline start frame. */
  startFrame: z.number().int().nonnegative(),
  /** Inclusive 0-based timeline end frame (≥ startFrame). */
  endFrame: z.number().int().nonnegative(),
});
export type WordTarget = z.infer<typeof wordTargetSchema>;

/** removeWords — ripple-close every word-range `target` on `track`. Targets are
 *  resolved from stable word ids (no index addressing); they're cut right-to-left
 *  so positions never shift mid-op. */
export const removeWordsArgs = z.object({
  track: trackAddrSchema,
  /** The word ranges to cut. May arrive in any order — the op sorts + cuts them
   *  right-to-left, so the caller need not pre-order them. */
  targets: z.array(wordTargetSchema).min(1),
});
export type RemoveWordsArgs = z.infer<typeof removeWordsArgs>;

// ─── Forward op ──────────────────────────────────────────────────────────────
export const removeWords: Op<RemoveWordsArgs> = (state, args): OpResult | EditError => {
  const tloc = findTrack(state, args.track);
  if (!tloc) {
    const id =
      "trackId" in args.track ? args.track.trackId : `${args.track.kind}[${args.track.index}]`;
    return editError({ kind: "track-not-found", track: id });
  }

  // Validate every span up front (so a bad target fails BEFORE any mutation — a
  // partial cut would be a footgun of its own). Spans must be well-ordered and
  // must not straddle a same-track dissolve (whose marker the serializer would be
  // left dangling — exactly remove()'s precondition, applied per range).
  for (const t of args.targets) {
    if (t.endFrame < t.startFrame) {
      return editError({
        kind: "invalid-args",
        detail: `removeWords: target endFrame (${t.endFrame}) < startFrame (${t.startFrame}) for words [${t.wordIds.join(", ")}]`,
      });
    }
  }
  const sourceItems = (state.tracks[tloc.kind][tloc.index] as Track).items;
  for (const t of args.targets) {
    const len = t.endFrame - t.startFrame + 1;
    if (regionTouchesDissolve(sourceItems, t.startFrame, len)) {
      return editError({
        kind: "precondition",
        detail: `removeWords: range [${t.startFrame}, ${t.endFrame}] crosses a same-track dissolve — remove the dissolve first`,
      });
    }
  }

  // CAPTURE the WHOLE original track items, verbatim, for the inverse. A
  // word-level cut can remove MULTIPLE disjoint ranges from the SAME source clip
  // (filler words scattered through one take), which fragments that clip into
  // several head/middle/tail pieces. No per-range capture composes back into the
  // original single clip; the only exact, fragment-immune undo is to restore the
  // track's pre-edit item run wholesale (the same whole-snapshot idiom Shotcut's
  // undo uses, and `_restoreTrack`). Byte-exact by construction, any number of
  // overlapping cuts.
  const originalItems = sourceItems.map((it) => structuredClone(it));
  const trackLen = originalItems.reduce((n, it) => n + itemLength(it), 0);

  // Compute the per-range spans (against the ORIGINAL items) for the consequence
  // report + the right-to-left cut order. Each is the WHOLE items the range
  // touched (reported by original uuid + position so the agent sees the real
  // content affected) plus the clamped cut length.
  type Cut = { startFrame: number; cutLen: number; spanStart: number; captured: Item[] };
  const cuts: Cut[] = [];
  for (const t of args.targets) {
    const reqLen = t.endFrame - t.startFrame + 1;
    const cutLen = Math.min(reqLen, Math.max(0, trackLen - t.startFrame));
    if (cutLen <= 0) continue; // range past the track end — nothing to cut
    const span = spanCovering(originalItems, t.startFrame, cutLen);
    cuts.push({
      startFrame: t.startFrame,
      cutLen,
      spanStart: span.spanStart,
      captured: span.captured,
    });
  }

  // Apply the cuts RIGHT-TO-LEFT (descending start). Cutting the rightmost range
  // first means a lower range's `startFrame` is still valid in the ORIGINAL
  // coordinate frame when its cut runs — the position never shifts under us, so a
  // multi-range cut in ONE call hits exactly the named frames (the index-shift
  // fix, by construction — the whole point vs Palmier's ordinal `remove_words`).
  const next = cloneTimeline(state);
  const track = next.tracks[tloc.kind][tloc.index] as Track;
  let work = [...track.items];

  const c = noConsequences();
  let removedTotal = 0;
  for (const cut of [...cuts].sort((a, b) => b.startFrame - a.startFrame)) {
    const { items: cleared } = removeRange(work, cut.startFrame, cut.cutLen);
    work = cleared;
    removedTotal += cut.cutLen;
  }

  track.items = consolidateBlanks(work);
  c.durationDelta = -removedTotal;

  // Consequences: the WHOLE clips/blanks each range touched, by ORIGINAL uuid +
  // position (so an agent sees the real content affected, not a phantom fragment).
  for (const cut of cuts) {
    let pos = cut.spanStart;
    for (const it of cut.captured) {
      if (it.kind === "clip") {
        c.clipsRemoved.push({
          uuid: it.id,
          track: tloc.track.id,
          position: pos,
          playtime: playtime(it),
        });
      } else if (it.kind === "blank") {
        c.blanksRemoved.push({ track: tloc.track.id, position: pos, length: it.length });
      }
      pos += itemLength(it);
    }
  }

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_restoreWords",
      args: { track: { trackId: tloc.track.id }, items: originalItems },
    },
  };
};

// ─── The internal inverse op (restore the whole pre-cut track items) ──────────
// Replaces the (cut) track's items with the captured PRE-CUT originals, verbatim.
// A word-level cut can fragment one clip into many pieces (multiple ranges in one
// take); the only fragment-immune, byte-exact undo is to restore the whole
// pre-edit item run — the same whole-snapshot idiom Shotcut's undo + `_restoreTrack`
// use. Its OWN inverse is `_restoreWords` carrying the CURRENT (cut) items, so
// undo-of-undo is a symmetric whole-items swap that round-trips exactly. Pure.
export const restoreWordsArgs = z.object({
  track: z.object({ trackId: z.string().min(1) }),
  /** The whole track item run to restore (the pre-cut originals, verbatim). */
  items: z.array(itemSchema).default([]),
});
export type RestoreWordsArgs = z.infer<typeof restoreWordsArgs>;

export const restoreWords: Op<RestoreWordsArgs> = (state, args): OpResult | EditError => {
  const tloc = findTrack(state, args.track);
  if (!tloc) return editError({ kind: "track-not-found", track: args.track.trackId });

  const next = cloneTimeline(state);
  const track = next.tracks[tloc.kind][tloc.index] as Track;
  // Capture the CURRENT (cut) items so undo-of-undo restores them symmetrically.
  const currentItems = track.items.map((it) => structuredClone(it));
  const beforeLen = track.items.reduce((n, it) => n + itemLength(it), 0);

  // Restore the pre-cut originals wholesale.
  const restored = args.items.map((it) => structuredClone(it));
  track.items = restored;
  const afterLen = restored.reduce((n, it) => n + itemLength(it), 0);

  // Consequences: the clips/blanks the restore brought back, by original uuid +
  // position (the agent sees the restored content, not the swap mechanics).
  const c = noConsequences();
  let pos = 0;
  for (const it of restored) {
    if (it.kind === "clip") {
      c.clipsAdded.push({
        uuid: it.id,
        track: tloc.track.id,
        position: pos,
        playtime: playtime(it),
      });
    } else if (it.kind === "blank") {
      c.blanksCreated.push({ track: tloc.track.id, position: pos, length: it.length });
    }
    pos += itemLength(it);
  }
  c.durationDelta = afterLen - beforeLen;

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_restoreWords",
      args: { track: { trackId: tloc.track.id }, items: currentItems },
    },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
// The op-invariants harness (tests/op-invariants.test.ts) auto-runs the INVERSE
// + SERIALIZE laws on every sample below. A sample's `state` is a fresh thunk
// (resetIds first for determinism); the targets must be valid for it.
import { clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<RemoveWordsArgs>[] = [
  {
    name: "remove one word-range in the middle of a spoken clip (ripple-close)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            // One long "spoken" clip; a word range [20,29] is cut out of its middle.
            clip("/abs/speech.mp4", { id: "spoken", dur: 120 }),
          ),
        ],
      });
    },
    args: {
      track: { kind: "video", index: 0 },
      targets: [{ wordIds: ["w1"], startFrame: 20, endFrame: 29 }],
    },
  },
  {
    name: "remove MULTIPLE disjoint word-ranges in one call (right-to-left, no index shift)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(clip("/abs/speech.mp4", { id: "spoken", dur: 200 }))],
      });
    },
    // Two ranges given OUT OF ORDER on purpose — the op sorts + cuts right-to-left,
    // so the lower range's frame position is undisturbed when its cut runs.
    args: {
      track: { kind: "video", index: 0 },
      targets: [
        { wordIds: ["wB"], startFrame: 120, endFrame: 139 },
        { wordIds: ["wA"], startFrame: 30, endFrame: 49 },
      ],
    },
  },
  {
    name: "remove a word-range that straddles two clips (split-edge capture round-trips)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(colorClip(40, "black", { id: "a" }), clip("/abs/b.mp4", { id: "b", dur: 40 })),
        ],
      });
    },
    // [30, 49] straddles the boundary at frame 40 — captures a fragment of each.
    args: {
      track: { kind: "video", index: 0 },
      targets: [{ wordIds: ["edge"], startFrame: 30, endFrame: 49 }],
    },
  },
];
