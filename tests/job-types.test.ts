// The typed `transcribe` job contract (interface only — no backend). These pin the
// shape the transcript model / word-cut op / caption track build against: a
// validated input/output, frame-exact INTEGER timings (never seconds/floats), and
// lossless encode↔decode through the generic `jobs` table's JSON columns.
import { describe, expect, it } from "vitest";
import {
  TRANSCRIBE_JOB_KIND,
  decodeTranscribeInput,
  decodeTranscribeOutput,
  encodeTranscribeInput,
  encodeTranscribeOutput,
  transcribeJob,
  transcribeJobInputSchema,
  transcribeJobOutputSchema,
} from "../src/state/job-types";

const SAMPLE_OUTPUT = {
  segments: [
    {
      startFrame: 0,
      endFrame: 89,
      text: "hello there world",
      words: [
        { startFrame: 0, endFrame: 29, text: "hello" },
        { startFrame: 30, endFrame: 59, text: "there" },
        { startFrame: 60, endFrame: 89, text: "world" },
      ],
    },
  ],
};

describe("transcribe job input", () => {
  it("accepts the minimal (path-only) input and round-trips through the payload string", () => {
    const input = { path: "/abs/clip.wav" };
    const decoded = decodeTranscribeInput(encodeTranscribeInput(input));
    expect(decoded).toEqual(input);
  });

  it("carries the optional mediaId + lang hints losslessly", () => {
    const input = { mediaId: "asset-1", path: "/abs/clip.wav", lang: "en" };
    expect(decodeTranscribeInput(encodeTranscribeInput(input))).toEqual(input);
  });

  it("rejects an input with no path (the load-bearing field)", () => {
    expect(transcribeJobInputSchema.safeParse({ lang: "en" }).success).toBe(false);
  });
});

describe("transcribe job output", () => {
  it("round-trips the full segments+words shape through the result string", () => {
    expect(decodeTranscribeOutput(encodeTranscribeOutput(SAMPLE_OUTPUT))).toEqual(SAMPLE_OUTPUT);
  });

  it("enforces frame-exact INTEGER timings (no float seconds leak in)", () => {
    const floaty = {
      segments: [
        {
          startFrame: 0.5,
          endFrame: 30,
          text: "x",
          words: [{ startFrame: 0.5, endFrame: 30, text: "x" }],
        },
      ],
    };
    expect(transcribeJobOutputSchema.safeParse(floaty).success).toBe(false);
  });

  it("rejects a negative frame", () => {
    const negative = {
      segments: [
        {
          startFrame: -1,
          endFrame: 30,
          text: "x",
          words: [{ startFrame: -1, endFrame: 30, text: "x" }],
        },
      ],
    };
    expect(transcribeJobOutputSchema.safeParse(negative).success).toBe(false);
  });

  it("accepts an empty transcript (no speech detected)", () => {
    expect(transcribeJobOutputSchema.safeParse({ segments: [] }).success).toBe(true);
  });
});

describe("transcribeJob (NewJob builder)", () => {
  it("pairs the kind tag with a validated, encoded payload", () => {
    const job = transcribeJob({ path: "/abs/clip.wav", lang: "en" }, { priority: 5 });
    expect(job.kind).toBe(TRANSCRIBE_JOB_KIND);
    expect(job.kind).toBe("transcribe");
    expect(job.priority).toBe(5);
    expect(decodeTranscribeInput(job.payloadJson)).toEqual({ path: "/abs/clip.wav", lang: "en" });
  });

  it("throws when asked to build a job from an invalid input (fails loudly, not as an opaque blob)", () => {
    expect(() => transcribeJob({ path: "" })).toThrow();
  });
});
