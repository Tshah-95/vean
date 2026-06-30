// EDITORIAL MACROS — task-shaped composites the agent reaches for by INTENT
// ("put this b-roll over that line", "duck the music under the VO", "tighten this
// cut", "kill the dead air"), each compiling DOWN to the existing pure edit
// algebra. Nothing here is a new op kind and nothing edits clip properties at the
// low level when a macro can express it: this is the "never drop to a low-level
// property edit when applyLayout works" rule (Palmier's north star) made real.
//
// Every macro is a PURE helper (like `src/actions/graphic.ts` and
// `src/actions/timelineBuild.ts`): it takes a Timeline + typed args and returns
// either an EditError (a typed precondition) or `{ state, consequences, inverse }`
// where `inverse` is the ORDERED inverse sequence (UNDO order: reverse of apply).
// It threads state through the existing ops via `apply`, so undo/consequences come
// for FREE and the five edit-algebra laws hold by construction. The registry
// actions in `./registry.ts` parse → call the macro → serialize → write, exactly
// the way `timeline.addGraphic` wraps `addGraphic`.
//
// THE COMPOSITING MODEL (shared with graphic.ts, load-bearing): melt composites a
// `qtblend a=<lower index> b=<higher index>` with the HIGHER main-tractor index ON
// TOP. So an OVERLAY (b-roll / PiP) that must render over the talking-head footage
// belongs at the BOTTOM of `tracks.video` (= the HIGHEST index = the top layer);
// the talking-head footage stays the base (a LOWER index). A `qtblend` `rect`
// ("x% y% w% h% opacity", percentages of the canvas) positions + SCALES the
// overlay within the frame — that is the lever for a split-screen slot or a
// floating PiP, and the macro fills it with the CORRECT geometry so the subject
// fills its slot WITHOUT stretching (crop-to-fill, see `coverCropRect`).
//
// Track index across the main tractor is `1 + (position in [...video, ...audio])`
// (background producer at index 0 — see serialize.ts toMlt).
import { clip as buildClip, transition as buildTransition, uuid } from "../ir/builder";
import type { Clip, Profile, Timeline, Transition } from "../ir/types";
import { apply } from "../ops";
import { findClip, playtime, trackLength } from "../ops/primitives";
import type { Consequences, EditError, OpInvocation } from "../ops/types";
import { isEditError } from "../ops/types";

// ─── Shared composite plumbing ────────────────────────────────────────────────
/** The uniform result of an editorial macro: the new state, the aggregated
 *  consequence report, and the ordered inverse sequence (UNDO order). Mirrors
 *  `AddGraphicResult` / `AddFootageResult`; each macro extends it with its own
 *  facts (the created track id, the ducked clip, the trimmed frames). */
export type MacroResult = {
  state: Timeline;
  consequences: Consequences;
  /** The ordered inverse sequence (UNDO order: reverse of the apply order). */
  inverse: OpInvocation[];
};

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

/** A tiny state-threading accumulator the macros build on: apply an op, merge its
 *  consequences, push its inverse onto the stack, and advance `state`. A step that
 *  errors short-circuits — `composer.error` carries the first EditError, and the
 *  macro returns it. Keeps every macro to "build the step list, then finalize"
 *  instead of repeating the merge/inverse/error boilerplate per op. */
class Composer {
  state: Timeline;
  readonly consequences = emptyConsequences();
  private readonly inverseStack: OpInvocation[] = [];
  error: EditError | undefined;

  constructor(initial: Timeline) {
    this.state = initial;
  }

  /** Apply `inv` to the current state. Returns true on success (state advanced);
   *  on failure stores `error` and returns false (subsequent steps are skipped by
   *  the caller's `if (!composer.step(...)) ...` guard or `composer.ok`). */
  step(inv: OpInvocation): boolean {
    if (this.error) return false;
    const result = apply(inv, this.state);
    if (isEditError(result)) {
      this.error = result;
      return false;
    }
    this.state = result.state;
    mergeConsequences(this.consequences, result.consequences);
    this.inverseStack.push(result.inverse);
    return true;
  }

  get ok(): boolean {
    return this.error === undefined;
  }

  /** Finalize into a MacroResult (inverse reversed into UNDO order). */
  finish(): MacroResult {
    return {
      state: this.state,
      consequences: this.consequences,
      inverse: [...this.inverseStack].reverse(),
    };
  }
}

/** The 0-based main-tractor index of the video track at `videoIndex` in
 *  `tracks.video` (index 0 = background producer; video tracks follow in order). */
function mainTractorIndexOfVideo(videoIndex: number): number {
  return 1 + videoIndex;
}

// ─── Crop-to-fill geometry (the "subject fills the slot without stretching") ──
/** A qtblend `rect` ("x% y% w% h% opacity") that places a source into a SLOT of
 *  the canvas. The slot is given in canvas fractions `[0..1]`. qtblend scales the
 *  source to the rect's w×h; to AVOID stretching, the macro sizes the slot to the
 *  source's own aspect where it can, and otherwise the caller crops the source
 *  first (see `coverCropRect`). Percentages keep the geometry canvas-relative, so
 *  the same macro is correct at 9:16, 1:1, and 16:9 without per-profile math (the
 *  diagnostics `RECT_PROPS` upscaling check also skips `%` rects, by design). */
function slotRect(slot: { x: number; y: number; w: number; h: number }, opacity = 1): string {
  const pct = (n: number) => `${+(n * 100).toFixed(4)}%`;
  return `${pct(slot.x)} ${pct(slot.y)} ${pct(slot.w)} ${pct(slot.h)} ${opacity}`;
}

/** An `affine` filter `transition.rect` that crops a source to COVER a target
 *  aspect ratio (slot w:h), centered, so when qtblend then scales it into the slot
 *  the subject FILLS the slot without distortion (object-fit: cover). Expressed in
 *  PERCENT of the source frame so it is resolution-independent. When the source
 *  aspect already matches the slot, the crop is the full frame (a no-op cover). */
function coverCropRect(profile: Profile, slot: { w: number; h: number }): string {
  // Source display aspect (square pixels across all presets — see profile.ts).
  const srcAR = profile.width / profile.height;
  const slotAR = (slot.w * profile.width) / (slot.h * profile.height);
  let cropW = 1;
  let cropH = 1;
  if (srcAR > slotAR) {
    // Source is WIDER than the slot — crop the sides (keep full height).
    cropW = slotAR / srcAR;
  } else if (srcAR < slotAR) {
    // Source is TALLER than the slot — crop top/bottom (keep full width).
    cropH = srcAR / slotAR;
  }
  const x = (1 - cropW) / 2;
  const y = (1 - cropH) / 2;
  const pct = (n: number) => `${+(n * 100).toFixed(4)}%`;
  return `${pct(x)} ${pct(y)} ${pct(cropW)} ${pct(cropH)} 1`;
}

// ─── Track resolution helpers (find / create an overlay track) ────────────────
/** Ensure an upper (overlay) video track exists for compositing, via the
 *  `addTrack position:"bottom"` op (APPEND = highest main-tractor index = top melt
 *  layer). Reuses the existing bottom-most video track UNLESS `forceNew` or there
 *  is only the single base footage track. Returns the resolved overlay video index
 *  + track id, and whether a fresh track was created. Threads through `composer`. */
function ensureOverlayTrack(
  composer: Composer,
  forceNew: boolean,
): { videoIndex: number; trackId: string; created: boolean } | EditError {
  const videoTracks = composer.state.tracks.video;
  if (videoTracks.length === 0) {
    return { kind: "precondition", detail: "no footage video track to composite an overlay over" };
  }
  const hasOverlayTrack = videoTracks.length > 1 && !forceNew;
  if (hasOverlayTrack) {
    const lastIndex = videoTracks.length - 1;
    const bottom = videoTracks[lastIndex];
    if (!bottom) return { kind: "precondition", detail: "overlay track vanished mid-resolve" };
    return { videoIndex: lastIndex, trackId: bottom.id, created: false };
  }
  if (
    !composer.step({ op: "addTrack", args: { kind: "video", name: "GFX", position: "bottom" } })
  ) {
    return composer.error ?? { kind: "precondition", detail: "could not add an overlay track" };
  }
  const lastIndex = composer.state.tracks.video.length - 1;
  const bottom = composer.state.tracks.video[lastIndex];
  if (!bottom) return { kind: "precondition", detail: "overlay track add did not register" };
  return { videoIndex: lastIndex, trackId: bottom.id, created: true };
}

// ─── applyLayout ──────────────────────────────────────────────────────────────
/** The talking-head + b-roll layouts the macro understands. The geometry of each
 *  is filled with the CORRECT crop so the subject fills its slot without stretch:
 *   • "intercut"  — a straight b-roll cut: the b-roll OVERWRITES the base footage
 *     full-frame over the range (cropped to COVER the canvas, no letterbox). The
 *     talking head is hidden for the duration — the classic editorial cutaway.
 *   • "split"     — a stacked split-screen: talking head in the TOP half, b-roll
 *     in the BOTTOM half (each cropped to cover its half-canvas slot).
 *   • "overlay"   — a floating PiP: the b-roll in a small inset (default
 *     bottom-right quarter), composited OVER the full-frame talking head. */
export type LayoutMode = "intercut" | "split" | "overlay";

export type ApplyLayoutArgs = {
  /** The b-roll / overlay source path. */
  brollResource: string;
  /** Layout mode (see `LayoutMode`). */
  mode: LayoutMode;
  /** Timeline frame the layout starts at. */
  position: number;
  /** Frames the layout spans. */
  durationFrames: number;
  /** Source in-point of the b-roll (default 0). */
  inFrame?: number;
  /** For "overlay": the inset slot as canvas fractions. Defaults to a
   *  bottom-right quarter with a small margin. */
  insetSlot?: { x: number; y: number; w: number; h: number };
  /** Force a fresh overlay track even if one exists. */
  newTrack?: boolean;
  /** Cross-track blend service (default qtblend). */
  blendService?: string;
};

export type ApplyLayoutResult = MacroResult & {
  mode: LayoutMode;
  /** The id of the overlay (b-roll) track. */
  overlayTrackId: string;
  /** Whether a fresh overlay track was created. */
  createdTrack: boolean;
  /** The qtblend a/b main-tractor indices (footage = a/lower, b-roll = b/upper). */
  aTrack: number;
  bTrack: number;
};

/** The canvas slots each mode places the talking head + b-roll into (canvas
 *  fractions). "intercut" puts the b-roll full-frame (it covers the head). */
const SPLIT_TOP = { x: 0, y: 0, w: 1, h: 0.5 };
const SPLIT_BOTTOM = { x: 0, y: 0.5, w: 1, h: 0.5 };
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const DEFAULT_INSET = { x: 0.62, y: 0.62, w: 0.34, h: 0.34 };

/**
 * Lay out a talking-head + b-roll relationship over `[position, position+
 * durationFrames)`. Composes existing ops only: ensure an overlay track (addTrack),
 * overwrite the b-roll clip onto it (overwrite), crop the b-roll to cover its slot
 * (addFilter with an affine `transition.rect`), and composite it with a qtblend
 * field transition whose `rect` positions it into the slot (pushTransition). For
 * "split" the talking head is ALSO scaled into its half-slot via a second qtblend
 * on the base footage. Pure; returns an EditError on a typed precondition.
 */
export function applyLayout(state: Timeline, args: ApplyLayoutArgs): ApplyLayoutResult | EditError {
  const blendService = args.blendService ?? "qtblend";
  const inFrame = args.inFrame ?? 0;
  const playLen = args.durationFrames;
  if (playLen <= 0) {
    return {
      kind: "invalid-args",
      detail: `applyLayout: durationFrames must be > 0 (got ${playLen})`,
    };
  }
  const profile = state.profile;
  const composer = new Composer(state);

  // ── 1. Ensure an overlay (b-roll) video track at the bottom (top melt layer). ──
  const overlay = ensureOverlayTrack(composer, args.newTrack ?? false);
  if ("kind" in overlay) return overlay;

  // ── 2. Overwrite the b-roll clip onto the overlay track at `position`. ──
  // A fresh runtime uuid (not the deterministic counter — two macro calls in one
  // process would otherwise collide on clip-0; identity = stable producer uuids).
  const brollId = uuid();
  const brollClip = buildClip(args.brollResource, {
    id: brollId,
    in: inFrame,
    out: inFrame + playLen - 1,
    length: inFrame + playLen,
    label: `broll:${args.brollResource}`,
  });
  if (
    !composer.step({
      op: "overwrite",
      args: { track: { trackId: overlay.trackId }, clip: brollClip, position: args.position },
    })
  ) {
    return composer.error ?? { kind: "precondition", detail: "applyLayout: overwrite failed" };
  }

  // ── 3. Crop the b-roll to COVER its slot (no stretch). ──
  // The slot the b-roll fills depends on the mode; crop the source to that slot's
  // aspect so the qtblend scale fills it without distortion.
  const brollSlot =
    args.mode === "split"
      ? SPLIT_BOTTOM
      : args.mode === "overlay"
        ? (args.insetSlot ?? DEFAULT_INSET)
        : FULL;
  const brollCrop = coverCropRect(profile, brollSlot);
  if (
    !composer.step({
      op: "addFilter",
      args: {
        uuid: brollId,
        filter: {
          service: "affine",
          properties: { "transition.rect": brollCrop },
          shotcutName: "Size, Position & Rotate",
        },
      },
    })
  ) {
    return composer.error ?? { kind: "precondition", detail: "applyLayout: b-roll crop failed" };
  }

  // ── 4. Composite the b-roll over the talking head with a qtblend `rect`. ──
  // Footage (base) = top of tracks.video (lowest index); b-roll overlay = bottom
  // (highest index). melt renders the higher index on top, so a=footage, b=broll.
  const footageVideoIndex = 0;
  const aTrack = mainTractorIndexOfVideo(footageVideoIndex);
  const bTrack = mainTractorIndexOfVideo(overlay.videoIndex);
  const inn = args.position;
  const out = args.position + playLen - 1;
  const opacity = 1;
  const brollTransition: Transition = buildTransition(blendService, aTrack, bTrack, inn, out, {
    rect: slotRect(brollSlot, opacity),
    compositing: 0,
  });
  if (!composer.step({ op: "pushTransition", args: { transition: brollTransition } })) {
    return composer.error ?? { kind: "precondition", detail: "applyLayout: composite failed" };
  }

  // ── 5. For "split", also scale the talking head into the TOP half. ──
  // The base footage is the lowest index; a self-composite onto the background
  // (index 0) with the top-half rect tucks the head into its slot, leaving the
  // bottom half for the b-roll. (intercut/overlay leave the head full-frame.)
  if (args.mode === "split") {
    const headTransition: Transition = buildTransition(
      blendService,
      mainTractorIndexOfVideo(footageVideoIndex) - 1, // background (index 0) as base
      aTrack, // the talking head
      inn,
      out,
      { rect: slotRect(SPLIT_TOP, 1), compositing: 0 },
    );
    if (!composer.step({ op: "pushTransition", args: { transition: headTransition } })) {
      return composer.error ?? { kind: "precondition", detail: "applyLayout: head split failed" };
    }
  }

  const finished = composer.finish();
  return {
    ...finished,
    mode: args.mode,
    overlayTrackId: overlay.trackId,
    createdTrack: overlay.created,
    aTrack,
    bTrack,
  };
}

// ─── addBrollOverRange ────────────────────────────────────────────────────────
/** Drop b-roll over a [startFrame, endFrame] range as a full-frame cutaway —
 *  thin sugar over `applyLayout` in "intercut" mode addressing the range by
 *  endpoints rather than position+duration (the way an agent thinks about a line
 *  of VO: "cover frames 120–240"). */
export type AddBrollOverRangeArgs = {
  brollResource: string;
  startFrame: number;
  endFrame: number;
  inFrame?: number;
  mode?: LayoutMode;
  insetSlot?: { x: number; y: number; w: number; h: number };
  newTrack?: boolean;
  blendService?: string;
};

export function addBrollOverRange(
  state: Timeline,
  args: AddBrollOverRangeArgs,
): ApplyLayoutResult | EditError {
  if (args.endFrame < args.startFrame) {
    return {
      kind: "invalid-args",
      detail: `addBrollOverRange: endFrame (${args.endFrame}) must be >= startFrame (${args.startFrame})`,
    };
  }
  return applyLayout(state, {
    brollResource: args.brollResource,
    mode: args.mode ?? "intercut",
    position: args.startFrame,
    durationFrames: args.endFrame - args.startFrame + 1,
    ...(args.inFrame != null ? { inFrame: args.inFrame } : {}),
    ...(args.insetSlot ? { insetSlot: args.insetSlot } : {}),
    ...(args.newTrack != null ? { newTrack: args.newTrack } : {}),
    ...(args.blendService ? { blendService: args.blendService } : {}),
  });
}

// ─── duckMusicUnderSpeech ─────────────────────────────────────────────────────
/** Duck a music bed under speech by lowering the music clip's gain. Gap-based (no
 *  silence/transcript in this lane): the macro lowers the WHOLE targeted music
 *  clip(s) by `duckDb` via the existing `gain` op, the canonical "music sits under
 *  the VO" move. Target by explicit clip uuid, or let the macro duck every clip on
 *  the named (or first) audio track that is NOT the speech track. */
export type DuckMusicArgs = {
  /** Explicit music clip uuids to duck; when omitted, every clip on `musicTrackId`
   *  (or the first audio track that isn't `speechTrackId`). */
  musicClipIds?: string[];
  /** The music track id (used when `musicClipIds` is omitted). */
  musicTrackId?: string;
  /** The speech/VO track id to EXCLUDE when auto-selecting the music track. */
  speechTrackId?: string;
  /** How far to duck, in dB (negative = quieter). Default -12 dB. */
  duckDb?: number;
};

export type DuckMusicResult = MacroResult & {
  /** The clip ids that were ducked. */
  duckedClipIds: string[];
  duckDb: number;
};

export function duckMusicUnderSpeech(
  state: Timeline,
  args: DuckMusicArgs,
): DuckMusicResult | EditError {
  const duckDb = args.duckDb ?? -12;

  // Resolve the set of music clip ids to duck.
  let clipIds: string[];
  if (args.musicClipIds && args.musicClipIds.length > 0) {
    clipIds = args.musicClipIds;
  } else {
    // Pick the music track: the named one, else the first audio track that isn't
    // the speech track, else the first audio track.
    const audio = state.tracks.audio;
    if (audio.length === 0) {
      return { kind: "precondition", detail: "duckMusicUnderSpeech: no audio track to duck" };
    }
    let musicTrack = args.musicTrackId
      ? audio.find((t) => t.id === args.musicTrackId)
      : audio.find((t) => t.id !== args.speechTrackId);
    musicTrack ??= audio[0];
    if (!musicTrack) {
      return {
        kind: "precondition",
        detail: "duckMusicUnderSpeech: could not resolve a music track",
      };
    }
    clipIds = musicTrack.items.filter((it): it is Clip => it.kind === "clip").map((c) => c.id);
  }
  if (clipIds.length === 0) {
    return { kind: "precondition", detail: "duckMusicUnderSpeech: no music clips to duck" };
  }

  const composer = new Composer(state);
  const ducked: string[] = [];
  for (const uuid of clipIds) {
    // Compute the absolute target gain in dB: the clip's CURRENT gain + duckDb, so
    // the duck is relative (a clip already at -3 dB ducks to -15, not to -12).
    const loc = findClip(composer.state, uuid);
    if (!loc) return { kind: "clip-not-found", uuid };
    const currentDb = loc.clip.gain != null ? 20 * Math.log10(loc.clip.gain) : 0;
    const targetDb = currentDb + duckDb;
    if (!composer.step({ op: "gain", args: { uuid, db: targetDb } })) {
      return (
        composer.error ?? { kind: "precondition", detail: "duckMusicUnderSpeech: gain failed" }
      );
    }
    ducked.push(uuid);
  }

  return { ...composer.finish(), duckedClipIds: ducked, duckDb };
}

// ─── tightenCut ───────────────────────────────────────────────────────────────
/** Tighten a cut by trimming dead frames off a clip's edges — the editorial "lose
 *  the slack before/after the line". Composes the existing `trimIn` / `trimOut`
 *  ops (positive delta = trim shorter): `headFrames` off the head (trimIn),
 *  `tailFrames` off the tail (trimOut). Non-ripple by default (grows the
 *  neighbouring blank so the rest of the track stays put); `ripple:true` pulls
 *  downstream content in. At least one of head/tail must be > 0. */
export type TightenCutArgs = {
  /** The clip to tighten. */
  uuid: string;
  /** Frames to trim off the HEAD (later start). Default 0. */
  headFrames?: number;
  /** Frames to trim off the TAIL (earlier end). Default 0. */
  tailFrames?: number;
  /** Ripple downstream content in to close the freed frames. Default false. */
  ripple?: boolean;
};

export type TightenCutResult = MacroResult & {
  uuid: string;
  headFrames: number;
  tailFrames: number;
};

export function tightenCut(state: Timeline, args: TightenCutArgs): TightenCutResult | EditError {
  const headFrames = args.headFrames ?? 0;
  const tailFrames = args.tailFrames ?? 0;
  if (headFrames < 0 || tailFrames < 0) {
    return { kind: "invalid-args", detail: "tightenCut: headFrames/tailFrames must be >= 0" };
  }
  if (headFrames === 0 && tailFrames === 0) {
    return {
      kind: "invalid-args",
      detail: "tightenCut: nothing to trim (head and tail are both 0)",
    };
  }
  const loc = findClip(state, args.uuid);
  if (!loc) return { kind: "clip-not-found", uuid: args.uuid };
  const play = playtime(loc.clip);
  if (headFrames + tailFrames >= play) {
    return {
      kind: "invalid-args",
      detail: `tightenCut: trimming ${headFrames}+${tailFrames} frames would consume the whole ${play}-frame clip`,
    };
  }

  const ripple = args.ripple ?? false;
  const composer = new Composer(state);
  // Trim the TAIL first (trimOut), then the HEAD (trimIn): trimming the tail leaves
  // the head's position fixed, so the head trim's geometry is unaffected by order.
  if (tailFrames > 0) {
    if (
      !composer.step({
        op: "trimOut",
        args: { uuid: args.uuid, delta: tailFrames, rippleAllTracks: ripple },
      })
    ) {
      return composer.error ?? { kind: "precondition", detail: "tightenCut: tail trim failed" };
    }
  }
  if (headFrames > 0) {
    if (
      !composer.step({
        op: "trimIn",
        args: { uuid: args.uuid, delta: headFrames, rippleAllTracks: ripple },
      })
    ) {
      return composer.error ?? { kind: "precondition", detail: "tightenCut: head trim failed" };
    }
  }

  return { ...composer.finish(), uuid: args.uuid, headFrames, tailFrames };
}

// ─── removeDeadAir ──────────────────────────────────────────────────────────────
/** Remove dead air (GAPS) on a track — the gap-based "kill the silence" pass (no
 *  silence-detection in this lane, so the macro operates on LITERAL blank gaps the
 *  track already carries: a pause an editor left, a lifted clip's hole). For each
 *  internal gap whose length is >= `minGapFrames`, it ripple-MOVES the clip after
 *  the gap left onto the gap start (the `move` op with `ripple:true`), pulling the
 *  rest of the track in. Leading gaps (before the first clip) are closed too.
 *  Trailing blanks are already dropped by the serializer, so they need no work.
 *
 *  Positions are recomputed from the THREADED state each step (a ripple shifts
 *  everything after it), so the math stays exact across multiple closes. Returns
 *  the closed-gap count + the total frames removed. */
export type RemoveDeadAirArgs = {
  /** The track (video or audio) to de-gap. Defaults to the first video track. */
  trackId?: string;
  /** Only close gaps at least this long (frames). Default 1 (every gap). */
  minGapFrames?: number;
};

export type RemoveDeadAirResult = MacroResult & {
  /** Number of gaps closed. */
  gapsClosed: number;
  /** Total frames of dead air removed. */
  framesRemoved: number;
  trackId: string;
};

export function removeDeadAir(
  state: Timeline,
  args: RemoveDeadAirArgs,
): RemoveDeadAirResult | EditError {
  const minGap = Math.max(1, args.minGapFrames ?? 1);

  // Resolve the target track id (default: first video track).
  let trackId = args.trackId;
  if (!trackId) {
    const firstVideo = state.tracks.video[0];
    if (!firstVideo) {
      return { kind: "precondition", detail: "removeDeadAir: no track to de-gap (no video track)" };
    }
    trackId = firstVideo.id;
  }
  // Validate the track exists (video or audio).
  const exists =
    state.tracks.video.some((t) => t.id === trackId) ||
    state.tracks.audio.some((t) => t.id === trackId);
  if (!exists) return { kind: "track-not-found", track: trackId };

  const composer = new Composer(state);
  let gapsClosed = 0;
  let framesRemoved = 0;

  // LEFT-TO-RIGHT COMPACTION. A `move` with `ripple:true` does NOT delete a gap —
  // it ripple-removes at the source (closing that gap) then ripple-inserts at the
  // destination (re-opening an equal gap), so it RELOCATES the gap rather than
  // removing it. The deletion primitive is a NON-RIPPLE move (`ripple:false` =
  // lift + overwrite-onto-blank): it slides one clip left onto the blank before it
  // WITHOUT disturbing downstream content. So we walk the clips IN ORDER, keeping a
  // `cursor` = the frame the next clip should butt up to (0 for the first clip,
  // else the previous clip's end). When a clip's current start is more than `minGap`
  // past the cursor, we move it back to the cursor (closing that gap). A pause
  // SHORTER than `minGap` is kept: we don't move the clip, and the cursor advances
  // to AFTER its current end so the rest of the track stays put relative to it.
  //
  // Re-resolving the clip ids up front (they're stable across the moves — non-ripple
  // move preserves uuids and never touches OTHER clips) lets us recompute each
  // clip's live position from the THREADED state right before its move, so the
  // geometry is exact even though earlier moves shifted the items array.
  const liveTrack = () =>
    composer.state.tracks.video.find((t) => t.id === trackId) ??
    composer.state.tracks.audio.find((t) => t.id === trackId);
  const track0 = liveTrack();
  if (!track0) return { kind: "track-not-found", track: trackId };
  const lengthBefore = trackLength(track0.items);
  const clipIds = track0.items.filter((it): it is Clip => it.kind === "clip").map((c) => c.id);

  let cursor = 0;
  for (const id of clipIds) {
    const track = liveTrack();
    if (!track) break;
    const loc = findClip(composer.state, id);
    if (!loc || loc.trackId !== trackId) continue; // defensive: clip moved away
    const start = loc.position;
    const gapLen = start - cursor;
    if (gapLen >= minGap) {
      // A real gap before this clip — slide it left onto the cursor (non-ripple).
      if (
        !composer.step({
          op: "move",
          args: {
            uuid: id,
            toTrack: { trackId },
            toPosition: cursor,
            ripple: false,
            rippleAllTracks: false,
          },
        })
      ) {
        return composer.error ?? { kind: "precondition", detail: "removeDeadAir: move failed" };
      }
      gapsClosed++;
      cursor += playtime(loc.clip);
    } else {
      // A sub-threshold pause (or no gap) — keep it; advance past this clip's
      // CURRENT end so we don't pull the rest of the track into the kept pause.
      cursor = start + playtime(loc.clip);
    }
  }

  // `framesRemoved` is the EXACT track-length delta, not a per-clip sum: a single
  // non-ripple move RELOCATES a leading gap downstream rather than deleting it, so
  // only the cumulative compaction (with trailing blanks dropped) actually shortens
  // the track. Measuring the real before/after length is the honest, unambiguous
  // count of dead air removed.
  const finalTrack = liveTrack();
  framesRemoved = finalTrack ? lengthBefore - trackLength(finalTrack.items) : 0;

  return { ...composer.finish(), gapsClosed, framesRemoved, trackId };
}
