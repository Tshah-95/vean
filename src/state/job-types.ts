// Typed job contracts over the generic `jobs` table.
//
// The `jobs` table (see `./schema`) is intentionally generic: a `kind` string and
// two opaque JSON blobs (`payload_json` / `result_json`). That keeps the queue
// mechanics (enqueue / claim-lease / complete / fail in `./jobs`) untyped and
// reusable, but a CONSUMER of a specific job kind needs a stable, validated shape
// for what goes in and what comes back. This module is the typed seam: per-kind
// Zod schemas for the payload + result, the literal kind tag, and thin
// encode/decode helpers that round-trip through the generic table's JSON columns.
//
// The first contract is `transcribe` — the head of the media-intelligence track
// (T1→T2 in the roadmap). It is an INTERFACE ONLY: no backend (the whisper.cpp
// sidecar lands as a separate stream against this shape). Define the contract here
// so the transcript model, word-cut op, and caption track can all be built against
// a frozen input/output type while the producer is still being written.
//
// Frame-exact invariant (AGENTS.md): every time on the transcript is an INTEGER
// FRAME in timeline space — NOT seconds, NOT a float. A transcription backend
// resolves its seconds-based timings against the project fps to integer frames
// BEFORE writing the result, so the downstream word-cut / caption math stays
// rational and the whole transcript composes with the IR's frame model.
import { z } from "zod";

/** The job `kind` tag for a transcription job. The single source of truth for the
 *  string written to `jobs.kind` — consumers MUST compare against this constant,
 *  never a bare string literal. */
export const TRANSCRIBE_JOB_KIND = "transcribe" as const;
export type TranscribeJobKind = typeof TRANSCRIBE_JOB_KIND;

/** A non-negative integer frame (mirrors `src/ir/types` `frame` — the atom of time
 *  in the IR). Transcript timings live in this space, never seconds/floats. */
const frame = z.number().int().nonnegative();

// ─── Input ───────────────────────────────────────────────────────────────────
/** What a transcription job is asked to do: transcribe the media at `path`. The
 *  optional `mediaId` ties the job back to a `media_assets` row (so a result can be
 *  cached against the catalog), and `lang` is a BCP-47 / ISO-639 hint passed to the
 *  backend (omit to auto-detect). `path` is required and load-bearing — the backend
 *  reads exactly this file. */
export const transcribeJobInputSchema = z.object({
  /** Optional `media_assets.id` this job transcribes — links the result to the catalog. */
  mediaId: z.string().min(1).optional(),
  /** Absolute path to the media file to transcribe. Required. */
  path: z.string().min(1),
  /** Optional language hint (e.g. `en`, `es`); omit to let the backend auto-detect. */
  lang: z.string().min(1).optional(),
});
export type TranscribeJobInput = z.infer<typeof transcribeJobInputSchema>;

// ─── Output ──────────────────────────────────────────────────────────────────
/** A single transcribed word with its frame-exact span. `[startFrame, endFrame]`
 *  is an INCLUSIVE integer-frame window in timeline space — the unit the word-cut
 *  op (T3) addresses by STABLE word identity, never by index. */
export const transcribeWordSchema = z.object({
  startFrame: frame,
  endFrame: frame,
  text: z.string(),
});
export type TranscribeWord = z.infer<typeof transcribeWordSchema>;

/** A contiguous transcript segment (a caption-sized run): its own frame span, the
 *  joined text, and the per-word breakdown that powers word-level editing. */
export const transcribeSegmentSchema = z.object({
  startFrame: frame,
  endFrame: frame,
  text: z.string(),
  words: z.array(transcribeWordSchema),
});
export type TranscribeSegment = z.infer<typeof transcribeSegmentSchema>;

/** The result of a transcription job: the ordered segments (each with words). The
 *  consumer (transcript model / caption track) reads this; the backend writes it. */
export const transcribeJobOutputSchema = z.object({
  segments: z.array(transcribeSegmentSchema),
});
export type TranscribeJobOutput = z.infer<typeof transcribeJobOutputSchema>;

// ─── Encode / decode against the generic jobs table ────────────────────────────
/** Serialize a validated transcription input into the `jobs.payload_json` string.
 *  Validates first, so a malformed input fails loudly here — never as an opaque
 *  blob a worker chokes on later. */
export function encodeTranscribeInput(input: TranscribeJobInput): string {
  return JSON.stringify(transcribeJobInputSchema.parse(input));
}

/** Parse + validate a `jobs.payload_json` string back into a typed input. Throws
 *  (does not silently coerce) when the stored payload doesn't match the contract. */
export function decodeTranscribeInput(payloadJson: string): TranscribeJobInput {
  return transcribeJobInputSchema.parse(JSON.parse(payloadJson));
}

/** Serialize a validated transcription result into the `jobs.result_json` string. */
export function encodeTranscribeOutput(output: TranscribeJobOutput): string {
  return JSON.stringify(transcribeJobOutputSchema.parse(output));
}

/** Parse + validate a `jobs.result_json` string back into a typed result. Throws
 *  when the stored result doesn't match the contract. */
export function decodeTranscribeOutput(resultJson: string): TranscribeJobOutput {
  return transcribeJobOutputSchema.parse(JSON.parse(resultJson));
}

/** Build the `NewJob` shape (`./jobs` `enqueueJob` input) for a transcription job —
 *  the one place that pairs the kind tag with an encoded, validated payload, so a
 *  caller can't enqueue a `transcribe` job with a mistyped kind or unvalidated
 *  payload. */
export function transcribeJob(
  input: TranscribeJobInput,
  opts: { priority?: number; maxAttempts?: number } = {},
): { kind: TranscribeJobKind; payloadJson: string; priority?: number; maxAttempts?: number } {
  return {
    kind: TRANSCRIBE_JOB_KIND,
    payloadJson: encodeTranscribeInput(input),
    priority: opts.priority,
    maxAttempts: opts.maxAttempts,
  };
}
