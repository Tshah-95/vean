// The TRANSCRIPT model — the project-space, frame-exact transcript that the
// word-level cut op (T3) and the caption track (T4) are written against.
//
// A transcription BACKEND (whisper.cpp, see `./transcribe`) yields the H3
// `TranscribeJobOutput` contract: ordered segments of words, each already
// resolved to INTEGER FRAMES in timeline space (the backend does the rational
// seconds→frames conversion before it writes the result — see `./map`). This
// module adds the one thing the raw job output lacks and the edit algebra
// REQUIRES: a STABLE IDENTITY per word.
//
// Why stable IDs are load-bearing (the whole point vs Palmier): the word-cut op
// addresses words by `id`, never by array index. Palmier's `remove_words` has a
// documented index-shift footgun — "indices shift after each cut" — because it
// addresses words ordinally, so removing word 3 renumbers words 4..N and a
// follow-up cut hits the wrong word. vean mints a stable id per word ONCE (at
// transcript-build time), and every downstream op resolves a word→frame-span by
// that id. Renumbering is impossible by construction; the bug class cannot exist.
//
// Frame-exact invariant (AGENTS.md): every time here is an INTEGER FRAME in the
// project's timeline space — NOT seconds, NOT a float. Floats live only inside
// the backend's seconds-space and are converted at the `./map` boundary.
import { z } from "zod";

/** A non-negative integer frame (mirrors `src/ir/types` `frame`). Transcript
 *  timings live in this space — never seconds/floats. */
const frame = z.number().int().nonnegative();

// ─── Word ──────────────────────────────────────────────────────────────────
/** One transcribed word with a STABLE identity and a frame-exact span.
 *  `[startFrame, endFrame]` is an INCLUSIVE integer-frame window in timeline
 *  space; `id` is the stable handle the word-cut op (T3) addresses — never the
 *  word's ordinal position. */
export const transcriptWordSchema = z.object({
  /** Stable, opaque identity. Minted once at build time; survives every cut. The
   *  op addresses words by THIS, never by index. */
  id: z.string().min(1),
  /** Inclusive 0-based timeline in-frame. */
  startFrame: frame,
  /** Inclusive 0-based timeline out-frame. playtime = endFrame - startFrame + 1. */
  endFrame: frame,
  /** The word text (verbatim from the backend, including leading/trailing space
   *  the backend emits — preserved so a re-joined segment reads naturally). */
  text: z.string(),
});
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;

// ─── Segment ─────────────────────────────────────────────────────────────────
/** A contiguous, caption-sized run of words: its own frame span, the joined
 *  text, and the per-word breakdown that powers word-level editing + captions. */
export const transcriptSegmentSchema = z.object({
  /** Stable identity for the segment (used to address a caption line). */
  id: z.string().min(1),
  /** Inclusive timeline in-frame of the segment (== its first word's start). */
  startFrame: frame,
  /** Inclusive timeline out-frame (== its last word's end). */
  endFrame: frame,
  /** The joined segment text (caption line). */
  text: z.string(),
  words: z.array(transcriptWordSchema),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

// ─── Transcript ──────────────────────────────────────────────────────────────
/** A whole frame-exact transcript: the ordered segments (each with words). The
 *  source of the word-level cut + caption surfaces. Carries the resolving fps so
 *  a reader can see what frame space the integer timings live in (never to
 *  re-derive a time — the frames are canonical). */
export const transcriptSchema = z.object({
  /** Rational fps `[num, den]` the seconds→frame conversion used (never a float). */
  fps: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  /** Optional path/id of the media this transcript describes (provenance). */
  mediaPath: z.string().optional(),
  segments: z.array(transcriptSegmentSchema),
});
export type Transcript = z.infer<typeof transcriptSchema>;

// ─── Flattening helper ─────────────────────────────────────────────────────
/** Every word across every segment, in document order — the flat stream the
 *  word-cut op resolves ranges over. */
export function transcriptWords(t: Transcript): TranscriptWord[] {
  return t.segments.flatMap((s) => s.words);
}

/** Index a transcript's words by their stable id (the lookup the word-cut op +
 *  the transcript↔timeline query share). */
export function wordsById(t: Transcript): Map<string, TranscriptWord> {
  const m = new Map<string, TranscriptWord>();
  for (const w of transcriptWords(t)) m.set(w.id, w);
  return m;
}
