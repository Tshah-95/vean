// fadeIn / fadeOut — set a clip's head/tail fade length (in frames). Both verbs
// share the sentinel-filter mechanics and register separately ("fadeIn"/"fadeOut").
//
// Shotcut semantics (`multitrackmodel.cpp::fadeIn`/`fadeOut`): add/update a
// brightness (video) / volume (audio) filter carrying the fade keyframes, tagged
// via `shotcut:filter` = fadeInBrightness/fadeOutBrightness/fadeInVolume/
// fadeOutVolume. In vean's IR (decision #1, DESIGN-MOVE1.md §4) a fade is the
// integer `vean.fadeIn`/`vean.fadeOut` SENTINEL filter carrying `{ frames }` — the
// serializer (`serialize.ts::resolveFades`) compiles it to that proven keyframe
// shape with the right `shotcut:filter` PROPERTY tag and 0-based window. So this
// op never touches a keyframe string: it just adds / replaces / removes the
// matching sentinel on the clip's filter list:
//   • frames > 0 → ensure ONE sentinel of that direction with `{ frames }`
//     (replace an existing one in place; otherwise append);
//   • frames = 0 → remove the sentinel of that direction (no fade).
//
// Guards (mirror the serializer's `resolveFades` length check, surfaced as a
// typed EditError so an op never throws): `frames` ≤ the clip's playtime, and the
// SUM of this fade and the opposite-direction fade already on the clip ≤ playtime
// (the two fades can't overlap). Either violation → a `precondition` EditError.
//
// Inverse: the SAME verb with `frames` = the PREVIOUS fade length on that clip
// (0 = none). A scalar inverse — undo restores the exact prior sentinel (or its
// absence). We capture the prior frames before mutating, so the inverse is fully
// specified and self-contained (no internal restore op, no registry addition).
import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "../ir/builder";
import type { Filter, Item, Timeline, Track } from "../ir/types";
import { cloneTimeline, findClip, playtime } from "./primitives";
import {
  type EditError,
  type FadeArgs,
  type Op,
  type OpResult,
  editError,
  noConsequences,
} from "./types";

// The fade sentinel `frames` (0 when no such sentinel is present).
function sentinelFrames(filters: Filter[], service: string): number {
  for (const f of filters) {
    if (f.service === service) {
      const v = f.properties.frames;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

// The shared body for both fade verbs — `service` selects the direction sentinel
// and `opName` is the registry name used in the (symmetric) scalar inverse.
function fadeOp(
  state: Timeline,
  args: FadeArgs,
  service: typeof FADE_IN_SERVICE | typeof FADE_OUT_SERVICE,
  opName: "fadeIn" | "fadeOut",
): OpResult | EditError {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const len = playtime(loc.clip);
  const opposite = service === FADE_IN_SERVICE ? FADE_OUT_SERVICE : FADE_IN_SERVICE;
  const prevFrames = sentinelFrames(loc.clip.filters, service);
  const otherFrames = sentinelFrames(loc.clip.filters, opposite);

  // Guard: a single fade can't exceed the clip, and the two fades can't overlap.
  if (args.frames > len) {
    return editError({
      kind: "precondition",
      detail: `${opName}: ${args.frames}f fade exceeds clip "${args.uuid}" playtime (${len}f)`,
    });
  }
  if (args.frames > 0 && args.frames + otherFrames > len) {
    return editError({
      kind: "precondition",
      detail:
        `${opName}: ${args.frames}f fade + ${otherFrames}f opposite fade ` +
        `exceeds clip "${args.uuid}" playtime (${len}f)`,
    });
  }

  const next = cloneTimeline(state);
  const items = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  const clip = items[loc.itemIndex] as Extract<Item, { kind: "clip" }>;

  // Rebuild the filter list in a CANONICAL order — [fadeIn?, fadeOut?, ...rest] —
  // exactly the order the builder emits. This is what makes the scalar inverse a
  // true deep-equal undo: add, remove, and replace all converge to the same
  // canonical layout, so undoing a removal (which re-adds the fade) lands the
  // sentinel back at its original index instead of at the end. The serializer's
  // `resolveFades` is order-independent for the fade pair, so canonicalizing is
  // free (no XML change). `rest` keeps the relative order of the non-fade filters.
  const wantIn =
    service === FADE_IN_SERVICE ? args.frames : sentinelFrames(clip.filters, FADE_IN_SERVICE);
  const wantOut =
    service === FADE_OUT_SERVICE ? args.frames : sentinelFrames(clip.filters, FADE_OUT_SERVICE);
  const rest = clip.filters.filter(
    (f) => f.service !== FADE_IN_SERVICE && f.service !== FADE_OUT_SERVICE,
  );
  const rebuilt: Filter[] = [];
  if (wantIn > 0) rebuilt.push({ service: FADE_IN_SERVICE, properties: { frames: wantIn } });
  if (wantOut > 0) rebuilt.push({ service: FADE_OUT_SERVICE, properties: { frames: wantOut } });
  clip.filters = [...rebuilt, ...rest];

  const c = noConsequences();
  if (args.frames !== prevFrames) {
    c.warnings.push({
      code: `${opName}-set`,
      detail:
        args.frames === 0
          ? `removed ${opName} (was ${prevFrames}f) on clip "${args.uuid}"`
          : `set ${opName} to ${args.frames}f (was ${prevFrames}f) on clip "${args.uuid}"`,
    });
  }
  // A fade changes no frame count on the timeline (it rides on the clip).
  c.durationDelta = 0;

  return {
    state: next,
    consequences: c,
    // Scalar inverse: the same verb with the PREVIOUS fade length (0 = none).
    inverse: { op: opName, args: { uuid: args.uuid, frames: prevFrames } },
  };
}

export const fadeIn: Op<FadeArgs> = (state, args): OpResult | EditError =>
  fadeOp(state, args, FADE_IN_SERVICE, "fadeIn");

export const fadeOut: Op<FadeArgs> = (state, args): OpResult | EditError =>
  fadeOp(state, args, FADE_OUT_SERVICE, "fadeOut");

export { fadeArgs } from "./types";

// ─── samples (registry-driven invariant harness) ──────────────────────────────
// Per the stub's contract: each verb exports its own sample array, including an
// ADD (frames>0 on a clip with no such fade) AND a REMOVE (frames=0 on a clip
// that has one) so the scalar inverse is exercised in both directions.
import { audioTrack, clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samplesFadeIn: OpSample<FadeArgs>[] = [
  {
    name: "add a fadeIn to a video clip that has none",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, { video: [videoTrack(colorClip(60, "gold", { id: "c" }))] });
    },
    args: { uuid: "c", frames: 12 },
  },
  {
    name: "remove an existing fadeIn (frames=0) — exercises the scalar inverse",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(60, "gold", { id: "c", fadeIn: 15 }))],
      });
    },
    args: { uuid: "c", frames: 0 },
  },
  {
    name: "shorten a fadeIn on a clip that already carries a fadeOut",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(90, "blue", { id: "c", fadeIn: 30, fadeOut: 20 }))],
      });
    },
    args: { uuid: "c", frames: 10 },
  },
];

export const samplesFadeOut: OpSample<FadeArgs>[] = [
  {
    name: "add a fadeOut to an audio clip that has none",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        audio: [audioTrack(clip("/abs/vo.wav", { id: "a", dur: 120 }))],
      });
    },
    args: { uuid: "a", frames: 24 },
  },
  {
    name: "remove an existing fadeOut (frames=0) — exercises the scalar inverse",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(45, "black", { id: "c", fadeOut: 12 }))],
      });
    },
    args: { uuid: "c", frames: 0 },
  },
];
