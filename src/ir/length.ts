// The CANONICAL frame-length math for a track / timeline — the single source of
// truth for "how many frames long is this?". Both the serializer (the background
// producer + Shotcut length hints) and the preview proxy (the render frame bound
// + the viewer clock's totalFrames) MUST agree, so the rule lives here once.
//
// The subtlety is the DISSOLVE: a `{ kind: "dissolve", frames: d }` item does NOT
// add `d` frames on top of its neighbours — it OVERLAPS them. `d` frames of the
// preceding clip's tail and `d` frames of the following clip's head are consumed
// into the nested dissolve tractor (see serialize.ts `walkTrack`), so the played
// timeline is `prev_solo + d + next_solo`, NOT `prev + d + next`. A naive
// sum-of-item-lengths overcounts every dissolve by `2d − d = d` frames, which
// would make the proxy render bound and the viewer playhead run past the real EOF.
import type { Clip, Item, Timeline, Track } from "./types";

/** The played frame length of one clip item (inclusive in/out → out − in + 1). */
function clipPlay(clip: Clip): number {
  return clip.out - clip.in + 1;
}

/**
 * The played frame length of a single track, accounting for dissolve overlap
 * exactly as the serializer's `walkTrack` does:
 *   • blank → `length`
 *   • dissolve → `frames` (the overlap window itself)
 *   • clip → `out − in + 1`, MINUS the frames trimmed into an adjacent dissolve
 *     (a preceding dissolve trims the head, a following dissolve trims the tail);
 *     a clip wholly consumed by its dissolve(s) contributes 0.
 */
export function trackLength(track: Track): number {
  const items: Item[] = track.items;
  let length = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    if (it.kind === "blank") {
      length += it.length;
      continue;
    }
    if (it.kind === "dissolve") {
      length += it.frames;
      continue;
    }
    // A clip — trim head/tail for adjacent dissolves (those frames moved into the
    // nested dissolve tractor and are counted there, not here).
    const before = items[i - 1];
    const after = items[i + 1];
    const trimHead = before?.kind === "dissolve" ? before.frames : 0;
    const trimTail = after?.kind === "dissolve" ? after.frames : 0;
    const solo = clipPlay(it) - trimHead - trimTail;
    if (solo > 0) length += solo;
  }
  return length;
}

/** The total played frame length of a timeline = its longest track. Mirrors the
 *  serializer's `maxLength` (and the background producer's window) byte-for-byte:
 *  same per-track rule, same `max` over all video + audio tracks. */
export function timelineLength(timeline: Timeline): number {
  let max = 0;
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    const len = trackLength(track);
    if (len > max) max = len;
  }
  return max;
}
