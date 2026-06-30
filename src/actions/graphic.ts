// The composite seam, as a pure(ish) helper the `timeline.addGraphic` action
// calls. It wraps EXISTING pure ops (addTrack, overwrite) plus a thin field-
// transition push, so undo/consequences come for free and the edit algebra stays
// pure. It adds NO new op kind and NO Remotion-specific IR shape: the composited
// graphic is an ordinary alpha CLIP on an upper video track + a `qtblend` field
// `Transition` — both already in the IR.
//
// THE COMPOSITING MODEL (load-bearing — verified by a real melt render, guarded
// by the render-faithfulness gate `bun run verify:graphic`, i.e.
// scripts/verify-graphic-composite.ts):
// melt composites a `qtblend a=<lower index> b=<higher index>` with the HIGHER
// main-tractor index rendering ON TOP, and emits the composited result. So a
// graphic OVERLAY that must render over existing footage — and whose transparent
// regions must reveal that footage — belongs at the BOTTOM of `tracks.video` (=
// the HIGHEST main-tractor index = the top compositing layer). The footage stays
// the base (a LOWER index). This is exactly Shotcut's V2-over-V1 shape (see
// corpus/shotcut-multitrack.mlt: `qtblend a_track=1 b_track=2`).
//
// The earlier bug PREPENDED the GFX track (overlay at index 1, BELOW the footage
// at index 2) and emitted `qtblend a=footage(2) b=overlay(1)` — so the overlay
// landed under the footage and melt painted the black background through the
// overlay's transparent regions. The fix: put the overlay at the bottom of the
// array (top layer) and composite `a=footage b=overlay`.
//
// Mechanically (all via the builder + the op registry, threading state):
//   1. Ensure an upper (overlay) video track for graphics. addTrack with
//      `position:"bottom"` APPENDS it (video[last] = highest main-tractor index =
//      top of compositing). Reuse the existing bottom graphics track unless
//      `newTrack` forces a fresh one or there is only the base footage track.
//   2. overwrite the alpha clip at `position` on that track (overwrite, not
//      insert — an overlay should not ripple the footage).
//   3. Push a `qtblend` field `Transition` compositing the graphics track (B,
//      HIGHER index, on top) over the footage track (A, LOWER index, base) on the
//      main tractor for the clip's [in,out] timeline span.
//
// Track index across the main tractor is `1 + (position in [...video,...audio])`
// (background producer at index 0 — see serialize.ts toMlt). The inverse is the
// composed sequence of the underlying ops' inverses, reversed.
import { clip as buildClip, transition as buildTransition, uuid } from "../ir/builder";
import type { Timeline, Transition } from "../ir/types";
import { apply } from "../ops";
import type { Consequences, EditError, OpInvocation, Warning } from "../ops/types";
import { isEditError } from "../ops/types";

export type AddGraphicArgs = {
  clipPath: string;
  position: number;
  durationFrames: number;
  /** Force a fresh (bottom/overlay) GFX track even if one already exists. */
  newTrack?: boolean;
  /** Cross-track blend service for the field transition. */
  blendService?: string;
  /** Human label for the clip (defaults to `graphic`). */
  label?: string;
  /** Remotion-overlay identity for a NEW baked overlay. When set, it flows onto
   *  the overlay clip's `Clip.composition` so the viewer recognizes it (and it
   *  round-trips through the `vean:composition` producer property) — this is how a
   *  freshly-baked overlay carries its composition id + render props. An EXISTING
   *  overlay placed without it is instead enriched by the preview read-adapter. */
  composition?: { id: string; props?: Record<string, unknown> };
};

export type AddGraphicResult = {
  state: Timeline;
  consequences: Consequences;
  /** The ordered inverse sequence (UNDO order: reverse of the apply order). */
  inverse: OpInvocation[];
  /** The 0-based main-tractor track indices the qtblend transition references. */
  aTrack: number;
  bTrack: number;
  /** The id of the GFX track the clip landed on. */
  gfxTrackId: string;
  /** True iff a fresh GFX track was created. */
  createdTrack: boolean;
};

/** The main-tractor track index of a video track at `videoIndex` in
 *  `tracks.video`. Index 0 is the background producer; video tracks follow in
 *  order, then audio tracks. */
function mainTractorIndexOfVideo(videoIndex: number): number {
  return 1 + videoIndex;
}

/** Merge a consequence report into an accumulator (used to aggregate the ops). */
function mergeConsequences(acc: Consequences, next: Consequences): void {
  acc.clipsAdded.push(...next.clipsAdded);
  acc.clipsRemoved.push(...next.clipsRemoved);
  acc.clipsMoved.push(...next.clipsMoved);
  acc.clipsTrimmed.push(...next.clipsTrimmed);
  acc.blanksCreated.push(...next.blanksCreated);
  acc.blanksRemoved.push(...next.blanksRemoved);
  acc.ripple.push(...next.ripple);
  acc.durationDelta += next.durationDelta;
  acc.warnings.push(...next.warnings);
}

/** Empty consequence accumulator (local copy — keeps this helper dependency-thin
 *  over the ops barrel's noConsequences shape). */
function emptyConsequences(): Consequences {
  return {
    clipsAdded: [],
    clipsRemoved: [],
    clipsMoved: [],
    clipsTrimmed: [],
    blanksCreated: [],
    blanksRemoved: [],
    ripple: [],
    durationDelta: 0,
    warnings: [],
  };
}

/**
 * Compose a graphic overlay onto a timeline. Returns the new state, the
 * aggregated consequences, and the ordered inverse sequence — OR an EditError
 * (typed precondition: no video track to overlay onto, an overwrite that hits a
 * dissolve, etc.). Pure: never mutates `state`.
 */
export function addGraphic(state: Timeline, args: AddGraphicArgs): AddGraphicResult | EditError {
  const label = args.label ?? "graphic";
  const blendService = args.blendService ?? "qtblend";
  const playLen = args.durationFrames;

  const aggregate = emptyConsequences();
  const inverseStack: OpInvocation[] = [];
  let work = state;

  // ── Step 1: ensure a GFX (overlay) video track at the BOTTOM of the array. ──
  // The base footage stays the top of `tracks.video` (lowest main-tractor index);
  // the overlay belongs at the BOTTOM of the array (highest index = top melt
  // compositing layer). A fresh GFX track is APPENDED (`position:"bottom"`). We
  // create one when forced, or when there is only the single base footage track;
  // otherwise we reuse the existing bottom-most video track as the graphics track.
  const hasGraphicsTrack = state.tracks.video.length > 1 && !args.newTrack;
  let createdTrack = false;
  let gfxVideoIndex: number;
  let gfxTrackId: string;

  if (hasGraphicsTrack) {
    // Reuse the existing BOTTOM video track (highest index = top layer) as GFX.
    const lastIndex = state.tracks.video.length - 1;
    const bottom = state.tracks.video[lastIndex];
    if (!bottom) {
      return { kind: "precondition", detail: "addGraphic: no video track to overlay onto" };
    }
    gfxVideoIndex = lastIndex;
    gfxTrackId = bottom.id;
  } else {
    if (state.tracks.video.length === 0) {
      return {
        kind: "precondition",
        detail: "addGraphic: timeline has no footage video track to composite over",
      };
    }
    const addInv: OpInvocation = {
      op: "addTrack",
      args: { kind: "video", name: "GFX", position: "bottom" },
    };
    const added = apply(addInv, work);
    if (isEditError(added)) return added;
    work = added.state;
    mergeConsequences(aggregate, added.consequences);
    inverseStack.push(added.inverse);
    createdTrack = true;
    // The fresh track APPENDED → it is now the last (highest-index) video track.
    const lastIndex = work.tracks.video.length - 1;
    const bottom = work.tracks.video[lastIndex];
    if (!bottom) {
      return { kind: "precondition", detail: "addGraphic: GFX track add did not register" };
    }
    gfxVideoIndex = lastIndex;
    gfxTrackId = bottom.id;
  }

  // ── Step 2: overwrite the alpha clip at `position` on the GFX track. ──
  // Mint a runtime-unique uuid (NOT the deterministic authoring counter, which
  // resets to clip-0 at the start of every one-shot CLI process — two add-graphic
  // calls would then collide on `clip-0`, making the returned inverse ambiguous).
  // Identity = stable producer uuids (AGENTS.md load-bearing invariant).
  const overlayClip = buildClip(args.clipPath, {
    id: uuid(),
    in: 0,
    out: playLen - 1,
    length: playLen,
    label: `${label}:${args.clipPath}`,
    // A NEW baked overlay carries its Remotion identity so the viewer recognizes
    // it as a footage-composited overlay; flows verbatim onto Clip.composition.
    ...(args.composition ? { composition: args.composition } : {}),
  });
  const overwriteInv: OpInvocation = {
    op: "overwrite",
    args: { track: { trackId: gfxTrackId }, clip: overlayClip, position: args.position },
  };
  const stamped = apply(overwriteInv, work);
  if (isEditError(stamped)) return stamped;
  work = stamped.state;
  mergeConsequences(aggregate, stamped.consequences);
  inverseStack.push(stamped.inverse);

  // ── Step 3: push a qtblend field transition compositing GFX over footage. ──
  // A track is index `1 + (its position in [...video, ...audio])`. melt composites
  // `a=<lower index> b=<higher index>` with the HIGHER index ON TOP. The footage
  // (A, base) is the TOP of the array = the LOWEST video index; the GFX overlay
  // (B, on top) is the bottom of the array = the HIGHEST index (`gfxVideoIndex`).
  // So a_track = footage (lower) and b_track = overlay (higher) — the overlay
  // renders over the footage and its transparent regions reveal the footage.
  const footageVideoIndex = 0; // base footage = top of tracks.video = lowest index
  const aTrack = mainTractorIndexOfVideo(footageVideoIndex);
  const bTrack = mainTractorIndexOfVideo(gfxVideoIndex);
  const inn = args.position;
  const out = args.position + playLen - 1;
  const fieldTransition: Transition = buildTransition(blendService, aTrack, bTrack, inn, out, {});

  const pushInv: OpInvocation = { op: "pushTransition", args: { transition: fieldTransition } };
  const pushed = apply(pushInv, work);
  if (isEditError(pushed)) return pushed;
  work = pushed.state;
  mergeConsequences(aggregate, pushed.consequences);
  inverseStack.push(pushed.inverse);

  // If a track was added while transitions already existed, the index-shift
  // warning from addTrack is already in `aggregate.warnings`; surface a clear
  // note that the qtblend indices are computed AFTER the add.
  if (createdTrack && state.transitions.length > 0) {
    const warning: Warning = {
      code: "graphic-track-added-with-existing-transitions",
      detail:
        "a GFX track was added while field transitions already existed; their integer indices shifted (the qtblend overlay was indexed against the post-add track order)",
    };
    aggregate.warnings.push(warning);
  }

  return {
    state: work,
    consequences: aggregate,
    // UNDO order is the reverse of apply order.
    inverse: [...inverseStack].reverse(),
    aTrack,
    bTrack,
    gfxTrackId,
    createdTrack,
  };
}
