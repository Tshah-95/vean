// transcript-map — the GOLDEN for the seconds↔frame boundary, the stable-id
// transcript model, the H3 job round-trip, and the transcript↔timeline query.
//
// What this pins (the load-bearing properties of stream S2 / roadmap T2):
//   • rational seconds→frame conversion (29.97 = [30000,1001], never a float) —
//     a deterministic golden frame table;
//   • stable per-word ids minted at build time (the index-shift-immunity the
//     word-cut op depends on);
//   • the H3 job contract round-trips (Transcript → TranscribeJobOutput →
//     Transcript) frame-for-frame;
//   • resolveWordRange merges contiguous word spans + addresses by id only;
//   • the whisper.cpp backend's FIXTURE path yields a transcript with NO binary
//     and NO network (the determinism the whole pipeline is tested on).
import { describe, expect, it } from "vitest";
import type { Fps } from "../src/ir/types";
import {
  postEditText,
  resolveWordRange,
  spansPlaytime,
  transcriptText,
} from "../src/query/transcript-map";
import {
  BUILTIN_FIXTURE_RAW,
  type RawSegment,
  buildTranscript,
  fromJobOutput,
  secondsToEndFrame,
  secondsToStartFrame,
  toJobOutput,
  transcribeWhisper,
  transcriptWords,
  whisperConfigured,
  whisperJsonToRaw,
} from "../src/transcript";

const FPS_30: Fps = [30, 1];
const FPS_2997: Fps = [30000, 1001];

// A deterministic raw (seconds-based) transcript, the input to buildTranscript.
const RAW: RawSegment[] = [
  {
    start: 0.0,
    end: 1.0,
    text: "hello world",
    words: [
      { start: 0.0, end: 0.5, text: "hello" },
      { start: 0.5, end: 1.0, text: "world" },
    ],
  },
  {
    start: 1.0,
    end: 2.0,
    text: "goodbye now",
    words: [
      { start: 1.0, end: 1.5, text: "goodbye" },
      { start: 1.5, end: 2.0, text: "now" },
    ],
  },
];

describe("secondsToFrame (rational, golden)", () => {
  it("maps START seconds to round(s·fps) at integer 30fps", () => {
    expect(secondsToStartFrame(0.0, FPS_30)).toBe(0);
    expect(secondsToStartFrame(0.5, FPS_30)).toBe(15);
    expect(secondsToStartFrame(1.0, FPS_30)).toBe(30);
    expect(secondsToStartFrame(1.5, FPS_30)).toBe(45);
  });

  it("maps END seconds to an INCLUSIVE frame (round(s·fps) − 1), clamped ≥ start", () => {
    // [0.5s, 1.0s) at 30fps occupies frames 15..29 (frame 30 is the next word).
    expect(secondsToEndFrame(1.0, FPS_30, 15)).toBe(29);
    // Degenerate: end rounds before start → clamp to a single frame.
    expect(secondsToEndFrame(0.5, FPS_30, 15)).toBe(15);
  });

  it("uses the RATIONAL fps (29.97 = [30000,1001], never the float 29.97)", () => {
    // round(1.234 · 30000/1001) = round(36.97…) = 37.
    expect(secondsToStartFrame(1.234, FPS_2997)).toBe(37);
    // A whole second at 29.97 is round(29.97…) = 30 (not 29).
    expect(secondsToStartFrame(1.0, FPS_2997)).toBe(30);
  });
});

describe("buildTranscript (stable ids + frame-exact)", () => {
  const t = buildTranscript(RAW, FPS_30, { mediaPath: "/abs/take.mp4" });

  it("converts every word to an inclusive integer-frame window (golden)", () => {
    const words = transcriptWords(t);
    expect(words.map((w) => [w.startFrame, w.endFrame])).toEqual([
      [0, 14], // hello   [0.0, 0.5)
      [15, 29], // world  [0.5, 1.0)
      [30, 44], // goodbye[1.0, 1.5)
      [45, 59], // now    [1.5, 2.0)
    ]);
  });

  it("mints a STABLE, UNIQUE id per word (the index-shift-immunity the op needs)", () => {
    const ids = transcriptWords(t).map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Deterministic across two builds (golden ids).
    const t2 = buildTranscript(RAW, FPS_30);
    expect(transcriptWords(t2).map((w) => w.id)).toEqual(ids);
  });

  it("a segment spans its first..last word frame", () => {
    expect(t.segments.map((s) => [s.startFrame, s.endFrame])).toEqual([
      [0, 29],
      [30, 59],
    ]);
  });

  it("carries the rational fps + media path", () => {
    expect(t.fps).toEqual(FPS_30);
    expect(t.mediaPath).toBe("/abs/take.mp4");
  });
});

describe("H3 job contract round-trip (Transcript ⇄ TranscribeJobOutput)", () => {
  it("Transcript → job output → Transcript is frame-for-frame stable", () => {
    const t = buildTranscript(RAW, FPS_30);
    const job = toJobOutput(t);
    const back = fromJobOutput(job, FPS_30);
    // Frames + text survive; ids are re-minted deterministically, so they match too.
    expect(transcriptWords(back).map((w) => [w.startFrame, w.endFrame, w.text])).toEqual(
      transcriptWords(t).map((w) => [w.startFrame, w.endFrame, w.text]),
    );
    expect(back.segments.map((s) => s.text)).toEqual(t.segments.map((s) => s.text));
  });
});

describe("resolveWordRange (address by stable id, merge contiguous spans)", () => {
  const t = buildTranscript(RAW, FPS_30);
  const words = transcriptWords(t);

  it("resolves a single word id to its frame span", () => {
    const w = words[2] as { id: string }; // "goodbye" → [30,44]
    const r = resolveWordRange(t, [w.id]);
    expect(r.spans).toEqual([{ startFrame: 30, endFrame: 44 }]);
    expect(r.missing).toEqual([]);
  });

  it("MERGES contiguous/adjacent words into one span (fewest cut ranges)", () => {
    // "goodbye"[30,44] + "now"[45,59] are adjacent (45 == 44+1) → one [30,59] span.
    const ids = [words[2]?.id as string, words[3]?.id as string];
    const r = resolveWordRange(t, ids);
    expect(r.spans).toEqual([{ startFrame: 30, endFrame: 59 }]);
    expect(spansPlaytime(r.spans)).toBe(30);
  });

  it("keeps DISJOINT words as separate spans, ascending, order-independent", () => {
    // "hello"[0,14] + "now"[45,59] are not contiguous → two spans, sorted.
    const ids = [words[3]?.id as string, words[0]?.id as string]; // reversed order
    const r = resolveWordRange(t, ids);
    expect(r.spans).toEqual([
      { startFrame: 0, endFrame: 14 },
      { startFrame: 45, endFrame: 59 },
    ]);
  });

  it("reports unknown ids as `missing` (the op turns that into a precondition)", () => {
    const r = resolveWordRange(t, ["does-not-exist"]);
    expect(r.spans).toEqual([]);
    expect(r.missing).toEqual(["does-not-exist"]);
  });
});

describe("postEditText (the after-cut transcript preview)", () => {
  const t = buildTranscript(RAW, FPS_30);
  const words = transcriptWords(t);

  it("full text joins every word", () => {
    expect(transcriptText(t)).toBe("hello world goodbye now");
  });

  it("removing words drops exactly those from the text", () => {
    const removed = [words[1]?.id as string, words[2]?.id as string]; // world, goodbye
    expect(postEditText(t, removed)).toBe("hello now");
  });
});

describe("whisper.cpp backend — FIXTURE path (no binary, no network)", () => {
  it("is unconfigured by default (so transcription is fixture-backed in tests)", () => {
    // No VEAN_WHISPER in the test env → fixture path.
    expect(whisperConfigured({})).toBe(false);
    expect(whisperConfigured({ VEAN_WHISPER: "/x/whisper-cli" })).toBe(true);
    // An explicit fixture override forces the fixture path even with a binary set.
    expect(
      whisperConfigured({ VEAN_WHISPER: "/x/whisper-cli", VEAN_WHISPER_FIXTURE: "/f.json" }),
    ).toBe(false);
  });

  it("transcribeWhisper yields a frame-exact job output from the built-in fixture", async () => {
    const out = await transcribeWhisper({ path: "/abs/take.mp4" }, FPS_30, {});
    // The built-in fixture is "the quick brown fox / jumps over the lazy dog".
    expect(out.segments.length).toBe(2);
    const allWords = out.segments.flatMap((s) => s.words);
    expect(allWords.map((w) => w.text)).toEqual([
      "the",
      "quick",
      "brown",
      "fox",
      "jumps",
      "over",
      "the",
      "lazy",
      "dog",
    ]);
    // Frames are integers in timeline space (no floats leaked through).
    for (const w of allWords) {
      expect(Number.isInteger(w.startFrame)).toBe(true);
      expect(Number.isInteger(w.endFrame)).toBe(true);
      expect(w.endFrame).toBeGreaterThanOrEqual(w.startFrame);
    }
    // "the" [0.0,0.5) at 30fps → [0,14]; "fox" [1.5,2.0) → [45,59].
    expect([allWords[0]?.startFrame, allWords[0]?.endFrame]).toEqual([0, 14]);
    expect([allWords[3]?.startFrame, allWords[3]?.endFrame]).toEqual([45, 59]);
  });

  it("the built-in fixture is deterministic (golden)", () => {
    const t = buildTranscript(BUILTIN_FIXTURE_RAW, FPS_30);
    expect(transcriptText(t)).toBe("the quick brown fox jumps over the lazy dog");
  });
});

describe("whisper `-ojf` JSON → raw segments (the real-binary parse seam)", () => {
  it("converts ms offsets to seconds and drops special tokens", () => {
    const json = {
      transcription: [
        {
          text: " hi there",
          offsets: { from: 0, to: 1000 },
          tokens: [
            { text: "[_BEG_]", offsets: { from: 0, to: 0 } }, // special → dropped
            { text: " hi", offsets: { from: 0, to: 500 } },
            { text: " there", offsets: { from: 500, to: 1000 } },
          ],
        },
      ],
    };
    const raw = whisperJsonToRaw(json);
    expect(raw.length).toBe(1);
    expect(raw[0]?.words.map((w) => [w.start, w.end, w.text.trim()])).toEqual([
      [0, 0.5, "hi"],
      [0.5, 1, "there"],
    ]);
  });
});
