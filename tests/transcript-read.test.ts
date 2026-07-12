// Pure unit tests for the transcript READ selection (DESIGN-UI Phase 3b).
// `transcriptFromJobs` maps a source path → the newest DONE `transcribe` job's
// result → a stable-id `Transcript`, or null when never transcribed. No DB here —
// the DB-backed reader is smoke-tested by the preview-serve probe.
import { describe, expect, it } from "vitest";
import type { Fps } from "../src/ir/types";
import type { TranscriptJobRow } from "../src/query/transcript-read";
import { transcriptFromJobs } from "../src/query/transcript-read";
import { encodeTranscribeInput, encodeTranscribeOutput } from "../src/state/job-types";

const FPS: Fps = [30, 1];
const SRC = "/media/interview.mov";

/** A DONE transcribe job row for `path` with `n` one-frame words. */
function doneJob(path: string, words: string[], finishedAt: string): TranscriptJobRow {
  return {
    kind: "transcribe",
    status: "done",
    payloadJson: encodeTranscribeInput({ path }),
    resultJson: encodeTranscribeOutput({
      segments: [
        {
          startFrame: 0,
          endFrame: words.length - 1,
          text: words.join(" "),
          words: words.map((text, i) => ({ startFrame: i, endFrame: i, text })),
        },
      ],
    }),
    finishedAt,
    createdAt: finishedAt,
  };
}

describe("transcriptFromJobs", () => {
  it("returns null when no transcribe job matches the source (never transcribed)", () => {
    const jobs = [doneJob("/media/other.mov", ["a", "b"], "2026-01-01T00:00:00Z")];
    expect(transcriptFromJobs(jobs, SRC, FPS)).toBeNull();
  });

  it("returns null for an empty job set (the absent case, never faked)", () => {
    expect(transcriptFromJobs([], SRC, FPS)).toBeNull();
  });

  it("builds a stable-id transcript from a matching DONE job", () => {
    const jobs = [doneJob(SRC, ["hello", "world"], "2026-01-01T00:00:00Z")];
    const t = transcriptFromJobs(jobs, SRC, FPS);
    expect(t).not.toBeNull();
    expect(t?.fps).toEqual(FPS);
    expect(t?.mediaPath).toBe(SRC);
    const words = t?.segments.flatMap((s) => s.words) ?? [];
    expect(words.map((w) => w.text)).toEqual(["hello", "world"]);
    // Stable ids are minted (the load-bearing property vs index addressing).
    expect(words.every((w) => typeof w.id === "string" && w.id.length > 0)).toBe(true);
  });

  it("picks the NEWEST matching job when several exist for one source", () => {
    const jobs = [
      doneJob(SRC, ["old"], "2026-01-01T00:00:00Z"),
      doneJob(SRC, ["new", "take"], "2026-06-01T00:00:00Z"),
      doneJob(SRC, ["middle"], "2026-03-01T00:00:00Z"),
    ];
    const t = transcriptFromJobs(jobs, SRC, FPS);
    expect(t?.segments.flatMap((s) => s.words).map((w) => w.text)).toEqual(["new", "take"]);
  });

  it("ignores non-DONE jobs and jobs of a different kind", () => {
    const queued: TranscriptJobRow = {
      ...doneJob(SRC, ["queued"], "2026-09-01T00:00:00Z"),
      status: "queued",
    };
    const otherKind: TranscriptJobRow = {
      ...doneJob(SRC, ["nope"], "2026-09-02T00:00:00Z"),
      kind: "render",
    };
    const good = doneJob(SRC, ["done"], "2026-01-01T00:00:00Z");
    const t = transcriptFromJobs([queued, otherKind, good], SRC, FPS);
    expect(t?.segments.flatMap((s) => s.words).map((w) => w.text)).toEqual(["done"]);
  });

  it("skips a corrupt result and falls back to the next-newest good job", () => {
    const corrupt: TranscriptJobRow = {
      kind: "transcribe",
      status: "done",
      payloadJson: encodeTranscribeInput({ path: SRC }),
      resultJson: "{ not valid json",
      finishedAt: "2026-09-01T00:00:00Z",
      createdAt: "2026-09-01T00:00:00Z",
    };
    const good = doneJob(SRC, ["fallback"], "2026-01-01T00:00:00Z");
    const t = transcriptFromJobs([corrupt, good], SRC, FPS);
    expect(t?.segments.flatMap((s) => s.words).map((w) => w.text)).toEqual(["fallback"]);
  });

  it("skips a job with an unparseable payload (not a match)", () => {
    const badPayload: TranscriptJobRow = {
      kind: "transcribe",
      status: "done",
      payloadJson: "{ broken",
      resultJson: encodeTranscribeOutput({ segments: [] }),
      finishedAt: "2026-09-01T00:00:00Z",
      createdAt: "2026-09-01T00:00:00Z",
    };
    expect(transcriptFromJobs([badPayload], SRC, FPS)).toBeNull();
  });
});
