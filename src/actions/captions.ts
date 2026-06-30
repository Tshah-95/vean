// add_captions — lay a CAPTION TRACK over the footage from a frame-exact
// `Transcript`. Like `./graphic` (addGraphic), this is a pure(ish) helper that
// COMPOSES existing ops (addTrack + overwrite + pushTransition), so undo,
// consequences, and the inverse come for free and the edit algebra stays pure. It
// adds NO new op kind: a caption is an ordinary transparent ALPHA clip on an
// upper video track, carrying an MLT `dynamictext` filter with the segment text,
// composited over the footage with a `qtblend` field transition — every piece
// already in the IR.
//
// One caption clip per transcript SEGMENT (the caption-sized run), placed at the
// segment's [startFrame, endFrame] timeline span (frame-exact, from the
// transcript). The clips land on a single dedicated caption track at the BOTTOM
// of `tracks.video` (= the highest main-tractor index = the TOP compositing
// layer), exactly the overlay convention `./graphic` documents: the footage stays
// the base, the caption's transparent regions reveal it.
//
// Compositing model (load-bearing — same as `./graphic`): melt composites a
// `qtblend a=<lower index> b=<higher index>` with the HIGHER index ON TOP, so the
// caption overlay (B) goes at the highest video index and the footage (A) stays
// the lowest. One field transition spans the whole captioned region so the
// overlay track composites over the footage for every caption.
//
// The inverse is the composed sequence of the underlying ops' inverses, reversed
// (UNDO order), so a captioned timeline reverts to the exact original.
import {
  colorClip as buildColorClip,
  filter as buildFilter,
  transition as buildTransition,
  uuid,
} from "../ir/builder";
import type { Filter, Timeline, Transition } from "../ir/types";
import { apply } from "../ops";
import type { Consequences, EditError, OpInvocation } from "../ops/types";
import { isEditError } from "../ops/types";
import type { Transcript } from "../transcript";

/** MLT's text-overlay filter. `argument` is the caption text; geometry/size are
 *  sensible defaults a later dial pass can expose. Kept here (not a brand import)
 *  so the action is standalone. */
const DYNAMICTEXT_SERVICE = "dynamictext";

export type AddCaptionsArgs = {
  /** The frame-exact transcript to caption from (stable ids, integer frames). */
  transcript: Transcript;
  /** Force a fresh caption track even if a bottom GFX/overlay track already exists. */
  newTrack?: boolean;
  /** Cross-track blend service for the field transition (default qtblend). */
  blendService?: string;
  /** Overlay color the transparent caption clip is built from (default fully
   *  transparent — the text filter paints the glyphs; the rest reveals footage). */
  bgColor?: string;
  /** dynamictext properties to merge onto every caption (font size, geometry,
   *  color). Sensible defaults applied; caller overrides win. */
  textProps?: Record<string, string | number>;
};

export type AddCaptionsResult = {
  state: Timeline;
  consequences: Consequences;
  /** The ordered inverse sequence (UNDO order: reverse of the apply order). */
  inverse: OpInvocation[];
  /** The id of the caption track the clips landed on. */
  captionTrackId: string;
  /** True iff a fresh caption track was created. */
  createdTrack: boolean;
  /** Number of caption clips laid (== captionable segments). */
  captionCount: number;
};

/** Empty consequence accumulator (local copy — mirrors `./graphic`, keeps this
 *  helper dependency-thin over the ops barrel's noConsequences shape). */
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

/** Merge a consequence report into an accumulator. */
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

/** The main-tractor track index of a video track at `videoIndex` (index 0 is the
 *  background producer; video tracks follow in order). Mirrors `./graphic`. */
function mainTractorIndexOfVideo(videoIndex: number): number {
  return 1 + videoIndex;
}

/** Build the dynamictext filter for one caption line. Defaults give a readable,
 *  bottom-centered caption; `textProps` overrides win. */
function captionFilter(text: string, textProps?: Record<string, string | number>): Filter {
  return buildFilter(DYNAMICTEXT_SERVICE, {
    // The caption string. (`#timecode#` etc. are dynamictext macros; a literal
    // string is passed verbatim.)
    argument: text,
    // Sensible defaults: bottom-center, white on a subtle pad, mid-size.
    geometry: "0%/80%:100%x20%:100",
    size: 48,
    fgcolour: "#ffffffff",
    bgcolour: "#00000000",
    halign: "center",
    valign: "bottom",
    ...(textProps ?? {}),
  });
}

/**
 * Lay a caption track over the footage from `transcript`. Returns the new state,
 * the aggregated consequences, and the ordered inverse sequence — OR an EditError
 * (no footage track to overlay onto, an overwrite hitting a dissolve, etc.).
 * Pure: never mutates `state`.
 */
export function addCaptions(state: Timeline, args: AddCaptionsArgs): AddCaptionsResult | EditError {
  const blendService = args.blendService ?? "qtblend";
  const bgColor = args.bgColor ?? "#00000000";

  // Only segments with real text + a valid span are captionable.
  const segments = args.transcript.segments.filter(
    (s) => s.text.trim().length > 0 && s.endFrame >= s.startFrame,
  );
  if (segments.length === 0) {
    return { kind: "precondition", detail: "addCaptions: transcript has no captionable segments" };
  }

  const aggregate = emptyConsequences();
  const inverseStack: OpInvocation[] = [];
  let work = state;

  // ── Step 1: ensure a caption (overlay) video track at the BOTTOM of the array. ──
  // Same convention as addGraphic: the base footage is the TOP of tracks.video
  // (lowest main-tractor index); the overlay belongs at the BOTTOM (highest index =
  // top melt compositing layer). Reuse the existing bottom video track unless
  // `newTrack` forces a fresh one or there's only the single base footage track.
  if (state.tracks.video.length === 0) {
    return {
      kind: "precondition",
      detail: "addCaptions: timeline has no footage video track to caption over",
    };
  }
  const hasOverlayTrack = state.tracks.video.length > 1 && !args.newTrack;
  let createdTrack = false;
  let captionVideoIndex: number;
  let captionTrackId: string;

  if (hasOverlayTrack) {
    const lastIndex = state.tracks.video.length - 1;
    const bottom = state.tracks.video[lastIndex];
    if (!bottom) {
      return { kind: "precondition", detail: "addCaptions: no video track to overlay onto" };
    }
    captionVideoIndex = lastIndex;
    captionTrackId = bottom.id;
  } else {
    const addInv: OpInvocation = {
      op: "addTrack",
      args: { kind: "video", name: "CAPTIONS", position: "bottom" },
    };
    const added = apply(addInv, work);
    if (isEditError(added)) return added;
    work = added.state;
    mergeConsequences(aggregate, added.consequences);
    inverseStack.push(added.inverse);
    createdTrack = true;
    const lastIndex = work.tracks.video.length - 1;
    const bottom = work.tracks.video[lastIndex];
    if (!bottom) {
      return { kind: "precondition", detail: "addCaptions: caption track add did not register" };
    }
    captionVideoIndex = lastIndex;
    captionTrackId = bottom.id;
  }

  // ── Step 2: overwrite one transparent caption clip per segment at its span. ──
  // Each clip carries a dynamictext filter with the segment text and lands at the
  // segment's frame-exact [startFrame, endFrame] window (overwrite, not insert —
  // an overlay must not ripple the footage). Mint a runtime-unique uuid per clip
  // (NOT the authoring counter, which resets per process — two captions would
  // collide). Captions are laid in DOCUMENT order; overwrite onto blank/each other
  // is stable.
  let lastCaptionEnd = 0;
  for (const seg of segments) {
    const playLen = seg.endFrame - seg.startFrame + 1;
    // A transparent color clip (service "color", 0-based window, length == play)
    // the dynamictext filter paints the caption glyphs onto. `colorClip` is the
    // builder's color path — it sets service/in/out/length correctly. Mint a
    // runtime-unique uuid (NOT the authoring counter, which resets per process —
    // two captions would collide on the same id).
    const captionClip = buildColorClip(playLen, bgColor, {
      id: uuid(),
      filters: [captionFilter(seg.text.trim(), args.textProps)],
      label: `caption:${seg.id}`,
    });

    const overwriteInv: OpInvocation = {
      op: "overwrite",
      args: { track: { trackId: captionTrackId }, clip: captionClip, position: seg.startFrame },
    };
    const stamped = apply(overwriteInv, work);
    if (isEditError(stamped)) return stamped;
    work = stamped.state;
    mergeConsequences(aggregate, stamped.consequences);
    inverseStack.push(stamped.inverse);
    lastCaptionEnd = Math.max(lastCaptionEnd, seg.endFrame);
  }

  // ── Step 3: push ONE qtblend field transition over the whole captioned region. ──
  // A track is index `1 + (its position in [...video, ...audio])`. melt composites
  // `a=<lower> b=<higher>` with the HIGHER index on top, so the caption overlay (B,
  // highest index) renders over the footage (A, lowest index) and its transparent
  // regions reveal the footage. One transition spanning [firstStart, lastEnd]
  // composites the overlay track for every caption beneath it.
  const footageVideoIndex = 0;
  const aTrack = mainTractorIndexOfVideo(footageVideoIndex);
  const bTrack = mainTractorIndexOfVideo(captionVideoIndex);
  const firstStart = (segments[0] as { startFrame: number }).startFrame;
  const fieldTransition: Transition = buildTransition(
    blendService,
    aTrack,
    bTrack,
    firstStart,
    lastCaptionEnd,
    {},
  );
  const pushInv: OpInvocation = { op: "pushTransition", args: { transition: fieldTransition } };
  const pushed = apply(pushInv, work);
  if (isEditError(pushed)) return pushed;
  work = pushed.state;
  mergeConsequences(aggregate, pushed.consequences);
  inverseStack.push(pushed.inverse);

  return {
    state: work,
    consequences: aggregate,
    inverse: [...inverseStack].reverse(),
    captionTrackId,
    createdTrack,
    captionCount: segments.length,
  };
}
