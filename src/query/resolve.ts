/**
 * resolveValueAtFrame — "go-to-definition for video". Given a timeline, a target
 * parameter (a clip filter property, a clip's fade, or a field transition
 * property), and a TIMELINE frame, return the EFFECTIVE value at that frame AND
 * the resolution PATH (which scope produced it). This is the primary consumer of
 * the keyframe engine (`src/ir/keyframes.ts valueAtFrame`).
 *
 * SCOPE RESOLUTION ORDER (DESIGN-MOVE1.md / ROADMAP Move 1). A parameter's
 * effective value is resolved through nested scopes, innermost first:
 *   1. CLIP keyframes      — a filter property on the clip under the playhead.
 *   2. TRACK filters       — a filter on the clip's track (playlist-level).
 *   3. TRACTOR filters     — a filter on the main tractor (whole-timeline).
 *   4. TRANSITION          — a field transition's contribution at that frame.
 * The IR models clip filters + field transitions as first-class today; track and
 * tractor filters are not yet first-class IR (they arrive with a later Move), so
 * those scopes resolve to "no contribution" now — but the resolver already walks
 * the chain in order and NAMES the scope, so when the IR grows track/tractor
 * filters the resolver extends without changing its contract. This is exactly the
 * LSP "hover/go-to-definition over the timeline document" surface.
 *
 * Pure + document-keyed: no I/O, no melt. The value is computed from the graph
 * alone (the "static type-checker" half of the verification philosophy).
 */
import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "../ir/builder";
import {
  type KeyframeValue,
  type Keyframes,
  isAnimated,
  parseAnim,
  scalarOf,
  valueAtFrame,
} from "../ir/keyframes";
import type { Clip, Filter, Timeline, Transition } from "../ir/types";
import { dissolveConsumesAt, findClip, playtime, startOf } from "../ops/primitives";

// ─── The target: what parameter to resolve ────────────────────────────────────
/** A parameter to resolve, addressed at one of the four scopes. All address by
 *  STABLE identity (a clip uuid, a transition index), never an ephemeral index of
 *  a clip on a track. */
export type ResolveTarget =
  /** A property of a filter on a clip — `clip` by uuid, `service` the filter's MLT
   *  service (the first matching filter), `property` its key (e.g. `level`). */
  | { scope: "clip"; clip: string; service: string; property: string }
  /** A clip's fade (the `vean.fadeIn`/`vean.fadeOut` sentinel) resolved to its
   *  effective brightness/volume LEVEL (0..1) at the frame — the hot-path query. */
  | { scope: "fade"; clip: string; direction: "in" | "out" }
  /** A property of a field (cross-track) transition, by its index in
   *  `timeline.transitions`. */
  | { scope: "transition"; index: number; property: string };

// ─── The resolution path: which scope produced the value ───────────────────────
/** One hop in the resolution — the scope it resolved at + a human label. The
 *  array is the full chain the resolver walked; the LAST entry is the one that
 *  PRODUCED the returned value (`produced: true`). Earlier entries are scopes that
 *  were checked and did not contribute (so an LSP can show the search order). */
export type ResolutionHop = {
  scope: "clip" | "track" | "tractor" | "transition" | "fade";
  /** Human-readable locator (e.g. `clip "intro" filter brightness.level`). */
  label: string;
  /** True for the hop that produced the returned value. */
  produced: boolean;
  /** The clip/transition/track id this hop refers to, when applicable. */
  ref?: string;
};

/** The result of a resolve: the effective typed value, a scalar readout for the
 *  common single-number case, and the resolution path. `value` is `null` when the
 *  target doesn't exist or carries no value at that frame. */
export type ResolveResult = {
  /** The effective typed value at the frame (interpolated through the model). */
  value: KeyframeValue | null;
  /** A single-number readout of `value` (number → its value, rect → opacity,
   *  color → alpha 0..1, opaque/absent → null). The convenient hover number. */
  scalar: number | null;
  /** Whether the clip is even live at the requested frame (the playhead is over
   *  it). A query off the clip's window resolves to its clamped edge value but
   *  flags `live: false` so a caller knows the playhead isn't actually on it. */
  live: boolean;
  /** The scope chain walked, innermost-first; the `produced:true` hop is the
   *  winner. Empty only when the target itself was not found. */
  path: ResolutionHop[];
  /** Set when the target couldn't be located (clip/transition/filter missing). */
  notFound?: string;
};

// ─── Fade-sentinel → effective level (the hot path) ────────────────────────────
/** The effective fade level (0..1) at a clip-LOCAL frame for a fade of `frames`:
 *   • fadeIn:  ramps 0 → 1 over `[0, frames-1]`, then holds 1.
 *   • fadeOut: holds 1, then ramps 1 → 0 over `[len-frames, len-1]`.
 *  Mirrors the keyframe shape the serializer compiles (resolveFades), so the
 *  resolver agrees with what melt renders. */
function fadeLevelAt(
  direction: "in" | "out",
  fadeFrames: number,
  localFrame: number,
  len: number,
): number {
  if (fadeFrames <= 0) return 1;
  if (direction === "in") {
    if (localFrame <= 0) return 0;
    if (localFrame >= fadeFrames - 1) return 1;
    return localFrame / (fadeFrames - 1);
  }
  // fadeOut
  const tailStart = len - fadeFrames;
  if (localFrame <= tailStart) return 1;
  if (localFrame >= len - 1) return 0;
  return (len - 1 - localFrame) / (fadeFrames - 1);
}

/** The fade sentinel of the given direction on a clip, or `undefined`. */
function fadeSentinel(clip: Clip, direction: "in" | "out"): Filter | undefined {
  const service = direction === "in" ? FADE_IN_SERVICE : FADE_OUT_SERVICE;
  return clip.filters.find((f) => f.service === service);
}

function fadeFramesOf(f: Filter): number {
  const v = f.properties.frames;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─── A scalar/animated property → its value at a clip-local frame ──────────────
/** Resolve a single filter property to its typed value at clip-local `localFrame`.
 *  An ANIMATED string (contains `=`) is parsed + evaluated through the keyframe
 *  model (honoring markers/%/rect/color/negative/timecode); a static value is
 *  returned as its parsed constant. The keyframe model is evaluated with the clip's
 *  source `length` so a negative/relative keyframe time anchors correctly. */
function propertyValueAt(
  value: string | number,
  localFrame: number,
  length: number | undefined,
): KeyframeValue | null {
  const s = String(value);
  const model: Keyframes = parseAnim(s);
  if (!isAnimated(s)) return model.keyframes[0]?.value ?? null;
  return valueAtFrame(model, localFrame, { length });
}

// ─── resolveValueAtFrame ───────────────────────────────────────────────────────
/** Resolve the effective value of `target` at TIMELINE `frame`, returning the
 *  value + the resolution path (which scope produced it). Pure; computed from the
 *  IR graph alone. See the file header for the scope-resolution order. */
export function resolveValueAtFrame(
  state: Timeline,
  target: ResolveTarget,
  frame: number,
): ResolveResult {
  if (target.scope === "transition") {
    return resolveTransition(state, target, frame);
  }
  // Clip + fade targets both locate the clip first.
  const loc = findClip(state, target.clip);
  if (!loc) {
    return {
      value: null,
      scalar: null,
      live: false,
      path: [],
      notFound: `clip "${target.clip}" not found`,
    };
  }
  // `len` MUST be the clip's RENDERED span on the timeline, not its source
  // playtime — the two differ whenever an adjacent dissolve trims frames off the
  // clip's head/tail (those frames move into the nested lumaMix tractor). The
  // serializer anchors a fadeOut at `len - frames` over EXACTLY this rendered
  // length (serialize.ts: `len = (out - trimTail) - (in + trimHead) + 1`), and
  // melt paints the fade there — so the resolver must agree, or a dissolve-headed
  // clip's fadeOut lands `trimHead` frames late (past the real fade, and past the
  // end of the timeline). Mirror the serializer: subtract what each side's
  // dissolve consumes. `startOf` already returns the RENDERED start (it shares
  // dissolve overlaps), so a query frame maps to the rendered local frame.
  const items = state.tracks[loc.trackKind][loc.trackIndex]?.items ?? [];
  const trimHead = dissolveConsumesAt(items, loc.itemIndex, "before");
  const trimTail = dissolveConsumesAt(items, loc.itemIndex, "after");
  const len = playtime(loc.clip) - trimHead - trimTail;
  const clipStart = startOf(items, loc.itemIndex);
  const localFrame = frame - clipStart;
  const live = localFrame >= 0 && localFrame < len;
  // Clamp the local frame to the clip window for the value read (melt's edge
  // behavior); `live` records whether the playhead was actually on the clip.
  const clampedLocal = Math.max(0, Math.min(len - 1, localFrame));

  if (target.scope === "fade") {
    const sentinel = fadeSentinel(loc.clip, target.direction);
    if (!sentinel) {
      return {
        value: null,
        scalar: null,
        live,
        path: [
          {
            scope: "fade",
            label: `clip "${target.clip}" has no fade${target.direction === "in" ? "In" : "Out"}`,
            produced: false,
            ref: target.clip,
          },
        ],
        notFound: `clip "${target.clip}" has no fade-${target.direction}`,
      };
    }
    const level = fadeLevelAt(target.direction, fadeFramesOf(sentinel), clampedLocal, len);
    const value: KeyframeValue = { type: "number", value: level };
    return {
      value,
      scalar: level,
      live,
      path: [
        {
          scope: "fade",
          label: `clip "${target.clip}" fade${target.direction === "in" ? "In" : "Out"} level`,
          produced: true,
          ref: target.clip,
        },
      ],
    };
  }

  // target.scope === "clip": walk the scope chain innermost-first.
  const path: ResolutionHop[] = [];

  // (1) CLIP keyframes — the filter property on the clip under the playhead.
  const filter = loc.clip.filters.find((f) => f.service === target.service);
  if (filter && target.property in filter.properties) {
    const value = propertyValueAt(
      filter.properties[target.property] as string | number,
      clampedLocal,
      loc.clip.length,
    );
    path.push({
      scope: "clip",
      label: `clip "${target.clip}" filter ${target.service}.${target.property}`,
      produced: true,
      ref: target.clip,
    });
    return { value, scalar: value ? scalarOf(value) : null, live, path };
  }
  path.push({
    scope: "clip",
    label: `clip "${target.clip}" has no filter ${target.service}.${target.property}`,
    produced: false,
    ref: target.clip,
  });

  // (2) TRACK filters — not yet first-class IR. The chain is walked + named so a
  // future IR addition slots in here without changing the contract.
  path.push({
    scope: "track",
    label: `track "${loc.trackId}" carries no filters (not modeled yet)`,
    produced: false,
    ref: loc.trackId,
  });

  // (3) TRACTOR filters — likewise not yet first-class IR.
  path.push({
    scope: "tractor",
    label: "main tractor carries no filters (not modeled yet)",
    produced: false,
  });

  // (4) TRANSITION — a field transition covering this frame whose properties
  // include the requested service/property contributes. A clip-scoped target only
  // falls through to a transition when its track participates in one at this frame.
  const trIndex = transitionAt(state, frame, loc.trackIndex, loc.trackKind);
  if (trIndex >= 0) {
    const tr = state.transitions[trIndex] as Transition;
    if (target.property in tr.properties) {
      const value = propertyValueAt(
        tr.properties[target.property] as string | number,
        frame - tr.in,
        undefined,
      );
      path.push({
        scope: "transition",
        label: `transition #${trIndex} (${tr.service}).${target.property}`,
        produced: true,
        ref: String(trIndex),
      });
      return { value, scalar: value ? scalarOf(value) : null, live, path };
    }
  }

  // Nothing produced a value across the whole chain.
  return { value: null, scalar: null, live, path };
}

// ─── Transition scope ──────────────────────────────────────────────────────────
/** Resolve a field-transition property at a timeline frame. The transition
 *  contributes only while the frame is inside its `[in, out]` window; outside it,
 *  the value clamps to the nearest keyframe but `live` is false. */
function resolveTransition(
  state: Timeline,
  target: { scope: "transition"; index: number; property: string },
  frame: number,
): ResolveResult {
  const tr = state.transitions[target.index];
  if (!tr) {
    return {
      value: null,
      scalar: null,
      live: false,
      path: [],
      notFound: `transition #${target.index} not found`,
    };
  }
  const live = frame >= tr.in && frame <= tr.out;
  if (!(target.property in tr.properties)) {
    return {
      value: null,
      scalar: null,
      live,
      path: [
        {
          scope: "transition",
          label: `transition #${target.index} (${tr.service}) has no property ${target.property}`,
          produced: false,
          ref: String(target.index),
        },
      ],
      notFound: `transition #${target.index} has no property "${target.property}"`,
    };
  }
  // Transition keyframes are authored in TIMELINE space relative to its `in`.
  const localFrame = Math.max(0, Math.min(tr.out - tr.in, frame - tr.in));
  const value = propertyValueAt(
    tr.properties[target.property] as string | number,
    localFrame,
    undefined,
  );
  return {
    value,
    scalar: value ? scalarOf(value) : null,
    live,
    path: [
      {
        scope: "transition",
        label: `transition #${target.index} (${tr.service}).${target.property}`,
        produced: true,
        ref: String(target.index),
      },
    ],
  };
}

/** Index of a field transition covering `frame` whose A/B track includes the
 *  given track, or -1. Track indices in a Transition are the main-tractor integer
 *  indices (`[background, ...video, ...audio]`), so the track's index there is
 *  `1 + videoIndex` for a video track (background is 0) or
 *  `1 + videoCount + audioIndex` for an audio track. */
function transitionAt(
  state: Timeline,
  frame: number,
  trackIndex: number,
  trackKind: "video" | "audio",
): number {
  const videoCount = state.tracks.video.length;
  const tractorIndex = trackKind === "video" ? 1 + trackIndex : 1 + videoCount + trackIndex;
  for (let i = 0; i < state.transitions.length; i++) {
    const tr = state.transitions[i] as Transition;
    if (frame < tr.in || frame > tr.out) continue;
    if (tr.aTrack === tractorIndex || tr.bTrack === tractorIndex) return i;
  }
  return -1;
}
