// The seconds↔frame boundary for transcripts — the one place a backend's
// floating-point seconds become INTEGER project frames, and the only module that
// touches a float time. Two directions:
//
//   • secondsToFrame / framesToSeconds — the rational conversion, rounding
//     correctly at the project fps (29.97 = [30000,1001], never 29.97). A word at
//     1.234 s on a 30000/1001 timeline lands at round(1.234 * 30000/1001) = 37.
//
//   • buildTranscript — assemble a frame-exact `Transcript` (stable per-word ids)
//     from a backend's RAW seconds-based segments. This is what the whisper.cpp
//     sidecar's parsed output feeds. Each word's seconds span is converted to an
//     inclusive integer-frame window; a stable id is minted per word/segment.
//
//   • fromJobOutput — assemble a `Transcript` from the H3 `TranscribeJobOutput`
//     (already frame-resolved per the contract), minting the stable ids the raw
//     job output lacks. This is the seam the action layer reads: a job result in
//     the DB → a model the ops/captions consume.
//
// Rounding policy (load-bearing): startFrame = round(start·fps), endFrame =
// round(end·fps) − 1 so the INCLUSIVE end frame doesn't bleed into the next
// word's start (a word spanning [1.0s, 1.5s) at 30fps occupies frames 30..44,
// not 30..45 — frame 45 is the next word's first frame). A degenerate word whose
// rounded end precedes its start is clamped to a single frame so every word has
// playtime ≥ 1.
import type { Fps } from "../ir/types";
import type { TranscribeJobOutput } from "../state/job-types";
import {
  type Transcript,
  type TranscriptSegment,
  type TranscriptWord,
  transcriptSchema,
} from "./types";

/** Exact rational fps as a ratio (num/den) — frame⇄second math, never a float fps. */
function fpsRatio(fps: Fps): number {
  return fps[0] / fps[1];
}

/** The integer timeline frame a START time (seconds) maps to: round(s · fps).
 *  Rounding (not floor) so a word starting a hair before a frame boundary snaps
 *  to the nearer frame rather than always the earlier one. */
export function secondsToStartFrame(seconds: number, fps: Fps): number {
  return Math.max(0, Math.round(seconds * fpsRatio(fps)));
}

/** The INCLUSIVE integer timeline frame an END time (seconds) maps to. The end
 *  time is the boundary AFTER the last played frame (whisper reports a word's
 *  end as the next word's start-ish), so the inclusive last frame is
 *  round(s · fps) − 1. Clamped to ≥ `startFrame` so a word is never empty. */
export function secondsToEndFrame(endSeconds: number, fps: Fps, startFrame: number): number {
  const exclusive = Math.round(endSeconds * fpsRatio(fps));
  return Math.max(startFrame, exclusive - 1);
}

/** Whole frames ⇄ seconds at the project's rational fps (the inverse, for display
 *  / round-trip checks — the IR never stores this; frames are canonical). */
export function framesToSeconds(frames: number, fps: Fps): number {
  return (frames * fps[1]) / fps[0];
}

// ─── Raw (seconds-based) backend output → Transcript ──────────────────────────
/** A backend word in SECONDS (what a whisper.cpp parse yields before frame
 *  resolution). `start`/`end` are floating-point seconds from media start. */
export type RawWord = { start: number; end: number; text: string };
/** A backend segment in SECONDS. */
export type RawSegment = { start: number; end: number; text: string; words: RawWord[] };

/** Mint a deterministic stable id for the `k`-th word/segment. Backed by a caller
 *  id factory so a test can inject a counter; defaults to an ordinal-derived
 *  opaque token (deterministic per build, which is what the golden test needs). */
export type IdMint = (kind: "seg" | "word", ordinal: number) => string;

const defaultMint: IdMint = (kind, ordinal) => `${kind}-${ordinal}`;

/** Build a frame-exact `Transcript` from RAW seconds-based backend segments,
 *  converting every time to an inclusive integer-frame window at `fps` and
 *  minting a stable id per segment + word. The result is validated against the
 *  schema so a malformed backend output fails loudly here, not downstream. */
export function buildTranscript(
  raw: RawSegment[],
  fps: Fps,
  opts: { mediaPath?: string; mint?: IdMint } = {},
): Transcript {
  const mint = opts.mint ?? defaultMint;
  let segOrdinal = 0;
  let wordOrdinal = 0;
  const segments: TranscriptSegment[] = raw.map((rs) => {
    const words: TranscriptWord[] = rs.words.map((rw) => {
      const startFrame = secondsToStartFrame(rw.start, fps);
      const endFrame = secondsToEndFrame(rw.end, fps, startFrame);
      return { id: mint("word", wordOrdinal++), startFrame, endFrame, text: rw.text };
    });
    const segStart = secondsToStartFrame(rs.start, fps);
    const segEnd = secondsToEndFrame(rs.end, fps, segStart);
    return {
      id: mint("seg", segOrdinal++),
      // A segment spans its words when present; fall back to the segment's own
      // seconds when a backend gives a wordless segment.
      startFrame: words.length > 0 ? (words[0] as TranscriptWord).startFrame : segStart,
      endFrame: words.length > 0 ? (words[words.length - 1] as TranscriptWord).endFrame : segEnd,
      text: rs.text,
      words,
    };
  });
  return transcriptSchema.parse({ fps, mediaPath: opts.mediaPath, segments });
}

// ─── H3 job output (frame-based) → Transcript ─────────────────────────────────
/** Build a `Transcript` from the H3 `TranscribeJobOutput` (already frame-resolved
 *  per the job contract). The job output lacks the STABLE IDS the edit algebra
 *  needs, so this mints them. Use this when reading a completed job result; use
 *  `buildTranscript` when converting a raw seconds-based backend parse. */
export function fromJobOutput(
  output: TranscribeJobOutput,
  fps: Fps,
  opts: { mediaPath?: string; mint?: IdMint } = {},
): Transcript {
  const mint = opts.mint ?? defaultMint;
  let segOrdinal = 0;
  let wordOrdinal = 0;
  const segments: TranscriptSegment[] = output.segments.map((s) => ({
    id: mint("seg", segOrdinal++),
    startFrame: s.startFrame,
    endFrame: s.endFrame,
    text: s.text,
    words: s.words.map((w) => ({
      id: mint("word", wordOrdinal++),
      startFrame: w.startFrame,
      endFrame: w.endFrame,
      text: w.text,
    })),
  }));
  return transcriptSchema.parse({ fps, mediaPath: opts.mediaPath, segments });
}
