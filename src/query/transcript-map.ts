// The transcript↔timeline MAP (T2 query). The read-side bridge between a
// frame-exact `Transcript` (stable word ids) and the timeline's frame space:
//
//   • resolveWordRange — a set of stable word ids → the MERGED, sorted timeline
//     frame spans they occupy. This is the function the word-cut op (T3) consumes
//     to turn "remove these words" into "remove these frame ranges" WITHOUT ever
//     touching an index. Adjacent/overlapping words coalesce into one span so the
//     op cuts the minimal number of ranges.
//
//   • postEditText — the transcript text AFTER a set of words is removed: the
//     remaining words, in order, re-joined. The "what will the caption read"
//     preview, computed purely from the model (no render).
//
// Why this lives in `src/query` (not the op): it is a PURE READ over the model,
// shared by the op, the captions action, and a future LSP hover ("what frame is
// this word?"). Indices never leak out — every result is keyed by stable id +
// frame, mirroring the rest of the query layer.
import { type Transcript, type TranscriptWord, transcriptWords, wordsById } from "../transcript";

/** An inclusive timeline frame span `[startFrame, endFrame]` (the unit the
 *  word-cut op removes). `playtime = endFrame - startFrame + 1`. */
export type FrameSpan = { startFrame: number; endFrame: number };

/** A resolved word range: the (merged) frame spans + the word ids that fed them.
 *  `missing` lists any requested id not in the transcript (the op turns that into
 *  a typed precondition rather than silently dropping it). */
export type WordRangeResolution = {
  /** The merged, ascending-by-start frame spans to cut. */
  spans: FrameSpan[];
  /** The requested word ids that resolved (in document order). */
  resolved: string[];
  /** Requested ids that don't exist in the transcript (caller decides severity). */
  missing: string[];
};

/** Total frames covered by a set of (non-overlapping) spans. */
export function spansPlaytime(spans: FrameSpan[]): number {
  return spans.reduce((acc, s) => acc + (s.endFrame - s.startFrame + 1), 0);
}

/** Resolve a set of stable word ids to the MERGED timeline frame spans they
 *  occupy. The whole point vs Palmier: the caller names WORDS (stable ids); the
 *  index-shift footgun is impossible because nothing here addresses a word by its
 *  ordinal position. Adjacent words (and any whose spans touch/overlap after
 *  sorting) coalesce so the op removes the fewest ranges. Order-independent: the
 *  same id set yields the same spans regardless of request order. */
export function resolveWordRange(transcript: Transcript, wordIds: string[]): WordRangeResolution {
  const byId = wordsById(transcript);
  const requested = new Set(wordIds);
  const missing = wordIds.filter((id) => !byId.has(id));

  // Collect the target words IN DOCUMENT ORDER (so `resolved` and the spans are
  // deterministic regardless of the caller's id ordering).
  const targets: TranscriptWord[] = transcriptWords(transcript).filter((w) => requested.has(w.id));
  const resolved = targets.map((w) => w.id);

  // Sort by start, then coalesce touching/overlapping/adjacent spans. Two spans
  // merge when the later one starts at or before (prev.end + 1) — i.e. they're
  // contiguous in frame space, so cutting them as one closed range is correct.
  const sorted = [...targets].sort((a, b) => a.startFrame - b.startFrame);
  const spans: FrameSpan[] = [];
  for (const w of sorted) {
    const last = spans[spans.length - 1];
    if (last && w.startFrame <= last.endFrame + 1) {
      last.endFrame = Math.max(last.endFrame, w.endFrame);
    } else {
      spans.push({ startFrame: w.startFrame, endFrame: w.endFrame });
    }
  }
  return { spans, resolved, missing };
}

/** The transcript text AFTER `removedIds` are removed: the remaining words, in
 *  document order, joined with single spaces (trimmed). A pure preview of the
 *  post-edit caption/transcript — no render, no op. */
export function postEditText(transcript: Transcript, removedIds: string[]): string {
  const removed = new Set(removedIds);
  return transcriptWords(transcript)
    .filter((w) => !removed.has(w.id))
    .map((w) => w.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");
}

/** The full transcript text (all words, document order, joined). The "before"
 *  side of a before/after view. */
export function transcriptText(transcript: Transcript): string {
  return postEditText(transcript, []);
}
