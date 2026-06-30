// Convenience builders behind the `timeline.new` and `timeline.addAudio`
// actions. Both author IR through `src/ir/builder.ts` + the pure op algebra and
// serialize through the existing `toMlt`, so determinism (same IR → byte-
// identical XML) is preserved and no new serializer branch is introduced.
import {
  audioTrack,
  clip as buildClip,
  timeline as buildTimeline,
  uuid,
  videoTrack,
} from "../ir/builder";
import { PROFILES, type ProfileName } from "../ir/profile";
import type { Timeline } from "../ir/types";
import { apply } from "../ops";
import { dbToGain } from "../ops/types";
import type { Consequences, EditError, OpInvocation } from "../ops/types";
import { isEditError } from "../ops/types";

export type NewTimelineArgs = {
  profile: ProfileName;
  title: string;
  videoTracks: number;
  audioTracks: number;
};

/** Build a blank timeline IR from a profile preset with N empty video tracks and
 *  M empty audio tracks. Empty tracks serialize fine (the serializer handles
 *  `items: []`). */
export function newTimeline(args: NewTimelineArgs): Timeline {
  const profile = PROFILES[args.profile];
  const video = Array.from({ length: args.videoTracks }, () => videoTrack());
  const audio = Array.from({ length: args.audioTracks }, () => audioTrack());
  return buildTimeline(profile, { video, audio }, { title: args.title });
}

export type AddFootageArgs = {
  resource: string;
  durationFrames: number;
  inFrame: number;
  /** Target video track id; when omitted, the first video track (or a fresh one). */
  trackId?: string;
  label?: string;
  createTrackIfMissing: boolean;
};

export type AddFootageResult = {
  state: Timeline;
  consequences: Consequences;
  inverse: OpInvocation[];
  trackId: string;
  createdTrack: boolean;
};

/**
 * Append a footage (video) clip — e.g. a phone capture — to a video track,
 * optionally creating the track. The label defaults to "footage" and is forced
 * away from any `graphic`-prefixed value, so the preview proxy keeps it as
 * footage rather than stripping it as a Remotion overlay (see proxy.ts
 * `isGraphicClip`). Wraps the existing `addTrack` + `append` ops, so the result
 * carries proper consequences + an ordered inverse sequence (UNDO order). Pure:
 * never mutates `state`. Returns an EditError on a typed precondition.
 */
export function addFootage(state: Timeline, args: AddFootageArgs): AddFootageResult | EditError {
  const aggregate = emptyConsequences();
  const inverseStack: OpInvocation[] = [];
  let work = state;
  let createdTrack = false;

  // Resolve the target video track (footage lands on the FIRST/bottom video
  // track by default; graphics live above it).
  let trackId: string | undefined = args.trackId;
  if (trackId) {
    const exists = work.tracks.video.some((t) => t.id === trackId);
    if (!exists) return { kind: "track-not-found", track: trackId };
  } else if (work.tracks.video.length > 0) {
    trackId = (work.tracks.video[0] as { id: string }).id;
  } else {
    if (!args.createTrackIfMissing) {
      return {
        kind: "precondition",
        detail: "addFootage: no video track and createTrackIfMissing is false",
      };
    }
    const addInv: OpInvocation = { op: "addTrack", args: { kind: "video", name: "V1" } };
    const added = apply(addInv, work);
    if (isEditError(added)) return added;
    work = added.state;
    mergeConsequences(aggregate, added.consequences);
    inverseStack.push(added.inverse);
    createdTrack = true;
    trackId = (work.tracks.video[work.tracks.video.length - 1] as { id: string }).id;
  }

  // A `graphic`-prefixed label would make the proxy treat this as a stripped
  // overlay — footage must never be labelled that way.
  const label = args.label && !/^graphic\b/i.test(args.label) ? args.label : "footage";
  const footageClip = buildClip(args.resource, {
    id: uuid(),
    in: args.inFrame,
    dur: args.durationFrames,
    label,
  });
  const appendInv: OpInvocation = {
    op: "append",
    args: { track: { trackId }, clip: footageClip },
  };
  const appended = apply(appendInv, work);
  if (isEditError(appended)) return appended;
  work = appended.state;
  mergeConsequences(aggregate, appended.consequences);
  inverseStack.push(appended.inverse);

  return {
    state: work,
    consequences: aggregate,
    inverse: [...inverseStack].reverse(),
    trackId,
    createdTrack,
  };
}

export type AddAudioArgs = {
  resource: string;
  durationFrames: number;
  inFrame: number;
  /** Target audio track id; when omitted, the first audio track (or a fresh one). */
  trackId?: string;
  gainDb?: number;
  fadeIn?: number;
  fadeOut?: number;
  createTrackIfMissing: boolean;
};

export type AddAudioResult = {
  state: Timeline;
  consequences: Consequences;
  inverse: OpInvocation[];
  trackId: string;
  createdTrack: boolean;
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

/**
 * Append an audio clip to an audio track, optionally creating the track and
 * applying gain/fades. Wraps the existing `addTrack` + `append` ops, so the
 * result carries proper consequences + an ordered inverse sequence (UNDO order).
 * Pure: never mutates `state`. Returns an EditError on a typed precondition (no
 * audio track and `createTrackIfMissing` false, or an explicit unknown track).
 */
export function addAudio(state: Timeline, args: AddAudioArgs): AddAudioResult | EditError {
  const aggregate = emptyConsequences();
  const inverseStack: OpInvocation[] = [];
  let work = state;
  let createdTrack = false;

  // Resolve the target audio track.
  let trackId: string | undefined = args.trackId;
  if (trackId) {
    const exists = work.tracks.audio.some((t) => t.id === trackId);
    if (!exists) return { kind: "track-not-found", track: trackId };
  } else if (work.tracks.audio.length > 0) {
    trackId = (work.tracks.audio[0] as { id: string }).id;
  } else {
    if (!args.createTrackIfMissing) {
      return {
        kind: "precondition",
        detail: "addAudio: no audio track and createTrackIfMissing is false",
      };
    }
    const addInv: OpInvocation = { op: "addTrack", args: { kind: "audio", name: "A1" } };
    const added = apply(addInv, work);
    if (isEditError(added)) return added;
    work = added.state;
    mergeConsequences(aggregate, added.consequences);
    inverseStack.push(added.inverse);
    createdTrack = true;
    trackId = (work.tracks.audio[work.tracks.audio.length - 1] as { id: string }).id;
  }

  // Build the audio clip with optional gain (dB → multiplier) and fades. Mint a
  // runtime-unique uuid (NOT the deterministic authoring counter, which resets to
  // clip-0 at the start of every one-shot CLI process — two add-audio calls would
  // then collide on `clip-0`, making the returned inverse `{op:_dropAppended,
  // uuid:clip-0}` match two clips). Identity = stable producer uuids (AGENTS.md).
  const audioClip = buildClip(args.resource, {
    id: uuid(),
    in: args.inFrame,
    dur: args.durationFrames,
    label: "audio",
    ...(args.gainDb != null ? { gain: dbToGain(args.gainDb) } : {}),
    ...(args.fadeIn ? { fadeIn: args.fadeIn } : {}),
    ...(args.fadeOut ? { fadeOut: args.fadeOut } : {}),
  });
  const appendInv: OpInvocation = {
    op: "append",
    args: { track: { trackId }, clip: audioClip },
  };
  const appended = apply(appendInv, work);
  if (isEditError(appended)) return appended;
  work = appended.state;
  mergeConsequences(aggregate, appended.consequences);
  inverseStack.push(appended.inverse);

  return {
    state: work,
    consequences: aggregate,
    inverse: [...inverseStack].reverse(),
    trackId,
    createdTrack,
  };
}
