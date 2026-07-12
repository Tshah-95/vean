import {
  type Gesture,
  type Tool,
  buildInvocation,
  gestureDxBounds,
  snapFrame,
} from "./timelineGestures";
import type { OpInvocation, PlacedItem, Timeline, Track } from "./types";
import { placeItems } from "./types";

export type EditTarget = "body" | "head" | "tail";

export interface SelectableClip {
  id: string;
  track: Track;
  trackIndex: number;
  kindIndex: number;
  placed: PlacedItem;
}

export function selectableClips(timeline: Timeline): SelectableClip[] {
  const ordered = [...timeline.tracks.video, ...timeline.tracks.audio];
  const out: SelectableClip[] = [];
  for (let trackIndex = 0; trackIndex < ordered.length; trackIndex++) {
    const track = ordered[trackIndex];
    if (!track) continue;
    const kindTracks = track.kind === "video" ? timeline.tracks.video : timeline.tracks.audio;
    const kindIndex = kindTracks.findIndex((candidate) => candidate.id === track.id);
    for (const placed of placeItems(track)) {
      if (placed.item.kind === "clip") {
        out.push({ id: placed.item.id, track, trackIndex, kindIndex, placed });
      }
    }
  }
  return out;
}

export function findClip(timeline: Timeline, id: string): SelectableClip | null {
  return selectableClips(timeline).find((clip) => clip.id === id) ?? null;
}

function nearestByCenter(
  candidates: SelectableClip[],
  source: SelectableClip,
): SelectableClip | null {
  const center = source.placed.start + source.placed.length / 2;
  let best: SelectableClip | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const candidateCenter = candidate.placed.start + candidate.placed.length / 2;
    const distance = Math.abs(candidateCenter - center);
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        candidate.placed.start < (best?.placed.start ?? Number.POSITIVE_INFINITY))
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function browseDestination(
  timeline: Timeline,
  selectedId: string,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End",
  wholeTimeline: boolean,
): SelectableClip | null {
  const clips = selectableClips(timeline);
  const current = clips.find((clip) => clip.id === selectedId);
  if (!current) return clips[0] ?? null;
  if (wholeTimeline && (key === "Home" || key === "End")) {
    return key === "Home" ? (clips[0] ?? null) : (clips.at(-1) ?? null);
  }
  const sameTrack = clips.filter((clip) => clip.track.id === current.track.id);
  const localIndex = sameTrack.findIndex((clip) => clip.id === current.id);
  if (key === "ArrowLeft") return sameTrack[Math.max(0, localIndex - 1)] ?? current;
  if (key === "ArrowRight")
    return sameTrack[Math.min(sameTrack.length - 1, localIndex + 1)] ?? current;
  if (key === "Home") return sameTrack[0] ?? current;
  if (key === "End") return sameTrack.at(-1) ?? current;

  const kindTracks = current.track.kind === "video" ? timeline.tracks.video : timeline.tracks.audio;
  const delta = key === "ArrowUp" ? -1 : 1;
  const adjacent = kindTracks[current.kindIndex + delta];
  if (!adjacent) return current;
  return nearestByCenter(
    clips.filter((clip) => clip.track.id === adjacent.id),
    current,
  );
}

export function trackLabel(track: Track, timeline: Timeline): string {
  const tracks = track.kind === "video" ? timeline.tracks.video : timeline.tracks.audio;
  const index = tracks.findIndex((candidate) => candidate.id === track.id) + 1;
  return `${track.kind === "video" ? "Video" : "Audio"} track ${track.name ?? `${track.kind === "video" ? "V" : "A"}${index}`}`;
}

export function clipAccessibleName(
  clip: SelectableClip,
  timeline: Timeline,
  diagnosticCount: number,
): string {
  if (clip.placed.item.kind !== "clip") return "";
  const item = clip.placed.item;
  const resource = item.resource.replace(/\\/g, "/").split("/").at(-1) ?? item.resource;
  const label = item.composition?.id ?? item.label ?? resource;
  const end = clip.placed.start + clip.placed.length - 1;
  return `${label}, ${trackLabel(clip.track, timeline)}, timeline frames ${clip.placed.start} to ${end}, duration ${clip.placed.length} frames, source ${item.in} to ${item.out}, ${diagnosticCount} blocking diagnostics`;
}

function neighbours(clip: SelectableClip): { left: PlacedItem | null; right: PlacedItem | null } {
  const placed = placeItems(clip.track);
  const index = placed.findIndex(
    (candidate) => candidate.item.kind === "clip" && candidate.item.id === clip.id,
  );
  const previous = placed[index - 1];
  const next = placed[index + 1];
  return {
    left: previous?.item.kind === "clip" ? previous : null,
    right: next?.item.kind === "clip" ? next : null,
  };
}

export interface KeyboardInvocationResult {
  invocation: OpInvocation | null;
  appliedDx: number;
  snappedTo: number | null;
  tool: Tool;
  limitation?: string;
}

export function keyboardInvocation(options: {
  timeline: Timeline;
  clipId: string;
  target: EditTarget;
  dx: number;
  alt: boolean;
  meta: boolean;
  snapEnabled: boolean;
  pxPerFrame: number;
  snapCandidates: number[];
}): KeyboardInvocationResult | null {
  const clip = findClip(options.timeline, options.clipId);
  if (!clip || clip.placed.item.kind !== "clip") return null;
  const adjacent = neighbours(clip);
  let tool: Tool;
  if (options.target === "body") tool = options.alt ? "slip" : options.meta ? "slide" : "move";
  else if (options.meta) tool = "roll";
  else tool = options.target === "head" ? "trimIn" : "trimOut";

  const rollLeft = options.target === "head" ? adjacent.left : clip.placed;
  const rollRight = options.target === "head" ? clip.placed : adjacent.right;
  if (tool === "roll" && (!rollLeft || !rollRight)) {
    return {
      invocation: null,
      appliedDx: 0,
      snappedTo: null,
      tool,
      limitation: `Roll unavailable: the ${options.target} has no flush clip neighbor`,
    };
  }

  const placedTrack = placeItems(clip.track);
  const index = placedTrack.findIndex(
    (candidate) => candidate.item.kind === "clip" && candidate.item.id === clip.id,
  );
  const previous = placedTrack[index - 1];
  const next = placedTrack[index + 1];
  let extendRoom: number | undefined;
  if (tool === "trimIn") extendRoom = previous?.item.kind === "blank" ? previous.length : 0;
  if (tool === "trimOut") {
    extendRoom =
      next == null ? Number.POSITIVE_INFINITY : next.item.kind === "blank" ? next.length : 0;
  }
  const gesture: Gesture = {
    tool,
    uuid: clip.id,
    trackId: clip.track.id,
    placed: clip.placed,
    neighbours: { left: rollLeft, right: rollRight },
    ripple: options.alt && (tool === "trimIn" || tool === "trimOut" || tool === "move"),
    extendRoom,
  };

  let appliedDx = options.dx;
  let snappedTo: number | null = null;
  if (options.snapEnabled && tool !== "slip") {
    const edges =
      tool === "move"
        ? [clip.placed.start + options.dx, clip.placed.start + clip.placed.length + options.dx]
        : tool === "trimOut"
          ? [clip.placed.start + clip.placed.length + options.dx]
          : tool === "roll"
            ? [(rollRight?.start ?? clip.placed.start) + options.dx]
            : [clip.placed.start + options.dx];
    let bestAdjustment = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const edge of edges) {
      const snapped = snapFrame(edge, options.snapCandidates, options.pxPerFrame);
      const distance = Math.abs(snapped.frame - edge);
      if (snapped.snappedTo != null && distance < bestDistance) {
        bestAdjustment = snapped.frame - edge;
        bestDistance = distance;
        snappedTo = snapped.snappedTo;
      }
    }
    appliedDx += bestAdjustment;
  }
  const bounds = gestureDxBounds(gesture);
  const bounded = Math.max(bounds.min, Math.min(bounds.max, appliedDx));
  if (bounded !== appliedDx) snappedTo = null;
  appliedDx = bounded;
  return {
    invocation: buildInvocation(gesture, appliedDx, gesture.ripple, clip.track.id),
    appliedDx,
    snappedTo,
    tool,
    limitation:
      appliedDx === 0 ? "Edit reached its media, adjacency, or minimum-length boundary" : undefined,
  };
}

export function adjacentTrackMove(
  timeline: Timeline,
  clipId: string,
  direction: "up" | "down",
): OpInvocation | null {
  const clip = findClip(timeline, clipId);
  if (!clip) return null;
  const tracks = clip.track.kind === "video" ? timeline.tracks.video : timeline.tracks.audio;
  const target = tracks[clip.kindIndex + (direction === "up" ? -1 : 1)];
  if (!target) return null;
  return {
    op: "move",
    args: {
      uuid: clip.id,
      toTrack: { trackId: target.id },
      toPosition: clip.placed.start,
      ripple: false,
      rippleAllTracks: false,
    },
  };
}
