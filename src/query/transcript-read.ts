import type { Fps } from "../ir/types";
// The transcript READ query (DESIGN-UI Phase 3b) — the read-side bridge from a
// clip's SOURCE media path to the frame-exact `Transcript` a viewer waveform/peek
// lane draws, IF one exists.
//
// Where transcripts live: a completed `transcribe` job (see `src/state/job-types`)
// carries the source path in its `payload_json` (`TranscribeJobInput.path`) and the
// frame-resolved result in its `result_json` (`TranscribeJobOutput`). There is no
// separate on-disk transcript file today — the job row IS the transcript store. So
// "read the transcript for this source" = "find the newest DONE transcribe job for
// this path, decode its result, mint stable ids". Absent (never transcribed) ⇒ no
// transcript — this module returns `null`, never a fabricated one (the availability
// contract: peek renders nothing where whisper hasn't run).
//
// Split for testability: the PURE selection+decode (`transcriptFromJobs`) takes
// already-read job rows and needs no DB — it unit-tests in vitest. The DB-backed
// `readTranscriptForSource` opens `.vean/vean.db` (Bun-only) and feeds it.
import {
  TRANSCRIBE_JOB_KIND,
  decodeTranscribeInput,
  decodeTranscribeOutput,
} from "../state/job-types";
import { fromJobOutput } from "../transcript";
import type { Transcript } from "../transcript";

/** The minimal shape of a `jobs` row this query reads — decoupled from the Drizzle
 *  row type so the pure selector takes a plain object (and a test can hand-build
 *  rows without a DB). Mirrors the load-bearing columns of `src/state/schema` jobs. */
export type TranscriptJobRow = {
  kind: string;
  status: string;
  payloadJson: string;
  resultJson: string | null;
  /** ISO timestamps; used only to pick the NEWEST matching job. */
  finishedAt?: string | null;
  createdAt?: string | null;
};

/** Compare two job rows by recency (newest first): `finishedAt` then `createdAt`.
 *  A missing timestamp sorts oldest, so a completed job with a real `finishedAt`
 *  always wins over one without. */
function newerFirst(a: TranscriptJobRow, b: TranscriptJobRow): number {
  const at = a.finishedAt ?? a.createdAt ?? "";
  const bt = b.finishedAt ?? b.createdAt ?? "";
  return at < bt ? 1 : at > bt ? -1 : 0;
}

/** Select the newest DONE `transcribe` job whose payload path === `sourcePath` from
 *  a set of already-read job rows, decode its result, and build a stable-id
 *  `Transcript` at `fps`. Returns `null` when no such job exists (never transcribed)
 *  — the absent case, never a fabricated transcript. PURE (no DB / no I/O), so it
 *  unit-tests directly.
 *
 *  A malformed payload/result row is SKIPPED (not thrown) so one corrupt job never
 *  hides a good one; if every candidate is malformed the result is `null`. */
export function transcriptFromJobs(
  jobs: TranscriptJobRow[],
  sourcePath: string,
  fps: Fps,
): Transcript | null {
  const candidates = jobs
    .filter((j) => j.kind === TRANSCRIBE_JOB_KIND && j.status === "done" && j.resultJson != null)
    .filter((j) => {
      try {
        return decodeTranscribeInput(j.payloadJson).path === sourcePath;
      } catch {
        return false; // unparseable payload → not a match
      }
    })
    .sort(newerFirst);

  for (const job of candidates) {
    try {
      const output = decodeTranscribeOutput(job.resultJson as string);
      return fromJobOutput(output, fps, { mediaPath: sourcePath });
    } catch {
      // corrupt result → try the next-newest candidate
    }
  }
  return null;
}
