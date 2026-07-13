// High-level compositing actions for footage-led scenes. These are deliberately
// clip-addressed: callers name a stable producer UUID, while this layer resolves
// the ephemeral main-tractor indices needed by MLT qtblend transitions.
import { clip as buildClip, transition as buildTransition, uuid } from "../ir/builder";
import type { Timeline, Transition } from "../ir/types";
import { apply } from "../ops";
import { findClip, playtime } from "../ops/primitives";
import type { Consequences, EditError, OpInvocation } from "../ops/types";
import { isEditError, noConsequences } from "../ops/types";

export type CanvasSlot = {
  /** Coordinates are normalized canvas fractions by default, or profile pixels. */
  unit?: "normalized" | "pixels";
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
};

export type TransformEasing = "linear" | "smooth" | "smooth-tight" | "hold";

export type AnimateTransformArgs = {
  /** Stable clip UUID. Track indices are resolved from this at apply time. */
  clipId: string;
  startFrame: number;
  endFrame: number;
  from: CanvasSlot;
  to: CanvasSlot;
  easing?: TransformEasing;
  /** Optional explicit lower layer. Defaults to the nearest lower video track,
   * or the implicit background for video[0]. */
  underlayClipId?: string;
  /** Stretch fills the requested rectangle. Contain preserves source aspect. */
  fit?: "contain" | "stretch";
  /** When known (from ffprobe), contain can resolve the exact aspect-fit rect. */
  sourceDimensions?: { width: number; height: number };
};

export type AnimateTransformResult = {
  state: Timeline;
  consequences: Consequences;
  inverse: OpInvocation[];
  clipId: string;
  transitionIndex: number;
  aTrack: number;
  bTrack: number;
  rect: string;
  reusedTransition: boolean;
};

export type ApplySubjectAlphaArgs = {
  /** Existing alpha-capable video resource. Alpha-plane validation happens in
   * the registry action before this pure helper is called. */
  cutoutResource: string;
  /** Stable clip UUID of the footage or baked graphic beneath the cutout. */
  targetClipId: string;
  position: number;
  durationFrames: number;
  inFrame?: number;
  label?: string;
  /** Deterministic build pipelines may pin the cutout identity. */
  cutoutClipId?: string;
  /** Defaults to `${cutoutClipId}-track` when the clip id is explicit. */
  cutoutTrackId?: string;
};

export type ApplySubjectAlphaResult = {
  state: Timeline;
  consequences: Consequences;
  inverse: OpInvocation[];
  cutoutClipId: string;
  cutoutTrackId: string;
  aTrack: number;
  bTrack: number;
};

function mergeConsequences(into: Consequences, add: Consequences): void {
  into.clipsAdded.push(...add.clipsAdded);
  into.clipsRemoved.push(...add.clipsRemoved);
  into.clipsMoved.push(...add.clipsMoved);
  into.clipsTrimmed.push(...add.clipsTrimmed);
  into.blanksCreated.push(...add.blanksCreated);
  into.blanksRemoved.push(...add.blanksRemoved);
  into.ripple.push(...add.ripple);
  into.durationDelta += add.durationDelta;
  into.warnings.push(...add.warnings);
}

function mainTrack(videoIndex: number): number {
  return videoIndex + 1;
}

function validateRange(
  label: string,
  position: number,
  duration: number,
  startFrame: number,
  endFrame: number,
): EditError | null {
  const clipEnd = position + duration - 1;
  if (startFrame < position || endFrame > clipEnd) {
    return {
      kind: "frame-out-of-range",
      frame: startFrame < position ? startFrame : endFrame,
      bound: clipEnd + 1,
      detail: `${label}: range [${startFrame}, ${endFrame}] must stay inside clip span [${position}, ${clipEnd}]`,
    };
  }
  return null;
}

function pixels(slot: CanvasSlot, width: number, height: number): Required<CanvasSlot> {
  const unit = slot.unit ?? "normalized";
  return {
    unit: "pixels",
    x: unit === "normalized" ? slot.x * width : slot.x,
    y: unit === "normalized" ? slot.y * height : slot.y,
    width: unit === "normalized" ? slot.width * width : slot.width,
    height: unit === "normalized" ? slot.height * height : slot.height,
    opacity: slot.opacity ?? 1,
  };
}

/** Preserve a known source aspect inside a requested slot. qtblend's
 * `distort=0` does this at render time; resolving it here makes the browser
 * preview and the serialized geometry explicit and identical. */
function contain(slot: Required<CanvasSlot>, sourceWidth: number, sourceHeight: number) {
  const sourceAspect = sourceWidth / sourceHeight;
  const slotAspect = slot.width / slot.height;
  if (Math.abs(sourceAspect - slotAspect) < 1e-9) return slot;
  if (sourceAspect > slotAspect) {
    const height = slot.width / sourceAspect;
    return { ...slot, y: slot.y + (slot.height - height) / 2, height };
  }
  const width = slot.height * sourceAspect;
  return { ...slot, x: slot.x + (slot.width - width) / 2, width };
}

const number = (value: number): string => {
  const rounded = +value.toFixed(4);
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

function rectValue(slot: Required<CanvasSlot>): string {
  return [slot.x, slot.y, slot.width, slot.height, slot.opacity].map(number).join(" ");
}

function easingMarker(easing: TransformEasing): string {
  if (easing === "smooth") return "~";
  if (easing === "smooth-tight") return "-";
  if (easing === "hold") return "|";
  return "";
}

/** Animate an existing clip from one arbitrary canvas slot to another. If the
 * clip already owns a qtblend composite (for example a subject-alpha cutout),
 * its transition is updated in place; otherwise a scoped qtblend is added. */
export function animateTransform(
  state: Timeline,
  args: AnimateTransformArgs,
): AnimateTransformResult | EditError {
  const loc = findClip(state, args.clipId);
  if (!loc) return { kind: "clip-not-found", uuid: args.clipId };
  if (loc.trackKind !== "video") {
    return { kind: "precondition", detail: `animateTransform: clip "${args.clipId}" is not video` };
  }
  if (args.endFrame <= args.startFrame) {
    return {
      kind: "invalid-args",
      detail: `animateTransform: endFrame (${args.endFrame}) must be greater than startFrame (${args.startFrame})`,
    };
  }
  const rangeError = validateRange(
    "animateTransform",
    loc.position,
    playtime(loc.clip),
    args.startFrame,
    args.endFrame,
  );
  if (rangeError) return rangeError;

  let aTrack: number;
  const bTrack = mainTrack(loc.trackIndex);
  if (args.underlayClipId) {
    const under = findClip(state, args.underlayClipId);
    if (!under) return { kind: "clip-not-found", uuid: args.underlayClipId };
    if (under.trackKind !== "video" || under.trackIndex >= loc.trackIndex) {
      return {
        kind: "precondition",
        detail: `animateTransform: underlay clip "${args.underlayClipId}" must be on a lower video track than "${args.clipId}"`,
      };
    }
    aTrack = mainTrack(under.trackIndex);
  } else {
    aTrack = loc.trackIndex === 0 ? 0 : mainTrack(loc.trackIndex - 1);
  }

  let from = pixels(args.from, state.profile.width, state.profile.height);
  let to = pixels(args.to, state.profile.width, state.profile.height);
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) {
    return { kind: "invalid-args", detail: "animateTransform: slot width/height must be > 0" };
  }
  if (
    args.fit !== "stretch" &&
    args.sourceDimensions &&
    args.sourceDimensions.width > 0 &&
    args.sourceDimensions.height > 0
  ) {
    from = contain(from, args.sourceDimensions.width, args.sourceDimensions.height);
    to = contain(to, args.sourceDimensions.width, args.sourceDimensions.height);
  }
  const marker = easingMarker(args.easing ?? "smooth");
  const rect = `${args.startFrame}${marker}=${rectValue(from)};${args.endFrame}=${rectValue(to)}`;

  // Prefer the existing compositor topology for this clip. This is the common
  // subject-alpha case: applySubjectAlpha establishes qtblend, then this action
  // gives that same stable cutout its motion without stacking duplicate blends.
  let existingIndex = -1;
  for (let index = state.transitions.length - 1; index >= 0; index--) {
    const transition = state.transitions[index];
    if (
      transition?.service === "qtblend" &&
      transition.bTrack === bTrack &&
      transition.in <= args.startFrame &&
      transition.out >= args.endFrame
    ) {
      existingIndex = index;
      break;
    }
  }
  const baseTransition =
    existingIndex >= 0
      ? (state.transitions[existingIndex] as Transition)
      : buildTransition(
          "qtblend",
          aTrack,
          bTrack,
          loc.position,
          loc.position + playtime(loc.clip) - 1,
          {},
        );
  // Reusing an established qtblend must preserve its compositing root. In a
  // three-layer stack, the transition may intentionally use track 1 as the
  // cumulative A side while the animated cutout is on track 3. Recomputing A
  // as the immediately lower track would silently drop the already-composited
  // camera layer and render transparent regions over black. An explicit
  // underlayClipId is the only request that is allowed to rewire that topology.
  if (existingIndex >= 0 && !args.underlayClipId) {
    aTrack = baseTransition.aTrack;
  }
  const nextTransition: Transition = {
    ...structuredClone(baseTransition),
    aTrack,
    bTrack,
    properties: {
      ...baseTransition.properties,
      rect,
      distort: args.fit === "stretch" ? 1 : 0,
      compositing: 0,
    },
  };
  const invocation: OpInvocation =
    existingIndex >= 0
      ? { op: "_replaceTransition", args: { index: existingIndex, transition: nextTransition } }
      : { op: "pushTransition", args: { transition: nextTransition } };
  const result = apply(invocation, state);
  if (isEditError(result)) return result;
  return {
    state: result.state,
    consequences: result.consequences,
    inverse: [result.inverse],
    clipId: args.clipId,
    transitionIndex: existingIndex >= 0 ? existingIndex : state.transitions.length,
    aTrack,
    bTrack,
    rect,
    reusedTransition: existingIndex >= 0,
  };
}

/** Place an existing alpha-capable subject cutout over footage or a baked
 * graphic. This action owns topology only; segmentation/matting remains an
 * upstream media-generation concern. */
export function applySubjectAlpha(
  state: Timeline,
  args: ApplySubjectAlphaArgs,
): ApplySubjectAlphaResult | EditError {
  const target = findClip(state, args.targetClipId);
  if (!target) return { kind: "clip-not-found", uuid: args.targetClipId };
  if (target.trackKind !== "video") {
    return {
      kind: "precondition",
      detail: `applySubjectAlpha: target clip "${args.targetClipId}" is not video`,
    };
  }
  if (target.clip.composition) {
    return {
      kind: "precondition",
      detail:
        "applySubjectAlpha: a live Remotion composition cannot sit below WebGL footage in the current browser stack; bake the graphic first, then target its baked clip",
    };
  }
  if (args.durationFrames <= 0) {
    return {
      kind: "invalid-args",
      detail: `applySubjectAlpha: durationFrames must be > 0 (got ${args.durationFrames})`,
    };
  }
  const rangeError = validateRange(
    "applySubjectAlpha",
    target.position,
    playtime(target.clip),
    args.position,
    args.position + args.durationFrames - 1,
  );
  if (rangeError) return rangeError;

  let work = state;
  const consequences = noConsequences();
  const inverseStack: OpInvocation[] = [];
  const step = (invocation: OpInvocation): EditError | null => {
    const result = apply(invocation, work);
    if (isEditError(result)) return result;
    work = result.state;
    mergeConsequences(consequences, result.consequences);
    inverseStack.push(result.inverse);
    return null;
  };

  const cutoutClipId = args.cutoutClipId ?? uuid();
  if (findClip(state, cutoutClipId)) {
    return {
      kind: "precondition",
      detail: `applySubjectAlpha: cutout clip id "${cutoutClipId}" already exists`,
    };
  }
  const trackId = args.cutoutTrackId ?? (args.cutoutClipId ? `${args.cutoutClipId}-track` : uuid());
  if (
    state.tracks.video.some((track) => track.id === trackId) ||
    state.tracks.audio.some((track) => track.id === trackId)
  ) {
    return {
      kind: "precondition",
      detail: `applySubjectAlpha: cutout track id "${trackId}" already exists`,
    };
  }
  let error = step({
    op: "addTrack",
    args: { kind: "video", id: trackId, name: "SUBJECT ALPHA", position: "bottom" },
  });
  if (error) return error;
  const inFrame = args.inFrame ?? 0;
  const cutout = buildClip(args.cutoutResource, {
    id: cutoutClipId,
    in: inFrame,
    out: inFrame + args.durationFrames - 1,
    length: inFrame + args.durationFrames,
    label: args.label ?? `subject-alpha:${args.cutoutResource}`,
  });
  error = step({
    op: "overwrite",
    args: { track: { trackId }, clip: cutout, position: args.position },
  });
  if (error) return error;

  const cutoutIndex = work.tracks.video.findIndex((track) => track.id === trackId);
  if (cutoutIndex < 0) {
    return { kind: "precondition", detail: "applySubjectAlpha: cutout track add did not register" };
  }
  const aTrack = mainTrack(target.trackIndex);
  const bTrack = mainTrack(cutoutIndex);
  error = step({
    op: "pushTransition",
    args: {
      transition: buildTransition(
        "qtblend",
        aTrack,
        bTrack,
        args.position,
        args.position + args.durationFrames - 1,
        { compositing: 0, distort: 0 },
      ),
    },
  });
  if (error) return error;

  return {
    state: work,
    consequences,
    inverse: [...inverseStack].reverse(),
    cutoutClipId,
    cutoutTrackId: trackId,
    aTrack,
    bTrack,
  };
}
