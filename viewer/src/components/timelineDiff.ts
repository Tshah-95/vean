// A SHALLOW structural diff between two timeline IRs, for the session/worktree
// compare panel. This is the cheap, byte-free version of the "git for video" idea
// (DESIGN-WORKTREE §5): real op-level diff/merge is a deferred research problem, so
// here we summarize the visible structural deltas — track counts, clip counts, the
// total frame span, and per-clip in/out changes keyed by stable clip id (the
// identity invariant: a clip is the same clip across variants iff its uuid matches).
//
// It runs entirely client-side over the `/api/timeline` JSON of two routes, so it
// needs no new server endpoint or registry action. It is deliberately a SUMMARY,
// not a merge: it answers "how do these two cuts differ?" at a glance, which is the
// session-compare panel's job.
import { type Item, type Timeline, placeItems } from "../types";

/** One clip flattened to the fields a structural diff compares. */
interface FlatClip {
  id: string;
  resource: string;
  in: number;
  out: number;
  /** Timeline-frame start (placement), so a moved-but-untrimmed clip still shows. */
  start: number;
  /** The 1-based video/audio track index it sits on. */
  track: string;
}

/** One per-clip difference between the two timelines. */
export interface ClipDelta {
  id: string;
  /** "added" → only in B; "removed" → only in A; "changed" → in both, differs. */
  kind: "added" | "removed" | "changed";
  /** Human-readable summary of what changed (for a "changed" delta). */
  detail: string;
}

/** The whole structural diff summary. */
export interface TimelineDiff {
  /** Frame-span delta (B total − A total). */
  durationDelta: number;
  /** Clip-count delta (B − A). */
  clipDelta: number;
  /** Per-clip changes, keyed by stable id; empty when the two are identical. */
  clips: ClipDelta[];
  /** True when no structural difference was found. */
  identical: boolean;
}

/** Total timeline frames = the longest track's placed length. */
function spanFrames(tl: Timeline): number {
  let max = 0;
  for (const track of [...tl.tracks.video, ...tl.tracks.audio]) {
    const placed = placeItems(track);
    const end = placed.length > 0 ? placed[placed.length - 1].start + placed[placed.length - 1].length : 0;
    if (end > max) max = end;
  }
  return max;
}

/** Flatten every CLIP (skipping blanks/dissolves) to its compared fields. */
function flatten(tl: Timeline): Map<string, FlatClip> {
  const out = new Map<string, FlatClip>();
  const walk = (tracks: Timeline["tracks"]["video"], lane: "V" | "A") => {
    tracks.forEach((track, i) => {
      for (const placed of placeItems(track)) {
        const item = placed.item as Item;
        if (item.kind !== "clip") continue;
        out.set(item.id, {
          id: item.id,
          resource: item.resource,
          in: item.in,
          out: item.out,
          start: placed.start,
          track: `${lane}${i + 1}`,
        });
      }
    });
  };
  walk(tl.tracks.video, "V");
  walk(tl.tracks.audio, "A");
  return out;
}

/** Compare timeline A (baseline) against B (variant). */
export function diffTimelines(a: Timeline, b: Timeline): TimelineDiff {
  const fa = flatten(a);
  const fb = flatten(b);
  const clips: ClipDelta[] = [];

  for (const [id, ca] of fa) {
    const cb = fb.get(id);
    if (!cb) {
      clips.push({ id, kind: "removed", detail: `${ca.track} ${ca.resource.split("/").pop() ?? ca.resource}` });
      continue;
    }
    const parts: string[] = [];
    if (ca.in !== cb.in || ca.out !== cb.out) {
      parts.push(`in/out ${ca.in}–${ca.out} → ${cb.in}–${cb.out}`);
    }
    if (ca.start !== cb.start) parts.push(`start ${ca.start} → ${cb.start}`);
    if (ca.track !== cb.track) parts.push(`track ${ca.track} → ${cb.track}`);
    if (ca.resource !== cb.resource) parts.push("source changed");
    if (parts.length > 0) clips.push({ id, kind: "changed", detail: parts.join(", ") });
  }
  for (const [id, cb] of fb) {
    if (!fa.has(id)) {
      clips.push({ id, kind: "added", detail: `${cb.track} ${cb.resource.split("/").pop() ?? cb.resource}` });
    }
  }

  return {
    durationDelta: spanFrames(b) - spanFrames(a),
    clipDelta: fb.size - fa.size,
    clips,
    identical: clips.length === 0 && spanFrames(a) === spanFrames(b),
  };
}
